import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dimensions } from "./mp4.ts";

export interface RenderClipOptions {
  /** One or two cameras of the same play. */
  sources: string[];
  output: string;
  /** Size of each camera within the frame. */
  cell: Dimensions;
  /** Columns of the final frame: 2 when the hour has any second camera. */
  columns: number;
  fps: number;
  crf: number;
  preset: string;
}

async function run(bin: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const tail = stderr.trim().split("\n").slice(-15).join("\n");
    throw new Error(`${bin} saiu com código ${code}:\n${tail}`);
  }
  return stdout.trim();
}

export async function assertFfmpegAvailable(): Promise<void> {
  try {
    await run("ffmpeg", ["-version"]);
  } catch {
    throw new Error(
      "`ffmpeg` não encontrado no PATH. Instale com: brew install ffmpeg",
    );
  }
}

/**
 * Renders a play. With two cameras, they go side by side; with just one, it
 * stays centered in the frame (which keeps `columns` columns).
 *
 * Each camera is scaled to the same size while preserving aspect ratio, and
 * every clip in an hour comes out with identical dimensions — a prerequisite
 * for concatenating without re-encoding.
 */
export async function renderClip({
  sources,
  output,
  cell,
  columns,
  fps,
  crf,
  preset,
}: RenderClipOptions): Promise<string> {
  if (sources.length === 0) {
    throw new Error(`Nenhuma câmera para renderizar em ${output}`);
  }

  const frameWidth = cell.width * columns;
  const steps = sources.map(
    (_, i) =>
      `[${i}:v]scale=${cell.width}:${cell.height}:force_original_aspect_ratio=decrease,` +
      `pad=${cell.width}:${cell.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[c${i}]`,
  );

  if (sources.length >= 2) {
    steps.push(`[c0][c1]hstack=inputs=2[v]`);
  } else if (frameWidth !== cell.width) {
    // Single camera on a two-column frame: center it and pad the rest.
    steps.push(`[c0]pad=${frameWidth}:${cell.height}:(ow-iw)/2:0[v]`);
  } else {
    steps.push(`[c0]null[v]`);
  }

  await mkdir(dirname(output), { recursive: true });
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    ...sources.flatMap((source) => ["-i", source]),
    "-filter_complex", steps.join(";"),
    "-map", "[v]",
    "-an",
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    output,
  ]);
  return output;
}

/** Concatenates already-normalized clips, without re-encoding. */
export async function concatClips(
  clips: string[],
  output: string,
  workDir: string,
): Promise<string> {
  const listFile = `${workDir}/concat.txt`;
  // The concat demuxer resolves relative paths against the list file's
  // folder, so the clips need to go in as absolute paths.
  const body = clips
    .map((clip) => `file '${resolve(clip).replaceAll("'", "'\\''")}'`)
    .join("\n");

  await mkdir(workDir, { recursive: true });
  await writeFile(listFile, `${body}\n`);
  await mkdir(dirname(output), { recursive: true });

  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0",
    "-i", listFile,
    "-c", "copy",
    output,
  ]);
  return output;
}
