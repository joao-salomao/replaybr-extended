import { stat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Replay } from "./api.ts";

/**
 * Ceiling per download attempt of a file. Bun's `fetch` has no default
 * timeout: a CDN that sends headers and then hangs the body would keep
 * `Bun.write(destination, res)` stuck forever, without `withRetry` noticing
 * it — it only reacts to rejections, not hangs. Generous enough for a ~7 MB
 * file on a bad connection (at ~300 kbps that takes a bit over 3 min);
 * beyond that it's more likely stuck than just slow.
 */
export const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

export interface DownloadJob {
  /** Index of the replay this file belongs to. */
  index: number;
  replay: Replay;
  camera: 1 | 2;
  url: string;
  path: string;
}

export interface DownloadResult {
  /** `true` when the file already existed and the download was reused. */
  skipped: boolean;
  bytes: number;
}

export interface DownloadProgress extends DownloadResult {
  done: number;
  total: number;
  job: DownloadJob;
}

/** A replay with its local files already downloaded. */
export interface ReplayPair {
  index: number;
  timestamp: string;
  /** One or two cameras, in order. */
  cameras: string[];
}

export interface DownloadFailure {
  index: number;
  timestamp: string;
  error: string;
}

export interface DownloadOutcome {
  pairs: ReplayPair[];
  failed: DownloadFailure[];
}

export interface DownloadOptions {
  concurrency?: number;
  /** Extra attempts per file. Defaults to 2, i.e. 3 total. */
  retries?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Called once all files of a play finish, in completion order. */
  onPair?: (pair: ReplayPair) => void;
  /** Called once per play that lost some file. */
  onPairError?: (failure: DownloadFailure) => void;
}

/** Runs `worker` over `items` with at most `limit` in parallel, preserving order. */
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await worker(item, index);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function downloadFile(
  url: string,
  destination: string,
): Promise<DownloadResult> {
  // Cheap resume: if the file already exists and isn't empty, skip re-downloading it.
  const existing = await fileSize(destination);
  if (existing > 0) return { skipped: true, bytes: existing };

  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Download falhou (${res.status}) para ${url}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const bytes = await Bun.write(destination, res);
  return { skipped: false, bytes };
}

async function withRetry<T>(
  operation: () => Promise<T>,
  retries: number,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function pairFor(replay: Replay, index: number, rawDir: string): ReplayPair {
  const prefix = prefixFor(index);
  const cameras = [`${rawDir}/${prefix}_camera1.mp4`];
  if (replay.camera2_url) cameras.push(`${rawDir}/${prefix}_camera2.mp4`);

  return { index, timestamp: replay.timestamp, cameras };
}

const prefixFor = (index: number): string => String(index + 1).padStart(2, "0");

/**
 * Downloads camera1 and camera2 for each replay into `rawDir`, notifying via
 * `onPair` as soon as each play becomes complete — which lets a play be
 * rendered while the next ones are still downloading.
 */
export async function downloadReplayPairs(
  replays: Replay[],
  rawDir: string,
  {
    concurrency = 4,
    retries = 2,
    onProgress,
    onPair,
    onPairError,
  }: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const jobs: DownloadJob[] = replays.flatMap((replay, index) => {
    const prefix = prefixFor(index);
    const urls: Array<[1 | 2, string]> = [[1, replay.camera1_url]];
    // The second camera is optional and varies per play, not just per field.
    if (replay.camera2_url) urls.push([2, replay.camera2_url]);

    return urls.map(([camera, url]) => ({
      index,
      replay,
      camera,
      url,
      path: `${rawDir}/${prefix}_camera${camera}.mp4`,
    }));
  });

  // How many files are still missing for each play to become complete.
  const remaining = new Map<number, number>();
  for (const job of jobs) {
    remaining.set(job.index, (remaining.get(job.index) ?? 0) + 1);
  }

  const pairs: ReplayPair[] = [];
  const failed: DownloadFailure[] = [];
  const broken = new Set<number>();
  let done = 0;

  await withConcurrency(jobs, concurrency, async (job) => {
    try {
      const result = await withRetry(
        () => downloadFile(job.url, job.path),
        retries,
      );
      done++;
      onProgress?.({ done, total: jobs.length, job, ...result });
    } catch (error) {
      done++;
      // A play with two cameras can fail twice; we only report it once.
      if (!broken.has(job.index)) {
        broken.add(job.index);
        const failure: DownloadFailure = {
          index: job.index,
          timestamp: job.replay.timestamp,
          error: error instanceof Error ? error.message : String(error),
        };
        failed.push(failure);
        onPairError?.(failure);
      }
    }

    const left = (remaining.get(job.index) ?? 1) - 1;
    remaining.set(job.index, left);

    if (left === 0 && !broken.has(job.index)) {
      const pair = pairFor(job.replay, job.index, rawDir);
      pairs.push(pair);
      onPair?.(pair);
    }
  });

  return { pairs, failed };
}
