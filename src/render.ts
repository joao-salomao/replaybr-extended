import type { Replay } from "./api.ts";
import type { downloadReplayPairs, ReplayPair } from "./download.ts";
import { EncoderCrashedError, type ClipEncoder } from "./encoder.ts";
import type { Dimensions, probeDimensions } from "./mp4.ts";

export interface RenderProgress {
  phase: "download" | "render";
  done: number;
  total: number;
}

export interface Clip {
  /** Chronological position, assigned before any download. */
  index: number;
  timestamp: string;
  /** `NN_HH-MM-SS.mp4`, NN being the chronological position. */
  name: string;
  cameras: 1 | 2;
  data: Blob;
}

export interface RenderFailure {
  timestamp: string;
  error: string;
}

export interface RenderResult {
  /** In chronological order. */
  clips: Clip[];
  failed: RenderFailure[];
  /** The encoder died mid-job: it must be reloaded before the next one. */
  crashed: boolean;
}

/** Seam for tests: lets the pipeline run without the network or ffmpeg. */
export interface RenderDeps {
  downloadReplayPairs: typeof downloadReplayPairs;
  probeDimensions: typeof probeDimensions;
  /** One play at a time per encoder; plays spread across all of them. */
  encoders: ClipEncoder[];
}

export interface RenderRequest {
  replays: Replay[];
  swap: boolean;
  fps: number;
  crf: number;
  preset: string;
  concurrency: number;
  onProgress: (progress: RenderProgress) => void;
  onClip: (clip: Clip) => void;
  deps: RenderDeps;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Downloads and renders the plays, one video per play.
 *
 * Each play is rendered as soon as its cameras finish downloading, while the
 * next ones are still downloading: the first clip is ready in seconds. Plays
 * queue up and each free encoder takes the next one, so N encoders render N
 * plays side by side, and no encoder ever holds two (an ffmpeg.wasm instance
 * reuses the same file names).
 */
export async function renderReplays({
  replays,
  swap,
  fps,
  crf,
  preset,
  concurrency,
  onProgress,
  onClip,
  deps,
}: RenderRequest): Promise<RenderResult> {
  // The chronological index is fixed here, before any download, so the
  // filename doesn't depend on the order downloads finish in.
  const sorted = [...replays].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const total = sorted.length;
  // The listing alone tells us if the frame is double: nothing needs downloading.
  const columns = sorted.some((replay) => replay.camera2_url) ? 2 : 1;

  const clips: Clip[] = [];
  const failed: RenderFailure[] = [];
  // Shared promise: parallel encodes still probe the hour's size only once.
  let cell: Promise<Dimensions> | null = null;
  let rendered = 0;
  // Once the encoder dies, the remaining plays fail fast instead of each
  // feeding a dead module.
  let crash: EncoderCrashedError | null = null;

  const renderPair = async (encoder: ClipEncoder, pair: ReplayPair): Promise<void> => {
    if (crash) throw crash;
    const first = pair.cameras[0];
    if (!first) return;

    // Every clip in the hour comes out the same size: the first camera sets it.
    const measure = await (cell ??= deps.probeDimensions(new Blob([first as Uint8Array<ArrayBuffer>])));
    const sources = swap ? [...pair.cameras].reverse() : pair.cameras;

    const output = await encoder.render({ sources, cell: measure, columns, fps, crf, preset });

    const number = String(pair.index + 1).padStart(2, "0");
    const clock = pair.timestamp.slice(11).replaceAll(":", "-");
    const clip: Clip = {
      index: pair.index,
      timestamp: pair.timestamp,
      name: `${number}_${clock}.mp4`,
      cameras: pair.cameras.length >= 2 ? 2 : 1,
      data: new Blob([output as Uint8Array<ArrayBuffer>], { type: "video/mp4" }),
    };
    clips.push(clip);
    rendered++;
    onClip(clip);
    onProgress({ phase: "render", done: rendered, total });
  };

  const queue: ReplayPair[] = [];
  const idle = [...deps.encoders];
  const running: Promise<void>[] = [];

  const run = async (encoder: ClipEncoder, pair: ReplayPair): Promise<void> => {
    try {
      await renderPair(encoder, pair);
    } catch (error) {
      if (error instanceof EncoderCrashedError) crash = error;
      failed.push({ timestamp: pair.timestamp, error: message(error) });
    } finally {
      idle.push(encoder);
      dispatch();
    }
  };

  // Hands queued plays to free encoders, oldest play first.
  const dispatch = () => {
    while (idle.length > 0 && queue.length > 0) {
      running.push(run(idle.shift()!, queue.shift()!));
    }
  };

  await deps.downloadReplayPairs(sorted, {
    concurrency,
    onProgress: ({ done, total: files }) => onProgress({ phase: "download", done, total: files }),
    onPair: (pair) => {
      queue.push(pair);
      dispatch();
    },
    onPairError: ({ timestamp, error }) => failed.push({ timestamp, error }),
  });
  // Finishing encodes dispatch more plays, so drain until nothing new starts.
  while (running.length > 0) await Promise.all(running.splice(0));

  clips.sort((a, b) => a.index - b.index);
  return { clips, failed, crashed: crash !== null };
}
