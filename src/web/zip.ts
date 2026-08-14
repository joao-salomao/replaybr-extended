import { createReadStream } from "node:fs";
import { basename } from "node:path";
import JSZip from "jszip";

/**
 * Packs a job's clips into a `.zip`.
 *
 * Everything streamed: `createReadStream` on the way in, `generateNodeStream`
 * on the way out. With `generateAsync`, a 200 MB zip would cost ~475 MB of
 * RSS, and since there's no queue two simultaneous downloads would double
 * that — streaming keeps the peak around ~67 MB for the same file.
 *
 * `STORE` because mp4 already comes compressed: deflate here burns CPU without
 * shrinking anything.
 */
export async function buildZip(
  paths: string[],
  output: string,
): Promise<string> {
  const zip = new JSZip();
  for (const path of paths) {
    // The name inside the zip is just the filename: the server-side path never leaks.
    zip.file(basename(path), createReadStream(path));
  }

  const sink = Bun.file(output).writer();
  const stream = zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "STORE",
  });

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Uint8Array) => {
      sink.write(chunk);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  await sink.end();

  return output;
}
