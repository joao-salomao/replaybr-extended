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

/** Arquivos são apagados 2h depois que o job termina. */
export const TTL_MS = 2 * 60 * 60 * 1000;

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
  /** Só o relógio, ex: "20:34:25". */
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
  /** ISO, ou `null` enquanto o job ainda roda. */
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
  finishedAt: number | null;
  zipPath: string | null;
  /** Resolve quando o job termina, com sucesso ou não. */
  done: Promise<void>;
}

export interface JobStoreOptions {
  root: string;
  render?: (request: RenderRequest) => Promise<RenderResult>;
  newId?: () => string;
  now?: () => number;
}

/**
 * Guarda os jobs em memória. Um restart perde o que estava rodando — por isso o
 * sweeper também roda na inicialização, para não deixar arquivos órfãos.
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
    this.newId = newId ?? (() => crypto.randomUUID().slice(0, 8));
    this.now = now ?? Date.now;
  }

  create(input: JobInput): Job {
    const id = this.newId();
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
      finishedAt: null,
      zipPath: null,
      done: Promise.resolve(),
    };

    this.jobs.set(id, job);
    // Adiado para o próximo microtask: assim quem chama `create` ainda tem a
    // chance de se inscrever via `subscribe` antes do primeiro aviso de
    // progresso, mesmo quando `render` é síncrono (como nos testes).
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

  /** Remove os jobs vencidos e seus arquivos. Devolve os ids removidos. */
  async sweep(now: number = this.now()): Promise<string[]> {
    const removidos: string[] = [];

    for (const [id, job] of this.jobs) {
      if (job.finishedAt === null) continue;
      if (now - job.finishedAt <= TTL_MS) continue;

      await rm(job.dir, { recursive: true, force: true });
      this.jobs.delete(id);
      this.listeners.delete(id);
      removidos.push(id);
    }

    return removidos;
  }

  private notify(job: Job): void {
    const set = this.listeners.get(job.id);
    if (!set) return;

    const state = this.serialize(job);
    for (const listener of set) listener(state);
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
      // Sucesso sem nenhum clipe não é sucesso: não há o que entregar.
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
