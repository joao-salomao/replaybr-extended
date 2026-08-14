import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Replay } from "./api.ts";
import { downloadReplayPairs, type ReplayPair } from "./download.ts";

const replay = (timestamp: string, cameras: 1 | 2): Replay => ({
  timestamp,
  camera1_url: `https://exemplo/${timestamp}/camera1.mp4`,
  ...(cameras === 2
    ? { camera2_url: `https://exemplo/${timestamp}/camera2.mp4` }
    : {}),
});

const originalFetch = globalThis.fetch;
let dir: string;
let calls: string[];

/** Substitui o fetch: cada URL em `failing` falha `failures` vezes antes de dar certo. */
function stubFetch(failing: Record<string, number> = {}): void {
  const remaining = { ...failing };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if ((remaining[url] ?? 0) > 0) {
      remaining[url]!--;
      throw new Error("rede caiu");
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
  await rm(dir, { recursive: true, force: true });
});

describe("downloadReplayPairs", () => {
  test("avisa cada par assim que ele fica completo", async () => {
    stubFetch();
    const replays = [replay("2026-08-13T20:34:25", 2), replay("2026-08-13T20:35:39", 2)];
    const entregues: ReplayPair[] = [];

    const outcome = await downloadReplayPairs(replays, dir, {
      concurrency: 1,
      onPair: (pair) => entregues.push(pair),
    });

    expect(entregues).toHaveLength(2);
    expect(entregues[0]?.cameras).toHaveLength(2);
    expect(outcome.pairs).toHaveLength(2);
    expect(outcome.failed).toEqual([]);
  });

  test("lance de uma câmera só entrega um arquivo", async () => {
    stubFetch();
    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)], dir);

    expect(outcome.pairs[0]?.cameras).toHaveLength(1);
  });

  test("tenta 3 vezes antes de desistir de um arquivo", async () => {
    const url = "https://exemplo/2026-08-13T20:34:25/camera1.mp4";
    stubFetch({ [url]: 2 });

    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 1)], dir);

    expect(calls.filter((c) => c === url)).toHaveLength(3);
    expect(outcome.failed).toEqual([]);
    expect(outcome.pairs).toHaveLength(1);
  });

  test("um lance que falha é pulado, e os outros continuam", async () => {
    const url = "https://exemplo/2026-08-13T20:34:25/camera1.mp4";
    stubFetch({ [url]: 99 });
    const replays = [replay("2026-08-13T20:34:25", 1), replay("2026-08-13T20:35:39", 1)];
    const entregues: ReplayPair[] = [];

    const outcome = await downloadReplayPairs(replays, dir, {
      concurrency: 1,
      onPair: (pair) => entregues.push(pair),
    });

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.timestamp).toBe("2026-08-13T20:34:25");
    expect(entregues.map((p) => p.timestamp)).toEqual(["2026-08-13T20:35:39"]);
  });

  test("um lance com uma câmera quebrada não entrega par pela metade", async () => {
    const url = "https://exemplo/2026-08-13T20:34:25/camera2.mp4";
    stubFetch({ [url]: 99 });
    const entregues: ReplayPair[] = [];

    const outcome = await downloadReplayPairs([replay("2026-08-13T20:34:25", 2)], dir, {
      concurrency: 1,
      onPair: (pair) => entregues.push(pair),
    });

    expect(entregues).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
  });
});
