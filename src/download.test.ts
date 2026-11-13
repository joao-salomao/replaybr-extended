import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCloudflareClearance, type Replay } from "./api.ts";
import { downloadReplayPairs, type ReplayPair } from "./download.ts";

const replay = (timestamp: string, cameras: 1 | 2): Replay => ({
  timestamp,
  camera1_url: `https://example/${timestamp}/camera1.mp4`,
  ...(cameras === 2
    ? { camera2_url: `https://example/${timestamp}/camera2.mp4` }
    : {}),
});

const originalFetch = globalThis.fetch;
let dir: string;
let calls: string[];

/** Replaces fetch: each URL in `failing` fails `failures` times before succeeding. */
function stubFetch(failing: Record<string, number> = {}): void {
  const remaining = { ...failing };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if ((remaining[url] ?? 0) > 0) {
      remaining[url]!--;
      throw new Error("network down");
    }
    return new Response(new Uint8Array([1, 2, 3, 4]));
  }) as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replaybr-"));
  calls = [];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setCloudflareClearance(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("downloadReplayPairs", () => {
  test("notifies each pair as soon as it becomes complete", async () => {
    stubFetch();
    const replays = [replay("2026-08-13T20:34:25", 2), replay("2026-08-13T20:35:39", 2)];
    const delivered: ReplayPair[] = [];

    const outcome = await downloadReplayPairs(replays, dir, {
      concurrency: 1,
      onPair: (pair) => delivered.push(pair),
    });

    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.cameras).toHaveLength(2);
    expect(outcome.pairs).toHaveLength(2);
    expect(outcome.failed).toEqual([]);
  });

  test("a single-camera play delivers a single file", async () => {
    stubFetch();
    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)], dir);

    expect(outcome.pairs[0]?.cameras).toHaveLength(1);
  });

  test("tries a file 3 times before giving up on it", async () => {
    const url = "https://example/2026-08-13T20:34:25/camera1.mp4";
    stubFetch({ [url]: 2 });

    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)], dir);

    expect(calls.filter((c) => c === url)).toHaveLength(3);
    expect(outcome.failed).toEqual([]);
    expect(outcome.pairs).toHaveLength(1);
  });

  test("a play that fails is skipped, and the others continue", async () => {
    const url = "https://example/2026-08-13T20:34:25/camera1.mp4";
    stubFetch({ [url]: 99 });
    const replays = [replay("2026-08-13T20:34:25", 1), replay("2026-08-13T20:35:39", 1)];
    const delivered: ReplayPair[] = [];

    const outcome = await downloadReplayPairs(replays, dir, {
      concurrency: 1,
      onPair: (pair) => delivered.push(pair),
    });

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.timestamp).toBe("2026-08-13T20:34:25");
    expect(delivered.map((p) => p.timestamp)).toEqual(["2026-08-13T20:35:39"]);
  });

  test("a play with one broken camera does not deliver a half pair", async () => {
    const url = "https://example/2026-08-13T20:34:25/camera2.mp4";
    stubFetch({ [url]: 99 });
    const delivered: ReplayPair[] = [];

    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 2)], dir, {
      concurrency: 1,
      onPair: (pair) => delivered.push(pair),
    });

    expect(delivered).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
  });

  test("sends the cf_clearance cookie when downloading from ReplayBR", async () => {
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }) as typeof fetch;
    setCloudflareClearance({ cfClearance: "abc123", userAgent: "Mozilla/5.0 Test" });

    await downloadReplayPairs(
      [
        {
          timestamp: "2026-11-12T20:41:02",
          camera1_url:
            "https://replays.replaybr.com.br/video/four-play-3/2026-11-12/20/2026-11-12T20:41:02/camera1.mp4",
        },
      ],
      dir,
    );

    expect(headers?.get("cookie")).toBe("cf_clearance=abc123");
    expect(headers?.get("user-agent")).toBe("Mozilla/5.0 Test");
  });
});
