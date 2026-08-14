import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Replay } from "../api.ts";
import type { RenderRequest, RenderResult } from "../render.ts";
import { JobStore, RUNNING_CEILING_MS, TTL_MS, type JobState } from "./jobs.ts";

const replay = (timestamp: string): Replay => ({
  timestamp,
  camera1_url: `https://example/${timestamp}/camera1.mp4`,
  camera2_url: `https://example/${timestamp}/camera2.mp4`,
});

const INPUT = {
  field: "four-play-3",
  fieldLabel: "Four Play - Quadra 3",
  date: "2026-08-13",
  hour: "20",
  replays: [replay("2026-08-13T20:34:25"), replay("2026-08-13T20:35:39")],
  swap: true,
  concat: false,
};

let root: string;
let counter: number;

/** Generates predictable ids for the tests. */
const newId = () => `job${counter++}`;

const succeed = async (request: RenderRequest): Promise<RenderResult> => {
  const clip = {
    index: 0,
    timestamp: "2026-08-13T20:34:25",
    path: `${request.outDir}/01_20-34-25.mp4`,
    cameras: 2 as const,
  };
  request.onProgress({ phase: "render", done: 1, total: 1 });
  request.onClip(clip);
  return { clips: [clip], merged: null, failed: [] };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "replaybr-jobs-"));
  counter = 1;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("JobStore.create", () => {
  test("the job starts running with no expiration deadline", async () => {
    const store = new JobStore({ root, render: () => new Promise<RenderResult>(() => {}), newId, now: () => 0 });
    const job = store.create(INPUT);

    const state = store.serialize(job);
    expect(state.status).toBe("running");
    expect(state.expiresAt).toBeNull();
  });

  test("once finished it becomes done and gets a 2h deadline", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 1_000 });
    const job = store.create(INPUT);
    await job.done;

    const state = store.serialize(job);
    expect(state.status).toBe("done");
    expect(state.expiresAt).toBe(new Date(1_000 + TTL_MS).toISOString());
  });

  test("exposes the clips as servable URLs", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 0 });
    const job = store.create(INPUT);
    await job.done;

    expect(store.serialize(job).clips).toEqual([
      { index: 0, time: "20:34:25", cameras: 2, url: "/files/job1/01_20-34-25.mp4" },
    ]);
  });

  test("passes through the options and hour identification", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 0 });
    const state = store.serialize(store.create(INPUT));

    expect(state.field).toBe("four-play-3");
    expect(state.fieldLabel).toBe("Four Play - Quadra 3");
    expect(state.hour).toBe("20");
    expect(state.options).toEqual({ swap: true, concat: false });
  });

  test("a rendering error leaves the job in error", async () => {
    const store = new JobStore({
      root,
      render: async () => { throw new Error("ffmpeg sumiu"); },
      newId,
      now: () => 0,
    });
    const job = store.create(INPUT);
    await job.done;

    const state = store.serialize(job);
    expect(state.status).toBe("error");
    expect(state.error).toBe("ffmpeg sumiu");
  });

  test("no clip generated is an error, not an empty success", async () => {
    const store = new JobStore({
      root,
      render: async () => ({
        clips: [],
        merged: null,
        failed: [{ timestamp: "2026-08-13T20:34:25", error: "network down" }],
      }),
      newId,
      now: () => 0,
    });
    const job = store.create(INPUT);
    await job.done;

    expect(store.serialize(job).status).toBe("error");
  });

  test("plays that failed show up in the state without bringing the job down", async () => {
    const store = new JobStore({
      root,
      render: async (request) => {
        const clip = {
          index: 0,
          timestamp: "2026-08-13T20:34:25",
          path: `${request.outDir}/01_20-34-25.mp4`,
          cameras: 2 as const,
        };
        request.onClip(clip);
        return {
          clips: [clip],
          merged: null,
          failed: [{ timestamp: "2026-08-13T20:35:39", error: "network down" }],
        };
      },
      newId,
      now: () => 0,
    });
    const job = store.create(INPUT);
    await job.done;

    const state = store.serialize(job);
    expect(state.status).toBe("done");
    expect(state.failed).toEqual([{ time: "20:35:39", error: "network down" }]);
  });
});

describe("JobStore.create — ids", () => {
  test("the default generated id has 12+ hex characters", () => {
    const store = new JobStore({ root, render: succeed, now: () => 0 });
    const job = store.create(INPUT);

    expect(job.id).toMatch(/^[0-9a-f]{12,}$/);
  });

  test("resamples the id when it collides with an existing job", () => {
    const ids = ["repeated", "repeated", "unique"];
    let calls = 0;
    const store = new JobStore({
      root,
      render: succeed,
      newId: () => ids[calls++] ?? "leftover",
      now: () => 0,
    });

    const job1 = store.create(INPUT);
    expect(job1.id).toBe("repeated");

    // The second newId() call repeats "repeated": create() needs to notice
    // the collision and ask for another id instead of replacing job1 in the map.
    const job2 = store.create(INPUT);
    expect(job2.id).toBe("unique");
    expect(store.get("repeated")).toBe(job1);
    expect(store.get("unique")).toBe(job2);
  });
});

