import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayBrUnavailableError, type Replay } from "../api.ts";
import type { RenderRequest, RenderResult } from "../render.ts";
import { JobStore } from "./jobs.ts";
import { createApp } from "./routes.ts";

const TIMESTAMPS = [
  "2026-08-13T20:34:25",
  "2026-08-13T20:35:39",
  "2026-08-13T21:11:56",
];

const REPLAYS: Replay[] = TIMESTAMPS.map((timestamp) => ({
  timestamp,
  camera1_url: `https://example/${timestamp}/camera1.mp4`,
  camera2_url: `https://example/${timestamp}/camera2.mp4`,
}));

let root: string;
let app: ReturnType<typeof createApp>;
let store: JobStore;

const render = async (request: RenderRequest): Promise<RenderResult> => {
  const path = `${request.outDir}/01_20-34-25.mp4`;
  // ASCII on purpose: the Range test asserts the exact size in bytes.
  await Bun.write(path, "conteudo-do-video");
  const clip = {
    index: 0,
    timestamp: "2026-08-13T20:34:25",
    path,
    cameras: 2 as const,
  };
  request.onClip(clip);
  return { clips: [clip], merged: null, failed: [] };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "replaybr-routes-"));
  store = new JobStore({ root, render, now: () => 0 });
  app = createApp({
    fetchReplays: async () => REPLAYS,
    jobs: store,
    publicDir: "public",
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const createJob = async (body: Record<string, unknown> = {}) =>
  app.request("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      field: "four-play-3",
      date: "2026-08-13",
      hour: "20",
      replays: ["2026-08-13T20:34:25"],
      swap: true,
      concat: false,
      ...body,
    }),
  });

/**
 * Reads a SSE `Response` until the stream closes and returns the
 * (already `JSON.parse`d) body of each `data:` message, in the order they arrived.
 */
const readSSEEvents = async (res: Response): Promise<unknown[]> => {
  const reader = res.body?.getReader();
  if (!reader) return [];

  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice("data: ".length)));
    }
  }

  return events;
};

describe("GET /api/fields", () => {
  test("lists the fields with label and default swap", async () => {
    const res = await app.request("/api/fields");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { slug: "placar-society", label: "Placar Society", defaultSwap: false },
      { slug: "four-play-3", label: "Four Play - Quadra 3", defaultSwap: true },
    ]);
  });
});

describe("GET /api/replays", () => {
  test("returns the day grouped by hour", async () => {
    const res = await app.request("/api/replays?field=four-play-3&date=2026-08-13");
    const body = (await res.json()) as { hours: unknown[] };

    expect(res.status).toBe(200);
    expect(body.hours).toHaveLength(2);
    expect(body.hours[0]).toEqual({
      hour: "20",
      label: "20:00",
      anyTwoCameras: true,
      replays: [
        { timestamp: "2026-08-13T20:34:25", time: "20:34:25", cameras: 2 },
        { timestamp: "2026-08-13T20:35:39", time: "20:35:39", cameras: 2 },
      ],
    });
  });

  test("rejects an invalid slug", async () => {
    const res = await app.request("/api/replays?field=../etc&date=2026-08-13");
    expect(res.status).toBe(400);
  });

  test("rejects a wrongly formatted date", async () => {
    const res = await app.request("/api/replays?field=four-play-3&date=13-08-2026");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs", () => {
  test("creates the job and returns the id", async () => {
    const res = await createJob();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: unknown };
    expect(typeof body.jobId).toBe("string");
  });

  test("rejects an empty selection", async () => {
    expect((await createJob({ replays: [] })).status).toBe(400);
  });

  test("rejects an invalid hour", async () => {
    expect((await createJob({ hour: "99" })).status).toBe(400);
  });

  test("rejects a timestamp that doesn't exist in the requested hour", async () => {
    expect((await createJob({ replays: ["2026-08-13T23:00:00"] })).status).toBe(400);
  });

  test("rejects a body missing the required fields", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field: "four-play-3" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jobs/:id", () => {
  test("returns the job state", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/api/jobs/${jobId}`);
    const state = (await res.json()) as {
      status: string;
      clips: Array<{ url: string }>;
    };

    expect(res.status).toBe(200);
    expect(state.status).toBe("done");
    expect(state.clips[0]?.url).toBe(`/files/${jobId}/01_20-34-25.mp4`);
  });

  test("a nonexistent job returns 404", async () => {
    expect((await app.request("/api/jobs/naoexiste")).status).toBe(404);
  });
});

describe("GET /api/jobs/:id/events", () => {
  test("job already done: the first event already carries the final state", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/api/jobs/${jobId}/events`);
    const events = await readSSEEvents(res);

    expect(events.length).toBeGreaterThan(0);
    const first = events[0] as {
      status: string;
      clips: Array<{ url: string }>;
    };
    expect(first.status).toBe("done");
    expect(first.clips[0]?.url).toBe(`/files/${jobId}/01_20-34-25.mp4`);
  });

  test("connected mid-job, receives the final state once it finishes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Same as the default `render`, but only finishes once the test opens
    // the gate — simulates a job still "running" at the moment the SSE connects.
    const controlledRender = async (
      request: RenderRequest,
    ): Promise<RenderResult> => {
      const path = `${request.outDir}/01_20-34-25.mp4`;
      await Bun.write(path, "conteudo-do-video");
      const clip = {
        index: 0,
        timestamp: "2026-08-13T20:34:25",
        path,
        cameras: 2 as const,
      };
      request.onClip(clip);
      await gate;
      return { clips: [clip], merged: null, failed: [] };
    };

    const controlledStore = new JobStore({
      root,
      render: controlledRender,
      now: () => 0,
    });
    const controlledApp = createApp({
      fetchReplays: async () => REPLAYS,
      jobs: controlledStore,
      publicDir: "public",
    });

    const jobRes = await controlledApp.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: "four-play-3",
        date: "2026-08-13",
        hour: "20",
        replays: ["2026-08-13T20:34:25"],
        swap: true,
        concat: false,
      }),
    });
    const { jobId } = (await jobRes.json()) as { jobId: string };
    const job = controlledStore.get(jobId);
    expect(job?.status).toBe("running");

    const sseRes = await controlledApp.request(`/api/jobs/${jobId}/events`);

    // Only release the render once already connected to the stream: this is
    // the scenario that proves no update is lost on the running → done switch.
    release();
    const events = await readSSEEvents(sseRes);

    const last = events.at(-1) as {
      status: string;
      clips: Array<{ url: string }>;
    };
    expect(last.status).toBe("done");
    expect(last.clips).toHaveLength(1);
    expect(last.clips[0]?.url).toBe(`/files/${jobId}/01_20-34-25.mp4`);
  });
});

