import JSZip from "jszip";

/**
 * Packs clips into a `.zip` in the browser. `STORE` because mp4 already comes
 * compressed: deflate would burn CPU without shrinking anything.
 *
 * JSZip only accepts Blob input where it detects browser Blob support (not
 * under `bun test`), so entries go in as ArrayBuffers and the output is
 * wrapped in a Blob here: the same path runs in both places.
 */
export async function buildZip(files: { name: string; data: Blob }[]): Promise<Blob> {
  const zip = new JSZip();
  for (const { name, data } of files) zip.file(name, await data.arrayBuffer());
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}
