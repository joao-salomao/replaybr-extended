import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDimensions, probeDuration } from "./mp4.ts";

// ---------------------------------------------------------------------------
// Byte-building helpers. These let a test assemble a real MP4 box tree —
// ftyp/moov/mvhd/trak/mdia/hdlr/minf/stbl/stsd/avc1 — in a few lines, so the
// suite stays hermetic: no ffmpeg, no network, no committed binary fixtures.
// ---------------------------------------------------------------------------

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function u64(n: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A regular box: 4-byte big-endian size, 4-byte ASCII type, then payload. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concatBytes(payload);
  return concatBytes([u32(8 + body.length), ascii(type), body]);
}

/** A box using the 64-bit "extended size" form: size32 === 1, then a real
 * 64-bit size right after the type. Large `mdat` boxes use this. */
function box64(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concatBytes(payload);
  return concatBytes([u32(1), ascii(type), u64(16 + body.length), body]);
}

/** version(1) + flags(3), the first 4 bytes of every "full box". */
function versionFlags(version: number): Uint8Array {
  return new Uint8Array([version, 0, 0, 0]);
}

function mvhdV0(timescale: number, duration: number): Uint8Array {
  return box(
    "mvhd",
    versionFlags(0),
    u32(0), // creation_time
    u32(0), // modification_time
    u32(timescale),
    u32(duration),
  );
}

function mvhdV1(timescale: number, duration: number | bigint): Uint8Array {
  return box(
    "mvhd",
    versionFlags(1),
    u64(0), // creation_time
    u64(0), // modification_time
    u32(timescale),
    u64(duration),
  );
}

function hdlr(handlerType: string): Uint8Array {
  return box(
    "hdlr",
    versionFlags(0),
    u32(0), // pre_defined
    ascii(handlerType), // exactly 4 chars: "vide", "soun", ...
    new Uint8Array(12), // reserved
    ascii("\0"), // name
  );
}

/** A minimal VisualSampleEntry, e.g. "avc1" — just enough for the reader:
 * width/height sit at a fixed offset after reserved/pre_defined fields. */
function visualSampleEntry(type: string, width: number, height: number): Uint8Array {
  return box(
    type,
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    new Uint8Array(12), // pre_defined[3]
    u16(width),
    u16(height),
  );
}

function stsd(...entries: Uint8Array[]): Uint8Array {
  return box("stsd", versionFlags(0), u32(entries.length), ...entries);
}

const stbl = (...children: Uint8Array[]) => box("stbl", ...children);
const minf = (...children: Uint8Array[]) => box("minf", ...children);
const mdia = (...children: Uint8Array[]) => box("mdia", ...children);
const trak = (...children: Uint8Array[]) => box("trak", ...children);
const moov = (...children: Uint8Array[]) => box("moov", ...children);
const ftyp = () => box("ftyp", ascii("isom"), u32(512), ascii("isomiso2avc1mp41"));
const mdat = (size: number) => box("mdat", new Uint8Array(size));

/** A complete, valid video trak. */
function videoTrak(width: number, height: number): Uint8Array {
  return trak(mdia(hdlr("vide"), minf(stbl(stsd(visualSampleEntry("avc1", width, height))))));
}

/** A trak whose handler is audio — no minf/stbl/stsd needed, since the
 * reader never descends into a non-video track. */
function audioTrak(): Uint8Array {
  return trak(mdia(hdlr("soun")));
}

// ---------------------------------------------------------------------------
// Temp-file plumbing
// ---------------------------------------------------------------------------

let tmpDir: string | undefined;

