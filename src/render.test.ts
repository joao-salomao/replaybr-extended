import { describe, expect, test } from "bun:test";
import type { Replay } from "./api.ts";
import type { ReplayPair } from "./download.ts";
import { EncoderCrashedError, type EncodeOptions } from "./encoder.ts";
import { renderReplays, type Clip, type RenderDeps } from "./render.ts";

const replay = (timestamp: string, cameras: 1 | 2): Replay => ({
  timestamp,
  camera1_url: `https://example/${timestamp}/camera1.mp4`,
  ...(cameras === 2
    ? { camera2_url: `https://example/${timestamp}/camera2.mp4` }
    : {}),
});

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

interface Spy {
  deps: RenderDeps;
  /** Each encode, with its sources decoded back to labels like "cam1-0". */
  rendered: Array<{ sources: string[]; columns: number }>;
}

/**
 * Fake deps. `order` defines the sequence in which pairs are delivered, by
 * index — this is how we simulate downloads finishing out of order. Each
 * camera's bytes spell its label, and the encoder returns "out:<labels>".
 */
function spy(order: number[], failures: string[] = []): Spy {
  const rendered: Spy["rendered"] = [];

  const deps: RenderDeps = {
    downloadReplayPairs: async (replays, options) => {
      const pairs: ReplayPair[] = [];
      for (const index of order) {
        const target = replays[index];
        if (!target) continue;
        const cameras = [bytes(`cam1-${index}`)];
        if (target.camera2_url) cameras.push(bytes(`cam2-${index}`));
        const pair: ReplayPair = { index, timestamp: target.timestamp, cameras };
        pairs.push(pair);
        options?.onPair?.(pair);
      }
      for (const timestamp of failures) {
        options?.onPairError?.({ index: -1, timestamp, error: "network down" });
      }
      return { pairs, failed: [] };
    },
    probeDimensions: async () => ({ width: 704, height: 560 }),
    encoder: {
      render: async ({ sources, columns }: EncodeOptions) => {
        const labels = sources.map(text);
        rendered.push({ sources: labels, columns });
        return bytes(`out:${labels.join("+")}`);
      },
    },
  };

  return { deps, rendered };
}

const request = (replays: Replay[], deps: RenderDeps, extra = {}) => ({
  replays,
  swap: false,
  fps: 30,
  crf: 20,
  preset: "veryfast",
  concurrency: 4,
  onProgress: () => {},
  onClip: () => {},
  deps,
  ...extra,
});

const THREE = [
  replay("2026-08-13T20:34:25", 2),
  replay("2026-08-13T20:35:39", 2),
  replay("2026-08-13T20:48:28", 2),
];

describe("renderReplays", () => {
  test("returns the clips in chronological order even when downloaded out of order", async () => {
    const { deps } = spy([2, 0, 1]);

    const result = await renderReplays(request(THREE, deps));

    expect(result.clips.map((c) => c.timestamp)).toEqual([
      "2026-08-13T20:34:25",
      "2026-08-13T20:35:39",
      "2026-08-13T20:48:28",
    ]);
  });

  test("names the file by chronological position, not completion order", async () => {
    const { deps } = spy([2, 0, 1]);
    const seen: Clip[] = [];

    await renderReplays(request(THREE, deps, { onClip: (c: Clip) => seen.push(c) }));

    // The first one rendered is index 2, which is the third one of the day.
    expect(seen.map((c) => c.name)).toEqual([
      "03_20-48-28.mp4",
      "01_20-34-25.mp4",
      "02_20-35-39.mp4",
    ]);
  });

  test("clip data is a video/mp4 Blob with the encoder output", async () => {
    const { deps } = spy([0]);

    const result = await renderReplays(request([THREE[0]!], deps));

    const clip = result.clips[0]!;
    expect(clip.data.type).toBe("video/mp4");
    expect(await clip.data.text()).toBe("out:cam1-0+cam2-0");
    expect(clip.cameras).toBe(2);
  });

  test("swap reverses the camera order", async () => {
    const { deps, rendered } = spy([0]);

    await renderReplays(request([THREE[0]!], deps, { swap: true }));

    expect(rendered[0]?.sources).toEqual(["cam2-0", "cam1-0"]);
  });

  test("swap with a single camera renders the same sources", async () => {
    const { deps, rendered } = spy([0]);

    await renderReplays(request([replay("2026-08-13T20:34:25", 1)], deps, { swap: true }));

    expect(rendered[0]?.sources).toEqual(["cam1-0"]);
  });

  test("uses a double frame when any play in the hour has a second camera", async () => {
    const mixed = [replay("2026-08-13T20:34:25", 1), replay("2026-08-13T20:35:39", 2)];
    const { deps, rendered } = spy([0, 1]);

    await renderReplays(request(mixed, deps));

    expect(rendered.map((r) => r.columns)).toEqual([2, 2]);
  });

  test("uses a single frame when no play has a second camera", async () => {
    const { deps, rendered } = spy([0]);

    await renderReplays(request([replay("2026-08-13T20:34:25", 1)], deps));

    expect(rendered[0]?.columns).toBe(1);
  });

  test("a play that failed to download lands in failed without stopping the rest", async () => {
    const { deps } = spy([0, 1], ["2026-08-13T20:48:28"]);

    const result = await renderReplays(request(THREE, deps));

    expect(result.clips).toHaveLength(2);
    expect(result.failed).toEqual([
      { timestamp: "2026-08-13T20:48:28", error: "network down" },
    ]);
  });

  test("a play that failed to render lands in failed without stopping the rest", async () => {
    const { deps } = spy([0, 1, 2]);
    const original = deps.encoder.render;
    deps.encoder = {
      render: async (options) => {
        if (text(options.sources[0]!) === "cam1-1") throw new Error("ffmpeg broke");
        return original(options);
      },
    };

    const result = await renderReplays(request(THREE, deps));

    expect(result.clips).toHaveLength(2);
    expect(result.failed[0]?.error).toBe("ffmpeg broke");
  });

  test("emits download and render progress", async () => {
    const { deps } = spy([0, 1, 2]);
    const phases: string[] = [];

    await renderReplays(
      request(THREE, deps, { onProgress: (p: { phase: string }) => phases.push(p.phase) }),
    );

    expect(phases).toContain("render");
    expect(phases).not.toContain("concat");
  });

  test("calls onClip as each clip becomes ready", async () => {
    const { deps } = spy([2, 0, 1]);
    const seen: Clip[] = [];

    await renderReplays(request(THREE, deps, { onClip: (c: Clip) => seen.push(c) }));

    // onClip follows completion order, not chronological order.
    expect(seen.map((c) => c.index)).toEqual([2, 0, 1]);
  });

  test("never runs two encodes at once", async () => {
    const { deps } = spy([0, 1, 2]);
    let running = 0;
    let peak = 0;
    deps.encoder = {
      render: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return bytes("out");
      },
    };

    await renderReplays(request(THREE, deps));

    expect(peak).toBe(1);
  });

  test("after the encoder crashes, the remaining plays fail without encoding", async () => {
    const { deps } = spy([0, 1, 2]);
    let calls = 0;
    deps.encoder = {
      render: async () => {
        calls++;
        throw new EncoderCrashedError("RuntimeError: Aborted(OOM)");
      },
    };

    const result = await renderReplays(request(THREE, deps));

    expect(calls).toBe(1);
    expect(result.clips).toEqual([]);
    expect(result.failed).toHaveLength(3);
    expect(result.crashed).toBe(true);
  });
});
