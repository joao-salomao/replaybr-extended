import { expect, test } from "bun:test";
import JSZip from "jszip";
import { buildZip } from "./zip.ts";

const blob = (data: string | Uint8Array<ArrayBuffer>) => new Blob([data], { type: "video/mp4" });

test("JSZip validates the CRC of every entry on read", async () => {
  // Real binary bytes: text doesn't exercise the format properly.
  const binary = new Uint8Array(Array.from({ length: 3000 }, (_, i) => i % 256));

  const zip = await buildZip([
    { name: "01_20-34-25.mp4", data: blob("conteúdo do primeiro") },
    { name: "02_20-35-39.mp4", data: blob(binary) },
  ]);

  // `checkCRC32: true` makes loadAsync throw if any entry's CRC doesn't
  // match its decompressed content — the closest JSZip equivalent of `unzip -t`.
  await expect(
    JSZip.loadAsync(await zip.arrayBuffer(), { checkCRC32: true }),
  ).resolves.toBeDefined();
});

test("lists entries by the given name", async () => {
  const zip = await buildZip([{ name: "01_20-34-25.mp4", data: blob("vídeo") }]);
  const archive = await JSZip.loadAsync(await zip.arrayBuffer());

  expect(Object.keys(archive.files)).toEqual(["01_20-34-25.mp4"]);
});

test("the extracted content is identical to the original, byte for byte", async () => {
  const original = new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));

  const zip = await buildZip([{ name: "01_20-34-25.mp4", data: blob(original) }]);
  const archive = await JSZip.loadAsync(await zip.arrayBuffer());

  const entry = archive.file("01_20-34-25.mp4");
  expect(entry).not.toBeNull();
  expect(await entry!.async("uint8array")).toEqual(original);
});

test("an empty list produces a structurally valid zip", async () => {
  const zip = await buildZip([]);
  const bytes = new Uint8Array(await zip.arrayBuffer());

  // Just the End Of Central Directory: 22 bytes starting with "PK\x05\x06".
  expect(bytes).toHaveLength(22);
  expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  expect(Object.keys((await JSZip.loadAsync(bytes)).files)).toEqual([]);
});