describe("GET /files/:id/:name", () => {
  test("serves the file inline by default", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4`);

    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toBe("conteudo-do-video");
  });

  test("with ?download=1 it responds as an attachment", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4?download=1`);

    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("responds 206 to a Range request", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4`, {
      headers: { range: "bytes=0-4" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/17");
  });

  test("a suffix range (bytes=-5) returns the last bytes, not the first 5", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4`, {
      headers: { range: "bytes=-5" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 12-16/17");
    // "conteudo-do-video" is 17 bytes; the last 5 are "video".
    expect(await res.text()).toBe("video");
  });

  test("refuses a name outside the job's clip list", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    expect((await app.request(`/files/${jobId}/segredo.mp4`)).status).toBe(404);
  });
});

describe("GET /api/jobs/:id/zip", () => {
  test("returns the zip as an attachment", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/api/jobs/${jobId}/zip`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("the zip for a nonexistent job returns 404", async () => {
    expect((await app.request("/api/jobs/naoexiste/zip")).status).toBe(404);
  });

  test("a request mid-job returns 409 and leaves no partial zip cached", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controlledRender = async (
      request: RenderRequest,
    ): Promise<RenderResult> => {
      const path = `${request.outDir}/01_20-34-25.mp4`;
      await Bun.write(path, "conteudo-do-video");
      const clip = {
        index: 0,
        timestamp: "2026-08-13T20:34:25",
        path,
        cameras: 2 as const,
      };
      request.onClip(clip);
      await gate;
      return { clips: [clip], merged: null, failed: [] };
    };

    const controlledStore = new JobStore({
      root,
      render: controlledRender,
      now: () => 0,
    });
    const controlledApp = createApp({
      fetchReplays: async () => REPLAYS,
      jobs: controlledStore,
      publicDir: "public",
    });

    const jobRes = await controlledApp.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: "four-play-3",
        date: "2026-08-13",
        hour: "20",
        replays: ["2026-08-13T20:34:25"],
        swap: true,
        concat: false,
      }),
    });
    const { jobId } = (await jobRes.json()) as { jobId: string };
    const job = controlledStore.get(jobId);
    if (!job) throw new Error("job não criado");

    // Wait for the clip to show up: proves the zip request arrives while the
    // job is "mid-flight" — already with partial content — and not before any clip exists.
    while (job.clips.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const midRes = await controlledApp.request(`/api/jobs/${jobId}/zip`);
    expect(midRes.status).toBe(409);
    const midBody = (await midRes.json()) as { error: string };
    expect(midBody.error).toContain("gerado");

    // Nothing was built or cached from the rejected request.
    expect(job.zipBuild).toBeNull();

    release();
    await job.done;

    const finalRes = await controlledApp.request(`/api/jobs/${jobId}/zip`);
    expect(finalRes.status).toBe(200);
    expect((await finalRes.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("two concurrent requests result in a single intact zip", async () => {
    const { jobId } = (await (await createJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const [res1, res2] = await Promise.all([
      app.request(`/api/jobs/${jobId}/zip`),
      app.request(`/api/jobs/${jobId}/zip`),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const bytes1 = new Uint8Array(await res1.arrayBuffer());
    const bytes2 = new Uint8Array(await res2.arrayBuffer());
    // Both responses came from the same final file, byte for byte — neither
    // one caught a half-finished write from the other.
    expect(bytes1).toEqual(bytes2);
    expect(bytes1.length).toBeGreaterThan(0);

    const file = join(root, "verificacao.zip");
    await Bun.write(file, bytes1);
    const proc = Bun.spawn(["unzip", "-t", file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  });
});

describe("app.onError", () => {
  test("ReplayBR API down returns a Portuguese message, not plain text", async () => {
    const unavailableApp = createApp({
      fetchReplays: async () => {
        throw new ReplayBrUnavailableError("timeout falando com a API");
      },
      jobs: store,
      publicDir: "public",
    });

    const res = await unavailableApp.request(
      "/api/replays?field=four-play-3&date=2026-08-13",
    );

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ReplayBR");
  });

  test("an unexpected error still becomes Portuguese JSON, not Hono's default 500", async () => {
    const brokenApp = createApp({
      fetchReplays: async () => {
        throw new Error("bug qualquer");
      },
      jobs: store,
      publicDir: "public",
    });

    const res = await brokenApp.request(
      "/api/replays?field=four-play-3&date=2026-08-13",
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("Internal Server Error");
  });
});
