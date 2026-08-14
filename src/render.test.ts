import { describe, expect, test } from "bun:test";
import type { Replay } from "./api.ts";
import type { ReplayPair } from "./download.ts";
import { renderReplays, type Clip, type RenderDeps } from "./render.ts";

const replay = (timestamp: string, cameras: 1 | 2): Replay => ({
  timestamp,
  camera1_url: `https://example/${timestamp}/camera1.mp4`,
  ...(cameras === 2
    ? { camera2_url: `https://example/${timestamp}/camera2.mp4` }
    : {}),
});

interface Spy {
  deps: RenderDeps;
  rendered: Array<{ sources: string[]; output: string; columns: number }>;
  removed: string[][];
  concatenated: string[][];
}

/**
 * Fake deps. `order` defines the sequence in which pairs are delivered, by
 * index — this is how we simulate downloads finishing out of order.
 */
function spy(order: number[], failures: string[] = []): Spy {
  const rendered: Spy["rendered"] = [];
  const removed: string[][] = [];
  const concatenated: string[][] = [];

  const deps: RenderDeps = {
    downloadReplayPairs: async (replays, rawDir, options) => {
      const pairs: ReplayPair[] = [];
      for (const index of order) {
        const target = replays[index];
        if (!target) continue;
        const cameras = [`${rawDir}/cam1-${index}.mp4`];
        if (target.camera2_url) cameras.push(`${rawDir}/cam2-${index}.mp4`);
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
    renderClip: async ({ sources, output, columns }) => {
      rendered.push({ sources, output, columns });
      return output;
    },
    concatClips: async (clips, output) => {
      concatenated.push(clips);
      return output;
    },
    probeDuration: async () => 42,
    removePaths: async (paths) => {
      removed.push(paths);
    },
  };

  return { deps, rendered, removed, concatenated };
}

const request = (replays: Replay[], deps: RenderDeps, extra = {}) => ({
  replays,
  rawDir: "/tmp/raw",
  outDir: "/tmp/out",
  swap: false,
  concat: false,
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

  test("numbers the file by chronological position, not completion order", async () => {
    const { deps, rendered } = spy([2, 0, 1]);

    await renderReplays(request(THREE, deps));

    // The first one rendered is index 2, which is the third one of the day.
    expect(rendered[0]?.output).toBe("/tmp/out/03_20-48-28.mp4");
    expect(rendered[1]?.output).toBe("/tmp/out/01_20-34-25.mp4");
  });

  test("removes each play's raw files right after rendering it", async () => {
    const { deps, removed } = spy([0, 1, 2]);

    await renderReplays(request(THREE, deps));

    expect(removed).toHaveLength(3);
    expect(removed[0]).toEqual(["/tmp/raw/cam1-0.mp4", "/tmp/raw/cam2-0.mp4"]);
  });

  test("swap reverses the camera order", async () => {
    const { deps, rendered } = spy([0]);

    await renderReplays(request([THREE[0]!], deps, { swap: true }));

    expect(rendered[0]?.sources).toEqual([
      "/tmp/raw/cam2-0.mp4",
      "/tmp/raw/cam1-0.mp4",
    ]);
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

  test("concat assembles the single video with the clips in order", async () => {
    const { deps, concatenated } = spy([2, 0, 1]);

    const result = await renderReplays(request(THREE, deps, { concat: true }));

    expect(concatenated[0]).toEqual([
      "/tmp/out/01_20-34-25.mp4",
      "/tmp/out/02_20-35-39.mp4",
      "/tmp/out/03_20-48-28.mp4",
    ]);
    expect(result.merged).toEqual({ path: "/tmp/out/completo.mp4", duration: 42 });
  });

  test("without concat, no single video is produced", async () => {
    const { deps, concatenated } = spy([0]);

    const result = await renderReplays(request([THREE[0]!], deps));

    expect(concatenated).toEqual([]);
    expect(result.merged).toBeNull();
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
    const original = deps.renderClip;
    deps.renderClip = async (options) => {
      if (options.output.includes("02_")) throw new Error("ffmpeg broke");
      return original(options);
    };

    const result = await renderReplays(request(THREE, deps));

    expect(result.clips).toHaveLength(2);
    expect(result.failed[0]?.error).toBe("ffmpeg broke");
  });

  test("emits progress for each phase", async () => {
    const { deps } = spy([0, 1, 2]);
    const phases: string[] = [];

    await renderReplays(
      request(THREE, deps, {
        concat: true,
        onProgress: (p: { phase: string }) => phases.push(p.phase),
      }),
    );

    expect(phases).toContain("render");
    expect(phases).toContain("concat");
  });

  test("calls onClip as each clip becomes ready", async () => {
    const { deps } = spy([2, 0, 1]);
    const seen: Clip[] = [];

    await renderReplays(request(THREE, deps, { onClip: (c: Clip) => seen.push(c) }));

    // onClip follows completion order, not chronological order.
    expect(seen.map((c) => c.index)).toEqual([2, 0, 1]);
  });

  test("caps concurrent encodes across two simultaneous jobs to 1", async () => {
    let inFlight = 0;
    let peak = 0;

    const makeDeps = (order: number[]) => {
      const { deps } = spy(order);
      const original = deps.renderClip;
      deps.renderClip = async (options) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // A few ms is enough for the second job's encode to overlap with
        // the first's if the cross-job cap isn't actually enforced.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return original(options);
      };
      return deps;
    };

    const jobA = renderReplays(request(THREE, makeDeps([0, 1, 2])));
    const jobB = renderReplays(request(THREE, makeDeps([0, 1, 2])));

    const [resultA, resultB] = await Promise.all([jobA, jobB]);

    expect(peak).toBeLessThanOrEqual(1);
    expect(resultA.clips).toHaveLength(3);
    expect(resultB.clips).toHaveLength(3);
  });

  test("a renderClip that throws still releases its permit for a later job", async () => {
    const { deps: failingDeps } = spy([0]);
    failingDeps.renderClip = async () => {
      throw new Error("ffmpeg broke");
    };

    const failedResult = await renderReplays(request([THREE[0]!], failingDeps));

    expect(failedResult.clips).toHaveLength(0);
    expect(failedResult.failed[0]?.error).toBe("ffmpeg broke");

    // If the failure above had leaked its permit, this call would hang
    // forever waiting for a permit that never comes back — that's the leak
    // this test exists to catch.
    const { deps: okDeps, rendered } = spy([0]);
    const okResult = await renderReplays(request([THREE[0]!], okDeps));

    expect(okResult.clips).toHaveLength(1);
    expect(rendered).toHaveLength(1);
  });
});
