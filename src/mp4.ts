/**
 * Minimal MP4 (ISO/IEC 14496-12) box-tree reader.
 *
 * Replaces `ffprobe` for the only two things this app needs from a clip:
 * its coded width/height and its duration. An MP4 is a tree of boxes — a
 * 4-byte big-endian size, a 4-byte ASCII type, then a payload — so reading
 * a handful of fixed offsets inside `moov` is enough; nothing here decodes
 * a single video frame.
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** A file handle opened lazily by Bun; only the byte ranges we need are read. */
type Mp4File = ReturnType<typeof Bun.file>;

/** Internal parse failure. Callers translate this into a user-facing message. */
class Mp4ParseError extends Error {}

/** Parsed, but there's no track whose handler type is `vide`. */
class NoVideoTrackError extends Mp4ParseError {}

interface BoxHeader {
  type: string;
  /** Absolute offset of the first payload byte. */
  payloadStart: number;
  /** Absolute offset of the byte right after this box (the next sibling). */
  end: number;
}

/**
 * Reads one box header at `offset`. Handles the 64-bit "extended size" form
 * (a 32-bit size of exactly 1, followed by a 64-bit real size right after
 * the type) that large `mdat` boxes use — getting this wrong desyncs every
 * box that follows. `end` bounds the enclosing box so a corrupt size can't
 * walk past it.
 */
async function readBoxHeader(
  file: Mp4File,
  offset: number,
  end: number,
): Promise<BoxHeader> {
  if (offset + 8 > end) throw new Mp4ParseError("truncated box header");
  const head = new Uint8Array(
    await file.slice(offset, offset + 8).arrayBuffer(),
  );
  if (head.length < 8) throw new Mp4ParseError("truncated box header");
  const headView = new DataView(head.buffer);
  const size32 = headView.getUint32(0);
  const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);

  let headerSize = 8;
  let size: number;
  if (size32 === 1) {
    if (offset + 16 > end) {
      throw new Mp4ParseError("truncated 64-bit box size");
    }
    const ext = new Uint8Array(
      await file.slice(offset + 8, offset + 16).arrayBuffer(),
    );
    if (ext.length < 8) throw new Mp4ParseError("truncated 64-bit box size");
    size = Number(new DataView(ext.buffer).getBigUint64(0));
    headerSize = 16;
  } else if (size32 === 0) {
    // Legal but rare: the box runs to the end of its parent (typically the
    // last box in the file).
    size = end - offset;
  } else {
    size = size32;
  }

  if (!Number.isFinite(size) || size < headerSize || offset + size > end) {
    throw new Mp4ParseError(`box "${type}" reports an invalid size`);
  }

  return { type, payloadStart: offset + headerSize, end: offset + size };
}

/** Walks the direct children of [start, end), returning the first match. */
async function findBox(
  file: Mp4File,
  start: number,
  end: number,
  type: string,
): Promise<BoxHeader | null> {
  let offset = start;
  while (offset < end) {
    const header = await readBoxHeader(file, offset, end);
    if (header.type === type) return header;
    offset = header.end;
  }
  return null;
}

/** Walks the direct children of [start, end), returning every match, in order. */
async function findAllBoxes(
  file: Mp4File,
  start: number,
  end: number,
  type: string,
): Promise<BoxHeader[]> {
  const matches: BoxHeader[] = [];
  let offset = start;
  while (offset < end) {
    const header = await readBoxHeader(file, offset, end);
    if (header.type === type) matches.push(header);
    offset = header.end;
  }
  return matches;
}

async function readBytes(
  file: Mp4File,
  start: number,
  length: number,
): Promise<DataView> {
  const bytes = new Uint8Array(
    await file.slice(start, start + length).arrayBuffer(),
  );
  if (bytes.length < length) throw new Mp4ParseError("truncated box payload");
  return new DataView(bytes.buffer);
}

async function findMoov(file: Mp4File): Promise<BoxHeader> {
  // `moov` can sit right after `ftyp` or all the way past a multi-megabyte
  // `mdat` — our own renderer writes it last — so this always walks every
  // top-level box rather than assuming a position.
  const moov = await findBox(file, 0, file.size, "moov");
  if (!moov) throw new Mp4ParseError('no "moov" box found');
  return moov;
}

/**
 * `mvhd` (ISO 14496-12 §8.2.2). After version(1)+flags(3), version 0 packs
 * creation/modification/timescale/duration as 32-bit fields; version 1
 * widens creation, modification and duration to 64 bits.
 */
