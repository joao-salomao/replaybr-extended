import { describe, expect, test } from "bun:test";
import { buildFilterGraph, createFfmpegEncoder, type FfmpegLike } from "./encoder.ts";

const cell = { width: 704, height: 560 };
const scaled = (i: number) =>
  `[${i}:v]scale=704:560:force_original_aspect_ratio=decrease,` +
  `pad=704:560:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[c${i}]`;

describe("buildFilterGraph", () => {
  test("two cameras go side by side", () => {
    expect(buildFilterGraph(2, cell, 2, 30)).toBe(
      `${scaled(0)};${scaled(1)};[c0][c1]hstack=inputs=2[v]`,
    );
  });

  test("a single camera on a two-column frame is centered", () => {
    expect(buildFilterGraph(1, cell, 2, 30)).toBe(`${scaled(0)};[c0]pad=1408:560:(ow-iw)/2:0[v]`);
  });

  test("a single camera on a one-column frame passes through", () => {
    expect(buildFilterGraph(1, cell, 1, 30)).toBe(`${scaled(0)};[c0]null[v]`);
  });
});

/** Records what the encoder asks of ffmpeg; `exec` can be told to fail. */
function fakeFfmpeg(execFails = false) {
  const written: string[] = [];
  const deleted: string[] = [];
  const execs: string[][] = [];
  const ffmpeg: FfmpegLike = {
    writeFile: async (path) => {
      written.push(path);
      return true;
    },
    exec: async (args) => {
      execs.push(args);
      if (execFails) throw new Error("exec failed");
      written.push("out.mp4");
      return 0;
    },
    readFile: async () => new Uint8Array([9, 9]),
    deleteFile: async (path) => {
      deleted.push(path);
      return true;
    },
  };
  return { ffmpeg, written, deleted, execs };
}

const options = {
  sources: [new Uint8Array([1]), new Uint8Array([2])],
  cell,
  columns: 2,
  fps: 30,
  crf: 20,
  preset: "veryfast",
};

describe("createFfmpegEncoder", () => {
  test("render passes the same x264 args as before", async () => {
    const { ffmpeg, execs } = fakeFfmpeg();

    const out = await createFfmpegEncoder(ffmpeg).render(options);

    const args = execs[0]!.join(" ");
    expect(args).toContain("-c:v libx264");
    expect(args).toContain("-preset veryfast");
    expect(args).toContain("-crf 20");
    expect(args).toContain("-pix_fmt yuv420p");
    expect(args).toContain("-an");
    expect(args).toContain(`-filter_complex ${buildFilterGraph(2, cell, 2, 30)}`);
    expect(out).toEqual(new Uint8Array([9, 9]));
  });

  test("render deletes its input and output files even when exec fails", async () => {
    const { ffmpeg, written, deleted } = fakeFfmpeg(true);

    await expect(createFfmpegEncoder(ffmpeg).render(options)).rejects.toThrow("exec failed");

    expect(written.length).toBeGreaterThan(0);
    for (const path of written) expect(deleted).toContain(path);
  });

  test("leaves the caller's bytes usable even though ffmpeg.wasm transfers what it is given", async () => {
    const { ffmpeg } = fakeFfmpeg();
    const sizes: number[] = [];
    // ffmpeg.wasm posts the data to its worker with the buffer in the
    // transfer list, which detaches the array it received.
    ffmpeg.writeFile = async (_path, data) => {
      const bytes = data as Uint8Array<ArrayBuffer>;
      sizes.push(bytes.byteLength);
      structuredClone(bytes, { transfer: [bytes.buffer] });
      return true;
    };
    const encoder = createFfmpegEncoder(ffmpeg);

    await encoder.render(options);
    await encoder.render(options);

    expect(sizes).toEqual([1, 1, 1, 1]);
  });

  test("a non-zero exit code rejects", async () => {
    const { ffmpeg } = fakeFfmpeg();
    ffmpeg.exec = async () => 1;

    await expect(createFfmpegEncoder(ffmpeg).render(options)).rejects.toThrow();
  });
});
