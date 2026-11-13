import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import type { FfmpegLike } from "../encoder.ts";

/**
 * Loads the single-thread ffmpeg.wasm core shipped inside the extension (MV3
 * forbids remote code). Only the UI imports this: the `?url` imports are
 * Vite's, which `bun test` can't resolve.
 */
export async function loadFfmpeg(): Promise<FfmpegLike> {
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({ coreURL, wasmURL });
  return ffmpeg;
}