async function readMvhdDuration(
  file: Mp4File,
  moov: BoxHeader,
): Promise<number> {
  const mvhd = await findBox(file, moov.payloadStart, moov.end, "mvhd");
  if (!mvhd) throw new Mp4ParseError('no "mvhd" box found');

  const version = (await readBytes(file, mvhd.payloadStart, 1)).getUint8(0);
  const base = mvhd.payloadStart + 4 + (version === 1 ? 16 : 8);

  const timescale = (await readBytes(file, base, 4)).getUint32(0);
  if (timescale === 0) throw new Mp4ParseError("mvhd timescale is zero");

  const duration =
    version === 1
      ? Number((await readBytes(file, base + 4, 8)).getBigUint64(0))
      : (await readBytes(file, base + 4, 4)).getUint32(0);

  return duration / timescale;
}

/**
 * Finds the video track's `mdia` box by checking each `trak`'s
 * `mdia/hdlr` handler type — a file with an audio track first would
 * otherwise hand back nonsense dimensions from the wrong track.
 *
 * `hdlr` (ISO 14496-12 §8.4.3): version(1)+flags(3), pre_defined(4),
 * then the 4-byte ASCII handler_type ("vide", "soun", ...).
 */
async function findVideoTrackMdia(
  file: Mp4File,
  moov: BoxHeader,
): Promise<BoxHeader> {
  const traks = await findAllBoxes(file, moov.payloadStart, moov.end, "trak");
  for (const trak of traks) {
    const mdia = await findBox(file, trak.payloadStart, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = await findBox(file, mdia.payloadStart, mdia.end, "hdlr");
    if (!hdlr) continue;

    const handlerType = await readBytes(file, hdlr.payloadStart + 8, 4);
    const type = String.fromCharCode(
      handlerType.getUint8(0),
      handlerType.getUint8(1),
      handlerType.getUint8(2),
      handlerType.getUint8(3),
    );
    if (type === "vide") return mdia;
  }
  throw new NoVideoTrackError("no track with handler type \"vide\" found");
}

/**
 * Reads the CODED width/height from the video track's sample entry in
 * `mdia/minf/stbl/stsd` — not from `tkhd`, which stores the *display*
 * size in 16.16 fixed point after the track's transformation matrix, so a
 * rotated video would report the wrong thing there.
 *
 * `stsd` (§8.5.2): version(1)+flags(3), entry_count(4), then sample
 * entries. The first one is enough — a track has one coded size.
 *
 * The sample entry is itself a box. For any visual sample entry (`avc1`,
 * `hvc1`, `mp4v`, ...) it's a `VisualSampleEntry` (§12.1.3): 8 bytes of
 * `SampleEntry` (reserved + data_reference_index), then pre_defined(2) +
 * reserved(2) + pre_defined(12), then width(2) and height(2) as plain
 * big-endian integers — offset 24 from the sample entry's payload. This
 * fixed offset is exactly what ffprobe itself reads.
 */
async function readCodedDimensions(
  file: Mp4File,
  mdia: BoxHeader,
): Promise<Dimensions> {
  const minf = await findBox(file, mdia.payloadStart, mdia.end, "minf");
  if (!minf) throw new Mp4ParseError('no "minf" box found in video track');
  const stbl = await findBox(file, minf.payloadStart, minf.end, "stbl");
  if (!stbl) throw new Mp4ParseError('no "stbl" box found in video track');
  const stsd = await findBox(file, stbl.payloadStart, stbl.end, "stsd");
  if (!stsd) throw new Mp4ParseError('no "stsd" box found in video track');

  const sampleEntry = await readBoxHeader(
    file,
    stsd.payloadStart + 8, // past version(1)+flags(3)+entry_count(4)
    stsd.end,
  );

  const dims = await readBytes(file, sampleEntry.payloadStart + 24, 4);
  const width = dims.getUint16(0);
  const height = dims.getUint16(2);
  if (!width || !height) {
    throw new Mp4ParseError("sample entry reports zero width/height");
  }
  return { width, height };
}

/** Reads width and height from the video, used to normalize every clip. */
export async function probeDimensions(file: string): Promise<Dimensions> {
  try {
    const bunFile = Bun.file(file);
    const moov = await findMoov(bunFile);
    const mdia = await findVideoTrackMdia(bunFile, moov);
    return await readCodedDimensions(bunFile, mdia);
  } catch (error) {
    if (error instanceof NoVideoTrackError) {
      throw new Error(
        `Não foi possível ler as dimensões de ${file}: o arquivo não tem trilha de vídeo`,
      );
    }
    throw new Error(
      `Não foi possível ler as dimensões de ${file}: arquivo MP4 inválido ou corrompido`,
    );
  }
}

export async function probeDuration(file: string): Promise<number> {
  try {
    const bunFile = Bun.file(file);
    const moov = await findMoov(bunFile);
    return await readMvhdDuration(bunFile, moov);
  } catch {
    throw new Error(
      `Não foi possível ler a duração de ${file}: arquivo MP4 inválido ou corrompido`,
    );
  }
}