describe("JobStore.subscribe", () => {
  test("notifies on every progress update and when it finishes", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 0 });
    const job = store.create(INPUT);
    const states: JobState[] = [];
    store.subscribe(job.id, (state) => states.push(state));
    await job.done;

    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states.at(-1)?.status).toBe("done");
  });

  test("unsubscribing stops the notifications", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 0 });
    const job = store.create(INPUT);
    const states: JobState[] = [];
    const unsubscribe = store.subscribe(job.id, (state) => states.push(state));
    unsubscribe();
    await job.done;

    expect(states).toEqual([]);
  });

  test("a listener that throws doesn't bring down the others or the job", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 0 });
    const job = store.create(INPUT);
    const states: JobState[] = [];

    store.subscribe(job.id, () => {
      throw new Error("broken listener");
    });
    store.subscribe(job.id, (state) => states.push(state));

    // If `notify` let the exception escape, `job.done` would reject
    // (unhandled rejection) and this `await` would throw.
    await job.done;

    expect(states.at(-1)?.status).toBe("done");
  });
});

describe("JobStore.sweep", () => {
  test("removes only expired jobs, and deletes the directory", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 0 });
    const job = store.create(INPUT);
    await job.done;
    await mkdir(job.dir, { recursive: true });

    expect(await store.sweep(TTL_MS - 1)).toEqual([]);
    expect(store.get(job.id)).toBeDefined();

    expect(await store.sweep(TTL_MS + 1)).toEqual([job.id]);
    expect(store.get(job.id)).toBeUndefined();
    expect(await readdir(root)).not.toContain(job.id);
  });

  test("never removes a job in progress", async () => {
    const store = new JobStore({ root, render: () => new Promise<RenderResult>(() => {}), newId, now: () => 0 });
    const job = store.create(INPUT);

    expect(await store.sweep(TTL_MS * 10)).toEqual([]);
    expect(store.get(job.id)).toBeDefined();
  });

  test("a job stuck running past the ceiling becomes error, and disappears on a later pass", async () => {
    let currentTime = 0;
    const store = new JobStore({
      root,
      render: () => new Promise<RenderResult>(() => {}),
      newId,
      now: () => currentTime,
    });
    const job = store.create(INPUT);
    await mkdir(job.dir, { recursive: true });

    // Still within the ceiling: keeps running.
    currentTime = RUNNING_CEILING_MS - 1;
    expect(await store.sweep(currentTime)).toEqual([]);
    expect(store.get(job.id)?.status).toBe("running");

    // Past the ceiling: becomes error, but still isn't removed — it only
    // just got `finishedAt`, and the TTL counts from there.
    currentTime = RUNNING_CEILING_MS + 1;
    expect(await store.sweep(currentTime)).toEqual([]);
    const marked = store.get(job.id);
    expect(marked?.status).toBe("error");
    expect(marked?.finishedAt).toBe(currentTime);
    expect(marked?.error).toBeTruthy();

    // Only after the TTL counted from the marking does the directory disappear.
    currentTime = RUNNING_CEILING_MS + 1 + TTL_MS + 1;
    expect(await store.sweep(currentTime)).toEqual([job.id]);
    expect(store.get(job.id)).toBeUndefined();
  });

  test("keeps sweeping even if one job can't be removed", async () => {
    const store = new JobStore({ root, render: succeed, newId, now: () => 0 });
    const job1 = store.create(INPUT);
    const job2 = store.create({ ...INPUT, hour: "21" });
    await job1.done;
    await job2.done;

    // Create the directories to simulate completed jobs.
    await mkdir(job1.dir, { recursive: true });
    await mkdir(job2.dir, { recursive: true });

    // Strip write permission from the first job's directory to force the
    // removal to fail. Use a permission that disallows deletion (chmod 000).
    await chmod(job1.dir, 0o000);

    try {
      // Sweep with time past the TTL.
      const removed = await store.sweep(TTL_MS + 1);

      // The second job should be removed even if the first one fails.
      expect(removed).toContain(job2.id);
      expect(removed).not.toContain(job1.id);

      // The first job should stay in the map (not removed).
      expect(store.get(job1.id)).toBeDefined();
      // The second job was removed successfully.
      expect(store.get(job2.id)).toBeUndefined();
    } finally {
      // Cleanup: restore permissions so afterEach can delete it.
      await chmod(job1.dir, 0o755);
    }
  });
});
