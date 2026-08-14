import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { buildZip } from "./zip.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replaybr-zip-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("JSZip validates the CRC of every entry on read", async () => {
  const first = join(dir, "01_20-34-25.mp4");
  const second = join(dir, "02_20-35-39.mp4");
  await Bun.write(first, "conteúdo do primeiro");
  // Real binary bytes: text doesn't exercise the format properly.
  await Bun.write(
    second,
    new Uint8Array(Array.from({ length: 3000 }, (_, i) => i % 256)),
  );

  const output = await buildZip([first, second], join(dir, "todos.zip"));
  const bytes = await Bun.file(output).arrayBuffer();

  // `checkCRC32: true` makes loadAsync throw if any entry's CRC doesn't
  // match its decompressed content — the closest JSZip equivalent of `unzip -t`.
  await expect(JSZip.loadAsync(bytes, { checkCRC32: true })).resolves.toBeDefined();
});

test("lists entries by filename, without the path", async () => {
  const clip = join(dir, "01_20-34-25.mp4");
  await Bun.write(clip, "vídeo");

  const output = await buildZip([clip], join(dir, "todos.zip"));
  const bytes = await Bun.file(output).arrayBuffer();
  const archive = await JSZip.loadAsync(bytes);

  expect(Object.keys(archive.files)).toEqual(["01_20-34-25.mp4"]);
  // The entry name can't carry the server's absolute path.
  expect(Object.keys(archive.files).join()).not.toContain(clip);
});

test("the extracted content is identical to the original, byte for byte", async () => {
  const clip = join(dir, "01_20-34-25.mp4");
  const original = new Uint8Array(
    Array.from({ length: 5000 }, (_, i) => (i * 7) % 256),
  );
  await Bun.write(clip, original);

  const output = await buildZip([clip], join(dir, "todos.zip"));
  const bytes = await Bun.file(output).arrayBuffer();
  const archive = await JSZip.loadAsync(bytes);

  const entry = archive.file("01_20-34-25.mp4");
  expect(entry).not.toBeNull();
  const extracted = await entry!.async("uint8array");
  expect(extracted).toEqual(original);
});

test("an empty list produces a structurally valid zip", async () => {
  const output = await buildZip([], join(dir, "vazio.zip"));
  const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());

  // Just the End Of Central Directory: 22 bytes starting with "PK\x05\x06".
  expect(bytes).toHaveLength(22);
  expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);

  // Still readable back as a valid (empty) archive.
  const archive = await JSZip.loadAsync(bytes);
  expect(Object.keys(archive.files)).toEqual([]);
});
