import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchReplaysForDate,
  groupReplaysByHour,
  normalizeHour,
  ReplayBrUnavailableError,
  type Replay,
} from "./api.ts";

/**
 * Real plays from `four-play-3` on 2026-08-13, checked against the official
 * site on 2026-08-14: hour 20 shows 6 plays and hour 21 shows 2.
 */
const TIMESTAMPS = [
  "2026-08-13T20:34:25",
  "2026-08-13T20:35:39",
  "2026-08-13T20:36:55",
  "2026-08-13T20:48:28",
  "2026-08-13T20:49:47",
  "2026-08-13T20:54:02",
  "2026-08-13T21:11:56",
  "2026-08-13T21:32:51",
];

const replay = (timestamp: string): Replay => ({
  timestamp,
  camera1_url: `https://example/${timestamp}/camera1.mp4`,
  camera2_url: `https://example/${timestamp}/camera2.mp4`,
});

const FIXTURE = TIMESTAMPS.map(replay);

describe("groupReplaysByHour", () => {
  test("groups by the timestamp's hour, like the official site", () => {
    const groups = groupReplaysByHour(FIXTURE);

    expect(groups.map((g) => g.hour)).toEqual(["20", "21"]);
    expect(groups[0]?.replays).toHaveLength(6);
    expect(groups[1]?.replays).toHaveLength(2);
  });

  test("21:11:56 lands in hour 21, not the previous one", () => {
    // Regression: the old 30-minute-slot logic put this play in the "20:30"
    // bucket, diverging from the site.
    const groups = groupReplaysByHour(FIXTURE);
    const hour21 = groups.find((g) => g.hour === "21");

    expect(hour21?.replays.map((r) => r.timestamp)).toEqual([
      "2026-08-13T21:11:56",
      "2026-08-13T21:32:51",
    ]);
  });

  test("labels the hour in the displayed format", () => {
    expect(groupReplaysByHour(FIXTURE)[0]?.label).toBe("20:00");
  });

  test("sorts by timestamp even with out-of-order input", () => {
    const groups = groupReplaysByHour([...FIXTURE].reverse());

    expect(groups.map((g) => g.hour)).toEqual(["20", "21"]);
    expect(groups[0]?.replays[0]?.timestamp).toBe("2026-08-13T20:34:25");
  });

  test("empty list returns no groups", () => {
    expect(groupReplaysByHour([])).toEqual([]);
  });
});

describe("normalizeHour", () => {
  test.each([
    ["20", "20"],
    ["20:00", "20"],
    ["20:30", "20"],
    ["2030", "20"],
    ["20h30", "20"],
    ["20.30", "20"],
    ["9", "09"],
    ["00:15", "00"],
    // Three digits are read as H + MM: "203" is 2:03.
    ["203", "02"],
    [" 20 ", "20"],
  ])("normalizes %p to %p", (input, expected) => {
    expect(normalizeHour(input)).toBe(expected);
  });

  test.each([["24"], ["20:60"], ["abc"], [""], ["-1"], ["20:1"]])(
    "rejects %p",
    (input) => {
      expect(normalizeHour(input)).toBeNull();
    },
  );
});

const originalFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[];

/** Replaces fetch with a stub driven by `handler`, so no test ever reaches the network. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchReplaysForDate", () => {
  test("returns the replays array from a successful response", async () => {
    const replays: Replay[] = [
      { timestamp: "2026-08-13T20:34:25", camera1_url: "https://example/c1.mp4" },
    ];
    stubFetch(() => Response.json({ replays }));

    const result = await fetchReplaysForDate("four-play-3", "2026-08-13");

    expect(result).toEqual(replays);
  });

  test("a body with no replays key returns an empty array", async () => {
    stubFetch(() => Response.json({}));

    expect(await fetchReplaysForDate("four-play-3", "2026-08-13")).toEqual([]);
  });

  test("a body where replays is not an array returns an empty array", async () => {
    stubFetch(() => Response.json({ replays: "not-an-array" }));

    expect(await fetchReplaysForDate("four-play-3", "2026-08-13")).toEqual([]);
  });

  test("a non-2xx response throws ReplayBrUnavailableError", async () => {
    stubFetch(() => new Response("nope", { status: 503, statusText: "Service Unavailable" }));

    await expect(fetchReplaysForDate("four-play-3", "2026-08-13")).rejects.toThrow(
      ReplayBrUnavailableError,
    );
  });

  test("a fetch rejection throws ReplayBrUnavailableError preserving the underlying message", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND replays.replaybr.com.br");
    });

    await expect(fetchReplaysForDate("four-play-3", "2026-08-13")).rejects.toThrow(
      /getaddrinfo ENOTFOUND replays\.replaybr\.com\.br/,
    );
  });

  test("builds the URL from API_BASE with fieldName and date, for an ordinary input", async () => {
    stubFetch(() => Response.json({ replays: [] }));

    await fetchReplaysForDate("four-play-3", "2026-08-13");

    expect(calls[0]?.url).toBe(
      "https://replays.replaybr.com.br/available-hours?fieldName=four-play-3&date=2026-08-13",
    );
  });

  test("percent-encodes fieldName and date when they need it", async () => {
    stubFetch(() => Response.json({ replays: [] }));

    await fetchReplaysForDate("campo & sul", "2026/08/13");

    expect(calls[0]?.url).toBe(
      "https://replays.replaybr.com.br/available-hours?fieldName=campo%20%26%20sul&date=2026%2F08%2F13",
    );
  });

  test("passes an abort signal for the timeout", async () => {
    stubFetch(() => Response.json({ replays: [] }));

    await fetchReplaysForDate("four-play-3", "2026-08-13");

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
