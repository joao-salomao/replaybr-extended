import { rm } from "node:fs/promises";
import type { Replay } from "./api.ts";
import { downloadReplayPairs, type ReplayPair } from "./download.ts";
import { concatClips, renderClip } from "./ffmpeg.ts";
import { probeDimensions, probeDuration, type Dimensions } from "./mp4.ts";
import { Semaphore } from "./semaphore.ts";

/**
 * Caps concurrent ffmpeg encodes across every job on the server, not just
 * within one. `libx264` is already multithreaded, so a single encode
 * saturates a small box — 1 is the conservative choice the project owner
 * asked for, given a 2-vCPU VPS and jobs that must never be rejected.
 */
const ENCODE_CONCURRENCY = 1;

// Module scope: one instance shared by every job. An instance created per
// call (e.g. inside `renderReplays`) would give each job its own permit
// pool, defeating the entire cross-job cap.
const encodeSemaphore = new Semaphore(ENCODE_CONCURRENCY);

export interface RenderProgress {
  phase: "download" | "render" | "concat";
  done: number;
  total: number;
}

export interface Clip {
  /** Chronological position, assigned before any download. */
  index: number;
  timestamp: string;
  path: string;
  cameras: 1 | 2;
}

export interface RenderFailure {
  timestamp: string;
  error: string;
}

export interface RenderResult {
  /** In chronological order. */
  clips: Clip[];
  merged: { path: string; duration: number } | null;
  failed: RenderFailure[];
}

/** Seam for tests: lets the pipeline run without a real ffmpeg. */
export interface RenderDeps {
  downloadReplayPairs: typeof downloadReplayPairs;
  probeDimensions: typeof probeDimensions;
  renderClip: typeof renderClip;
  concatClips: typeof concatClips;
  probeDuration: typeof probeDuration;
  removePaths: (paths: string[]) => Promise<void>;
}

export const defaultRenderDeps: RenderDeps = {
  downloadReplayPairs,
  probeDimensions,
  renderClip,
  concatClips,
  probeDuration,
  removePaths: async (paths) => {
    for (const path of paths) await rm(path, { force: true });
  },
};

export interface RenderRequest {
  replays: Replay[];
  rawDir: string;
  outDir: string;
  swap: boolean;
  concat: boolean;
  fps: number;
  crf: number;
  preset: string;
  concurrency: number;
  onProgress: (progress: RenderProgress) => void;
  onClip: (clip: Clip) => void;
  deps?: RenderDeps;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Downloads and renders the plays, one video per play.
 *
 * Each play is rendered as soon as its files finish downloading, while the
 * next ones are still downloading — the first clip is ready in seconds, and
 * its raw files are gone right after, keeping the disk peak low.
 *
 * Rendering is serialized through a promise chain, so a single job never
 * runs two ffmpeg at once and never probes dimensions twice concurrently.
 * On top of that, `encodeSemaphore` caps concurrent encodes across every
 * job on the server to `ENCODE_CONCURRENCY` — otherwise N parallel jobs
 * would still mean N parallel ffmpeg processes fighting over the same CPU.
 */
export async function renderReplays({
  replays,
  rawDir,
  outDir,
  swap,
  concat,
  fps,
  crf,
  preset,
  concurrency,
  onProgress,
  onClip,
  deps = defaultRenderDeps,
}: RenderRequest): Promise<RenderResult> {
  // The chronological index is fixed here, before any download, so the
  // filename doesn't depend on the order downloads finish in.
  const sorted = [...replays].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  const total = sorted.length;
  // The listing alone tells us if the frame is double: nothing needs downloading.
  const columns = sorted.some((replay) => replay.camera2_url) ? 2 : 1;

  const clips: Clip[] = [];
  const failed: RenderFailure[] = [];
  let cell: Dimensions | null = null;
  let rendered = 0;
  let chain: Promise<void> = Promise.resolve();

  const renderPair = async (pair: ReplayPair): Promise<void> => {
    const first = pair.cameras[0];
    if (!first) return;

    // Every clip in the hour needs to come out the same size, or concat
    // without re-encoding stops working. The first file sets the measure.
    const measure = (cell ??= await deps.probeDimensions(first));

    const number = String(pair.index + 1).padStart(2, "0");
    const clock = pair.timestamp.slice(11).replaceAll(":", "-");
    const path = `${outDir}/${number}_${clock}.mp4`;

    const sources = swap ? [...pair.cameras].reverse() : pair.cameras;

    // Only the encode itself queues on the cross-job cap. Downloads are
    // I/O-bound and stay fully parallel — gating them here too would slow
    // every job down for no CPU benefit.
    const release = await encodeSemaphore.acquire();
    try {
      await deps.renderClip({
        sources,
        output: path,
        cell: measure,
        columns,
        fps,
        crf,
        preset,
      });
    } finally {
      // Must run even when renderClip throws: an escaped failure that skips
      // this would leak the permit forever, and after enough failures the
      // server would silently stop rendering — no error, nothing in the
      // log, just no more clips ever.
      release();
    }
    await deps.removePaths(pair.cameras);

    const clip: Clip = {
      index: pair.index,
      timestamp: pair.timestamp,
      path,
      cameras: pair.cameras.length >= 2 ? 2 : 1,
    };
    clips.push(clip);
    rendered++;
    onClip(clip);
    onProgress({ phase: "render", done: rendered, total });
  };

  await deps.downloadReplayPairs(sorted, rawDir, {
    concurrency,
    onProgress: ({ done, total: files }) =>
      onProgress({ phase: "download", done, total: files }),
    onPair: (pair) => {
      chain = chain
        .then(() => renderPair(pair))
        .catch((error: unknown) => {
          failed.push({ timestamp: pair.timestamp, error: message(error) });
        });
    },
    onPairError: ({ timestamp, error }) => failed.push({ timestamp, error }),
  });
  await chain;

  clips.sort((a, b) => a.index - b.index);

  let merged: RenderResult["merged"] = null;
  if (concat && clips.length > 0) {
    onProgress({ phase: "concat", done: 0, total: 1 });
    const path = `${outDir}/completo.mp4`;
    await deps.concatClips(
      clips.map((clip) => clip.path),
      path,
      rawDir,
    );
    merged = { path, duration: await deps.probeDuration(path) };
    onProgress({ phase: "concat", done: 1, total: 1 });
  }

  return { clips, merged, failed };
}
