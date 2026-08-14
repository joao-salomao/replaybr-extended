import { describe, expect, test } from "bun:test";
import { resolveFfmpegPath } from "./ffmpeg.ts";

const downloaded = () => true;
const missing = () => false;

describe("resolveFfmpegPath", () => {
  test("uses the bundled binary when FFMPEG_PATH isn't set", () => {
    expect(resolveFfmpegPath("/pkg/ffmpeg-static/ffmpeg", {}, downloaded)).toBe(
      "/pkg/ffmpeg-static/ffmpeg",
    );
  });

  test("prefers FFMPEG_PATH over the bundled binary", () => {
    const path = resolveFfmpegPath(
      "/pkg/ffmpeg-static/ffmpeg",
      { FFMPEG_PATH: "/usr/local/bin/ffmpeg" },
      downloaded,
    );

    expect(path).toBe("/usr/local/bin/ffmpeg");
  });

  test("falls back to the PATH when the platform has no bundled build", () => {
    expect(resolveFfmpegPath(null, {}, missing)).toBe("ffmpeg");
  });

  test("falls back to the PATH when the bundled binary was never downloaded", () => {
    // `ffmpeg-static` hands back a path whether or not its install script
    // ran — and Bun skips install scripts unless the package is trusted.
    expect(resolveFfmpegPath("/pkg/ffmpeg-static/ffmpeg", {}, missing)).toBe(
      "ffmpeg",
    );
  });

  test("keeps a FFMPEG_PATH that points nowhere, so the error names it", () => {
    // Silently falling back would hide the user's own typo behind whatever
    // ffmpeg happens to be on the PATH.
    expect(resolveFfmpegPath(null, { FFMPEG_PATH: "/nope" }, missing)).toBe(
      "/nope",
    );
  });

  test("ignores a blank FFMPEG_PATH instead of spawning an empty command", () => {
    expect(resolveFfmpegPath(null, { FFMPEG_PATH: "   " }, missing)).toBe(
      "ffmpeg",
    );
  });
});
