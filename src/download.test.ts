import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Replay } from "./api.ts";
import { downloadReplayPairs, type ReplayPair } from "./download.ts";

const replay = (timestamp: string, cameras: 1 | 2): Replay => ({
  timestamp,
  camera1_url: `https://example/${timestamp}/camera1.mp4`,
  ...(cameras === 2
    ? { camera2_url: `https://example/${timestamp}/camera2.mp4` }
    : {}),
});

const originalFetch = globalThis.fetch;
let calls: string[];
let inits: (RequestInit | undefined)[];

/** Replaces fetch: each URL in `failing` fails `failures` times before succeeding. */
function stubFetch(failing: Record<string, number> = {}): void {
  const remaining = { ...failing };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    inits.push(init);
    if ((remaining[url] ?? 0) > 0) {
      remaining[url]!--;
      throw new Error("network down");
    }
    return new Response(new TextEncoder().encode(url));
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  inits = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadReplayPairs", () => {
  test("notifies each pair as soon as it becomes complete", async () => {
    stubFetch();
    const replays = [replay("2026-08-13T20:34:25", 2), replay("2026-08-13T20:35:39", 2)];
    const delivered: ReplayPair[] = [];

    const outcome = await downloadReplayPairs(replays, {
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
    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)]);

    expect(outcome.pairs[0]?.cameras).toHaveLength(1);
  });

  test("tries a file 3 times before giving up on it", async () => {
    const url = "https://example/2026-08-13T20:34:25/camera1.mp4";
    stubFetch({ [url]: 2 });

    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)]);

    expect(calls.filter((c) => c === url)).toHaveLength(3);
    expect(outcome.failed).toEqual([]);
    expect(outcome.pairs).toHaveLength(1);
  });

  test("a play that fails is skipped, and the others continue", async () => {
    const url = "https://example/2026-08-13T20:34:25/camera1.mp4";
    stubFetch({ [url]: 99 });
    const replays = [replay("2026-08-13T20:34:25", 1), replay("2026-08-13T20:35:39", 1)];
    const delivered: ReplayPair[] = [];

    const outcome = await downloadReplayPairs(replays, {
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

    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 2)], {
      concurrency: 1,
      onPair: (pair) => delivered.push(pair),
    });

    expect(delivered).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
  });

  test("keeps the bytes in memory", async () => {
    stubFetch();
    const r = replay("2026-08-13T20:34:25", 2);

    const outcome = await downloadReplayPairs([r]);

    const decoded = outcome.pairs[0]?.cameras.map((bytes) => new TextDecoder().decode(bytes));
    expect(decoded).toEqual([r.camera1_url, r.camera2_url!]);
  });

  test("sends the browser session along", async () => {
    stubFetch();

    await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)]);

    expect(inits[0]?.credentials).toBe("include");
  });

  test("a Cloudflare challenge on a video is not retried and surfaces CloudflareBlockedError", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("<title>Just a moment...</title>", {
        status: 403,
        headers: { "cf-mitigated": "challenge" },
      });
    }) as typeof fetch;

    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)]);

    expect(calls).toHaveLength(1);
    expect(outcome.failed[0]?.error).toContain("www.replaybr.com.br");
  });
});
