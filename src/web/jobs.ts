import { rm } from "node:fs/promises";
import { basename } from "node:path";
import type { Replay } from "../api.ts";
import {
  renderReplays,
  type Clip,
  type RenderProgress,
  type RenderRequest,
  type RenderResult,
} from "../render.ts";

/** Files are deleted 2h after the job finishes. */
export const TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Ceiling on how long a job may run. Without this, a job that hangs (a
 * stuck ffmpeg, or any hang the network timeouts don't cover) stays
 * `running` for the rest of the process's life: `sweep` skips jobs without
 * `finishedAt`, so nothing else ever reaches it — the directory is never
 * freed, listeners never cleaned up, SSE polling forever. Generous enough
 * for the common worst case (several files, each retrying 3x with a network
 * timeout), but finite.
 */
export const RUNNING_CEILING_MS = 60 * 60 * 1000;

const RENDER_DEFAULTS = {
  fps: 30,
  crf: 20,
  preset: "veryfast",
  concurrency: 4,
} as const;

export type JobStatus = "running" | "done" | "error";

export interface JobInput {
  field: string;
  fieldLabel: string;
  date: string;
  hour: string;
  replays: Replay[];
  swap: boolean;
  concat: boolean;
}

export interface ClipState {
  index: number;
  /** Time of day only, e.g. "20:34:25". */
  time: string;
  cameras: 1 | 2;
  url: string;
}

export interface JobState {
  id: string;
  status: JobStatus;
  field: string;
  fieldLabel: string;
  date: string;
  hour: string;
  options: { swap: boolean; concat: boolean };
  progress: RenderProgress | null;
  clips: ClipState[];
  merged: { url: string; duration: number } | null;
  failed: Array<{ time: string; error: string }>;
  error: string | null;
  /** ISO, or `null` while the job is still running. */
  expiresAt: string | null;
}

export interface Job {
  id: string;
  input: JobInput;
  dir: string;
  status: JobStatus;
  progress: RenderProgress | null;
  clips: Clip[];
  merged: { path: string; duration: number } | null;
  failed: RenderResult["failed"];
  error: string | null;
  /** When the job started running — used by `sweep`'s ceiling. */
  startedAt: number;
  finishedAt: number | null;
  /**
   * Memoizes the zip build *promise*, not the path: two concurrent requests
   * this way share the same build instead of each one overwriting the
   * other's file.
   */
  zipBuild: Promise<string> | null;
  /** Resolves when the job finishes, whether it succeeded or not. */
  done: Promise<void>;
}

export interface JobStoreOptions {
  root: string;
  render?: (request: RenderRequest) => Promise<RenderResult>;
  newId?: () => string;
  now?: () => number;
}

/**
 * Keeps jobs in memory. A restart loses whatever was running — which is why
 * the sweeper also runs on startup, so it doesn't leave orphaned files
 * behind.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<(state: JobState) => void>>();
  private readonly root: string;
  private readonly render: (request: RenderRequest) => Promise<RenderResult>;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor({ root, render, newId, now }: JobStoreOptions) {
    this.root = root;
    this.render = render ?? renderReplays;
    // 12 hex chars (48 bits): the risk here isn't guessing, it's collision —
    // a repeated id would make `create` silently replace a live job, and the
    // two would end up sharing `work/<id>/`, leaking one's files through the
    // other's `/files` URLs. `create` still resamples on collision anyway.
    this.newId = newId ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 12));
    this.now = now ?? Date.now;
  }

  create(input: JobInput): Job {
    let id = this.newId();
    while (this.jobs.has(id)) id = this.newId();
    const dir = `${this.root}/${id}`;

    const job: Job = {
      id,
      input,
      dir,
      status: "running",
      progress: null,
      clips: [],
      merged: null,
      failed: [],
      error: null,
      startedAt: this.now(),
      finishedAt: null,
      zipBuild: null,
      done: Promise.resolve(),
    };

    this.jobs.set(id, job);
    // Deferred to the next microtask: this way the caller of `create` still
    // gets a chance to `subscribe` before the first progress notification,
    // even when `render` is synchronous (as it is in the tests).
    job.done = Promise.resolve().then(() => this.run(job));
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  subscribe(id: string, listener: (state: JobState) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  serialize(job: Job): JobState {
    return {
      id: job.id,
      status: job.status,
      field: job.input.field,
      fieldLabel: job.input.fieldLabel,
      date: job.input.date,
      hour: job.input.hour,
      options: { swap: job.input.swap, concat: job.input.concat },
      progress: job.progress,
      clips: job.clips.map((clip) => ({
        index: clip.index,
        time: clip.timestamp.slice(11),
        cameras: clip.cameras,
        url: `/files/${job.id}/${basename(clip.path)}`,
      })),
      merged: job.merged
        ? {
            url: `/files/${job.id}/${basename(job.merged.path)}`,
            duration: job.merged.duration,
          }
        : null,
      failed: job.failed.map(({ timestamp, error }) => ({
        time: timestamp.slice(11),
        error,
      })),
      error: job.error,
      expiresAt:
        job.finishedAt === null
          ? null
          : new Date(job.finishedAt + TTL_MS).toISOString(),
    };
  }

  /** Removes expired jobs and their files. Returns the removed ids. */
  async sweep(now: number = this.now()): Promise<string[]> {
    const removed: string[] = [];

    for (const [id, job] of this.jobs) {
      // Stuck running past the ceiling: mark it as error so it gains a
      // `finishedAt` and, with that, enters the normal TTL count on a future
      // pass — it isn't removed on this same pass.
      if (job.status === "running" && now - job.startedAt > RUNNING_CEILING_MS) {
        job.status = "error";
        job.error = "O job travou e foi encerrado depois de rodar tempo demais.";
        job.finishedAt = now;
        this.notify(job);
      }

      if (job.finishedAt === null) continue;
      if (now - job.finishedAt <= TTL_MS) continue;

      try {
        await rm(job.dir, { recursive: true, force: true });
        this.jobs.delete(id);
        this.listeners.delete(id);
        removed.push(id);
      } catch {
        // A removal failure for one job shouldn't stop sweeping the rest.
        // The job stays in the map to be retried on the next pass.
        continue;
      }
    }

    return removed;
  }

  private notify(job: Job): void {
    const set = this.listeners.get(job.id);
    if (!set) return;

    const state = this.serialize(job);
    for (const listener of set) {
      try {
        listener(state);
      } catch (error) {
        // `run()` calls `notify` inside its `finally`, outside any catch: a
        // misbehaving listener that throws would take down the whole
        // process (unhandled rejection) over a notification side effect,
        // not the job itself.
        console.error(`✗ listener do job ${job.id} falhou:`, error);
      }
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const result = await this.render({
        replays: job.input.replays,
        rawDir: `${job.dir}/raw`,
        outDir: job.dir,
        swap: job.input.swap,
        concat: job.input.concat,
        ...RENDER_DEFAULTS,
        onProgress: (progress) => {
          job.progress = progress;
          this.notify(job);
        },
        onClip: (clip) => {
          job.clips.push(clip);
          this.notify(job);
        },
      });

      job.clips = result.clips;
      job.merged = result.merged;
      job.failed = result.failed;
      // Success with no clip at all isn't success: there's nothing to deliver.
      job.status = result.clips.length > 0 ? "done" : "error";
      if (job.status === "error") {
        job.error = "Nenhum lance pôde ser gerado.";
      }
    } catch (error) {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = this.now();
      job.progress = null;
      this.notify(job);
    }
  }
}