async function writeMp4(...parts: Uint8Array[]): Promise<string> {
  tmpDir ??= await mkdtemp(join(tmpdir(), "mp4-test-"));
  const path = join(tmpDir, `${crypto.randomUUID()}.mp4`);
  await Bun.write(path, concatBytes(parts));
  return path;
}

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("probeDimensions / probeDuration", () => {
  test("reads dimensions and duration from a normal file", async () => {
    const path = await writeMp4(
      ftyp(),
      moov(mvhdV0(1000, 30135), videoTrak(704, 560)),
      mdat(16),
    );

    await expect(probeDimensions(path)).resolves.toEqual({ width: 704, height: 560 });
    await expect(probeDuration(path)).resolves.toBeCloseTo(30.135, 6);
  });

  test("finds moov after a large mdat, as our own rendered clips have it", async () => {
    const path = await writeMp4(
      ftyp(),
      mdat(50_000), // stands in for our multi-megabyte mdat
      moov(mvhdV0(1000, 30134), videoTrak(1408, 560)),
    );

    await expect(probeDimensions(path)).resolves.toEqual({ width: 1408, height: 560 });
    await expect(probeDuration(path)).resolves.toBeCloseTo(30.134, 6);
  });

  test("reads a version-1 mvhd with a 64-bit duration", async () => {
    // A duration that doesn't fit in 32 bits, to prove the 64-bit path is
    // actually exercised rather than happening to also work as 32-bit.
    const bigDuration = 5_000_000_000n;
    const path = await writeMp4(
      ftyp(),
      moov(mvhdV1(1000, bigDuration), videoTrak(704, 560)),
    );

    await expect(probeDuration(path)).resolves.toBeCloseTo(5_000_000, 6);
  });

  test("handles a box using the 64-bit extended size form", async () => {
    const path = await writeMp4(
      ftyp(),
      box64("mdat", new Uint8Array(1000)), // extended-size box to skip over
      moov(mvhdV0(1000, 30135), videoTrak(704, 560)),
    );

    await expect(probeDimensions(path)).resolves.toEqual({ width: 704, height: 560 });
    await expect(probeDuration(path)).resolves.toBeCloseTo(30.135, 6);
  });

  test("picks the video track even when it isn't the first one", async () => {
    const path = await writeMp4(
      ftyp(),
      moov(mvhdV0(1000, 30135), audioTrak(), videoTrak(1408, 560)),
    );

    await expect(probeDimensions(path)).resolves.toEqual({ width: 1408, height: 560 });
  });

  test("duration still reads from mvhd even when there's no video track", async () => {
    const path = await writeMp4(ftyp(), moov(mvhdV0(1000, 30135), audioTrak()));

    await expect(probeDuration(path)).resolves.toBeCloseTo(30.135, 6);
  });

  test("rejects with a clear Portuguese error when there's no video track", async () => {
    const path = await writeMp4(ftyp(), moov(mvhdV0(1000, 30135), audioTrak()));

    await expect(probeDimensions(path)).rejects.toThrow(/dimensões.*vídeo/i);
  });

  test("rejects with a clear Portuguese error when there's no moov box", async () => {
    const path = await writeMp4(ftyp(), mdat(32));

    await expect(probeDimensions(path)).rejects.toThrow(/dimensões/i);
    await expect(probeDuration(path)).rejects.toThrow(/duração/i);
  });

  test("rejects with a clear error instead of crashing on a truncated file", async () => {
    const full = concatBytes([
      ftyp(),
      moov(mvhdV0(1000, 30135), videoTrak(704, 560)),
    ]);
    // Cut the file off mid-moov: the box tree is well-formed up to here,
    // then simply stops.
    const path = await writeMp4(full.slice(0, full.length - 20));

    await expect(probeDimensions(path)).rejects.toThrow(/dimensões/i);
    await expect(probeDuration(path)).rejects.toThrow(/duração/i);
  });

  test("rejects with a clear error for a file that isn't MP4 at all", async () => {
    const path = await writeMp4(ascii("this is definitely not an mp4 file"));

    await expect(probeDimensions(path)).rejects.toThrow(/dimensões/i);
    await expect(probeDuration(path)).rejects.toThrow(/duração/i);
  });

  test("rejects with a clear error for a missing file", async () => {
    tmpDir ??= await mkdtemp(join(tmpdir(), "mp4-test-"));
    const path = join(tmpDir, "does-not-exist.mp4");

    await expect(probeDimensions(path)).rejects.toThrow(/dimensões/i);
  });
});
