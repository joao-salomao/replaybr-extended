import { rm } from "node:fs/promises";
import type { Replay } from "./api.ts";
import { downloadReplayPairs, type ReplayPair } from "./download.ts";
import { concatClips, renderClip } from "./ffmpeg.ts";
import { probeDimensions, probeDuration, type Dimensions } from "./mp4.ts";

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
 * Rendering is serialized through a promise chain: two ffmpeg processes at
 * once would just fight over the same CPU.
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
    await deps.renderClip({
      sources,
      output: path,
      cell: measure,
      columns,
      fps,
      crf,
      preset,
    });
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
