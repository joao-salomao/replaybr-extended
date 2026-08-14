import { stat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Replay } from "./api.ts";

export interface DownloadJob {
  /** Índice do replay ao qual este arquivo pertence. */
  index: number;
  replay: Replay;
  camera: 1 | 2;
  url: string;
  path: string;
}

export interface DownloadResult {
  /** `true` quando o arquivo já existia e o download foi reaproveitado. */
  skipped: boolean;
  bytes: number;
}

export interface DownloadProgress extends DownloadResult {
  done: number;
  total: number;
  job: DownloadJob;
}

/** Um replay com seus arquivos locais já baixados. */
export interface ReplayPair {
  index: number;
  timestamp: string;
  /** Uma ou duas câmeras, na ordem. */
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
  /** Tentativas extras por arquivo. Padrão 2, ou seja, 3 no total. */
  retries?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Chamado quando todos os arquivos de um lance terminam, na ordem de conclusão. */
  onPair?: (pair: ReplayPair) => void;
  /** Chamado uma vez por lance que perdeu algum arquivo. */
  onPairError?: (failure: DownloadFailure) => void;
}

/** Roda `worker` sobre `items` com no máximo `limit` em paralelo, preservando a ordem. */
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
  // Retomada barata: se o arquivo já existe e não está vazio, não baixa de novo.
  const existing = await fileSize(destination);
  if (existing > 0) return { skipped: true, bytes: existing };

  const res = await fetch(url);
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
 * Baixa camera1 e camera2 de cada replay para `rawDir`, avisando por `onPair`
 * assim que cada lance fica completo — o que permite renderizar um lance
 * enquanto os próximos ainda baixam.
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
    // A segunda câmera é opcional e varia por lance, não só por campo.
    if (replay.camera2_url) urls.push([2, replay.camera2_url]);

    return urls.map(([camera, url]) => ({
      index,
      replay,
      camera,
      url,
      path: `${rawDir}/${prefix}_camera${camera}.mp4`,
    }));
  });

  // Quantos arquivos ainda faltam para cada lance ficar completo.
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
      // Um lance com duas câmeras pode falhar duas vezes; só reportamos uma.
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
