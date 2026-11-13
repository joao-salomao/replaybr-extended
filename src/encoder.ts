import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { Dimensions } from "./mp4.ts";

export interface EncodeOptions {
  /** One or two cameras of the same play, already in the order to show. */
  sources: Uint8Array[];
  /** Size of each camera within the frame. */
  cell: Dimensions;
  /** Columns of the final frame: 2 when the hour has any second camera. */
  columns: number;
  fps: number;
  crf: number;
  preset: string;
}

/** Turns one play's cameras into one MP4. Swappable for another engine. */
export interface ClipEncoder {
  render(options: EncodeOptions): Promise<Uint8Array>;
}

/** The part of ffmpeg.wasm the encoder uses; loading happens elsewhere. */
export type FfmpegLike = Pick<FFmpeg, "writeFile" | "exec" | "readFile" | "deleteFile" | "terminate">;

/**
 * The wasm module itself died (abort, out of memory), as opposed to ffmpeg
 * exiting with an error. The instance is unusable from here on.
 */
export class EncoderCrashedError extends Error {}

/**
 * Each camera is scaled to the same cell, keeping its aspect ratio, so every
 * clip of an hour comes out the same size. With two cameras they go side by
 * side; one camera alone stays centered on the frame's columns.
 */
export function buildFilterGraph(
  sourceCount: number,
  cell: Dimensions,
  columns: number,
  fps: number,
): string {
  const frameWidth = cell.width * columns;
  const steps = Array.from(
    { length: sourceCount },
    (_, i) =>
      `[${i}:v]scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease,` +
      `pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[c${i}]`,
  );

  if (sourceCount >= 2) {
    steps.push(`[c0][c1]hstack=inputs=2[v]`);
  } else if (frameWidth !== cell.width) {
    steps.push(`[c0]pad=${frameWidth}:${cell.height}:(ow-iw)/2:0[v]`);
  } else {
    steps.push(`[c0]null[v]`);
  }
  return steps.join(";");
}

const OUTPUT = "out.mp4";

export function createFfmpegEncoder(ffmpeg: FfmpegLike): ClipEncoder {
  return {
    async render({ sources, cell, columns, fps, crf, preset }) {
      if (sources.length === 0) throw new Error("Nenhuma câmera para renderizar");

      const inputs = sources.map((_, i) => `in${i}.mp4`);
      try {
        for (const [i, name] of inputs.entries()) {
          // ffmpeg.wasm transfers the buffer to its worker, detaching it:
          // hand it a copy so the caller's bytes stay usable.
          await ffmpeg.writeFile(name, sources[i]!.slice());
        }
        const code = await ffmpeg
          .exec([
            "-y", "-loglevel", "error",
            ...inputs.flatMap((name) => ["-i", name]),
            "-filter_complex", buildFilterGraph(sources.length, cell, columns, fps),
            "-map", "[v]",
            "-an",
            "-c:v", "libx264",
            "-preset", preset,
            "-crf", String(crf),
            "-pix_fmt", "yuv420p",
            OUTPUT,
          ])
          .catch((error: unknown) => {
            throw new EncoderCrashedError(error instanceof Error ? error.message : String(error));
          });
        if (code !== 0) throw new Error(`ffmpeg saiu com código ${code}`);

        const out = await ffmpeg.readFile(OUTPUT);
        if (typeof out === "string") throw new Error("ffmpeg devolveu texto em vez do vídeo");
        return out;
      } finally {
        // The wasm file system lives in the tab's memory: leftovers from one
        // play would pile up across the hour.
        for (const name of [...inputs, OUTPUT]) {
          await ffmpeg.deleteFile(name).catch(() => {});
        }
      }
    },
  };
}
