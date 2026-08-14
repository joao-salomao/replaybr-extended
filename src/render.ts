import { rm } from "node:fs/promises";
import type { Replay } from "./api.ts";
import { downloadReplayPairs, type ReplayPair } from "./download.ts";
import {
  concatClips,
  probeDimensions,
  probeDuration,
  renderClip,
  type Dimensions,
} from "./ffmpeg.ts";

export interface RenderProgress {
  phase: "download" | "render" | "concat";
  done: number;
  total: number;
}

export interface Clip {
  /** Posição cronológica, atribuída antes de qualquer download. */
  index: number;
  timestamp: string;
  path: string;
  cameras: 1 | 2;
}

export interface RenderFailure {
  timestamp: string;
  error: string;
}

export interface RenderResult {
  /** Em ordem cronológica. */
  clips: Clip[];
  merged: { path: string; duration: number } | null;
  failed: RenderFailure[];
}

/** Costura para os testes: permite exercitar o pipeline sem ffmpeg real. */
export interface RenderDeps {
  downloadReplayPairs: typeof downloadReplayPairs;
  probeDimensions: typeof probeDimensions;
  renderClip: typeof renderClip;
  concatClips: typeof concatClips;
  probeDuration: typeof probeDuration;
  removePaths: (paths: string[]) => Promise<void>;
}

export const defaultRenderDeps: RenderDeps = {
  downloadReplayPairs,
  probeDimensions,
  renderClip,
  concatClips,
  probeDuration,
  removePaths: async (paths) => {
    for (const path of paths) await rm(path, { force: true });
  },
};

export interface RenderRequest {
  replays: Replay[];
  rawDir: string;
  outDir: string;
  swap: boolean;
  concat: boolean;
  fps: number;
  crf: number;
  preset: string;
  concurrency: number;
  onProgress: (progress: RenderProgress) => void;
  onClip: (clip: Clip) => void;
  deps?: RenderDeps;
}

const mensagem = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Baixa e renderiza os lances, um vídeo por lance.
 *
 * Cada lance é renderizado assim que seus arquivos terminam de baixar, enquanto
 * os próximos ainda baixam — o primeiro clipe fica pronto em segundos, e o
 * bruto some logo depois, mantendo o pico de disco baixo.
 *
 * A renderização é serializada por uma corrente de promessas: dois ffmpeg ao
 * mesmo tempo só disputariam a mesma CPU.
 */
export async function renderReplays({
  replays,
  rawDir,
  outDir,
  swap,
  concat,
  fps,
  crf,
  preset,
  concurrency,
  onProgress,
  onClip,
  deps = defaultRenderDeps,
}: RenderRequest): Promise<RenderResult> {
  // O índice cronológico é fixado aqui, antes de qualquer download, para que o
  // nome do arquivo não dependa da ordem em que os downloads terminam.
  const ordenados = [...replays].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  const total = ordenados.length;
  // Basta a listagem para saber se o quadro é duplo: nada precisa ser baixado.
  const columns = ordenados.some((replay) => replay.camera2_url) ? 2 : 1;

  const clips: Clip[] = [];
  const failed: RenderFailure[] = [];
  let cell: Dimensions | null = null;
  let renderizados = 0;
  let corrente: Promise<void> = Promise.resolve();

  const renderizarPar = async (pair: ReplayPair): Promise<void> => {
    const primeira = pair.cameras[0];
    if (!primeira) return;

    // Todos os clipes da hora precisam sair do mesmo tamanho, senão o concat
    // sem recodificar deixa de valer. O primeiro arquivo define a medida.
    const medida = (cell ??= await deps.probeDimensions(primeira));

    const numero = String(pair.index + 1).padStart(2, "0");
    const relogio = pair.timestamp.slice(11).replaceAll(":", "-");
    const path = `${outDir}/${numero}_${relogio}.mp4`;

    const sources = swap ? [...pair.cameras].reverse() : pair.cameras;
    await deps.renderClip({
      sources,
      output: path,
      cell: medida,
      columns,
      fps,
      crf,
      preset,
    });
    await deps.removePaths(pair.cameras);

    const clip: Clip = {
      index: pair.index,
      timestamp: pair.timestamp,
      path,
      cameras: pair.cameras.length >= 2 ? 2 : 1,
    };
    clips.push(clip);
    renderizados++;
    onClip(clip);
    onProgress({ phase: "render", done: renderizados, total });
  };

  await deps.downloadReplayPairs(ordenados, rawDir, {
    concurrency,
    onProgress: ({ done, total: arquivos }) =>
      onProgress({ phase: "download", done, total: arquivos }),
    onPair: (pair) => {
      corrente = corrente
        .then(() => renderizarPar(pair))
        .catch((error: unknown) => {
          failed.push({ timestamp: pair.timestamp, error: mensagem(error) });
        });
    },
    onPairError: ({ timestamp, error }) => failed.push({ timestamp, error }),
  });
  await corrente;

  clips.sort((a, b) => a.index - b.index);

  let merged: RenderResult["merged"] = null;
  if (concat && clips.length > 0) {
    onProgress({ phase: "concat", done: 0, total: 1 });
    const path = `${outDir}/completo.mp4`;
    await deps.concatClips(
      clips.map((clip) => clip.path),
      path,
      rawDir,
    );
    merged = { path, duration: await deps.probeDuration(path) };
    onProgress({ phase: "concat", done: 1, total: 1 });
  }

  return { clips, merged, failed };
}
