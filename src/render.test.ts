import { describe, expect, test } from "bun:test";
import type { Replay } from "./api.ts";
import type { ReplayPair } from "./download.ts";
import { renderReplays, type Clip, type RenderDeps } from "./render.ts";

const replay = (timestamp: string, cameras: 1 | 2): Replay => ({
  timestamp,
  camera1_url: `https://exemplo/${timestamp}/camera1.mp4`,
  ...(cameras === 2
    ? { camera2_url: `https://exemplo/${timestamp}/camera2.mp4` }
    : {}),
});

interface Espiao {
  deps: RenderDeps;
  renderizados: Array<{ sources: string[]; output: string; columns: number }>;
  apagados: string[][];
  concatenados: string[][];
}

/**
 * Deps falsos. `ordem` define em que sequência os pares são entregues,
 * por índice — é assim que simulamos downloads terminando fora de ordem.
 */
function espiao(ordem: number[], falhas: string[] = []): Espiao {
  const renderizados: Espiao["renderizados"] = [];
  const apagados: string[][] = [];
  const concatenados: string[][] = [];

  const deps: RenderDeps = {
    downloadReplayPairs: async (replays, rawDir, options) => {
      const pairs: ReplayPair[] = [];
      for (const index of ordem) {
        const alvo = replays[index];
        if (!alvo) continue;
        const cameras = [`${rawDir}/cam1-${index}.mp4`];
        if (alvo.camera2_url) cameras.push(`${rawDir}/cam2-${index}.mp4`);
        const pair: ReplayPair = { index, timestamp: alvo.timestamp, cameras };
        pairs.push(pair);
        options?.onPair?.(pair);
      }
      for (const timestamp of falhas) {
        options?.onPairError?.({ index: -1, timestamp, error: "rede caiu" });
      }
      return { pairs, failed: [] };
    },
    probeDimensions: async () => ({ width: 704, height: 560 }),
    renderClip: async ({ sources, output, columns }) => {
      renderizados.push({ sources, output, columns });
      return output;
    },
    concatClips: async (clips, output) => {
      concatenados.push(clips);
      return output;
    },
    probeDuration: async () => 42,
    removePaths: async (paths) => {
      apagados.push(paths);
    },
  };

  return { deps, renderizados, apagados, concatenados };
}

const pedido = (replays: Replay[], deps: RenderDeps, extra = {}) => ({
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

const TRES = [
  replay("2026-08-13T20:34:25", 2),
  replay("2026-08-13T20:35:39", 2),
  replay("2026-08-13T20:48:28", 2),
];

describe("renderReplays", () => {
  test("devolve os clipes em ordem cronológica mesmo baixando fora de ordem", async () => {
    const { deps } = espiao([2, 0, 1]);

    const result = await renderReplays(pedido(TRES, deps));

    expect(result.clips.map((c) => c.timestamp)).toEqual([
      "2026-08-13T20:34:25",
      "2026-08-13T20:35:39",
      "2026-08-13T20:48:28",
    ]);
  });

  test("numera o arquivo pela posição cronológica, não pela ordem de conclusão", async () => {
    const { deps, renderizados } = espiao([2, 0, 1]);

    await renderReplays(pedido(TRES, deps));

    // O primeiro a ser renderizado é o índice 2, que é o terceiro do dia.
    expect(renderizados[0]?.output).toBe("/tmp/out/03_20-48-28.mp4");
    expect(renderizados[1]?.output).toBe("/tmp/out/01_20-34-25.mp4");
  });

  test("apaga o bruto de cada lance logo após renderizá-lo", async () => {
    const { deps, apagados } = espiao([0, 1, 2]);

    await renderReplays(pedido(TRES, deps));

    expect(apagados).toHaveLength(3);
    expect(apagados[0]).toEqual(["/tmp/raw/cam1-0.mp4", "/tmp/raw/cam2-0.mp4"]);
  });

  test("swap inverte a ordem das câmeras", async () => {
    const { deps, renderizados } = espiao([0]);

    await renderReplays(pedido([TRES[0]!], deps, { swap: true }));

    expect(renderizados[0]?.sources).toEqual([
      "/tmp/raw/cam2-0.mp4",
      "/tmp/raw/cam1-0.mp4",
    ]);
  });

  test("usa quadro duplo quando algum lance da hora tem segunda câmera", async () => {
    const misto = [replay("2026-08-13T20:34:25", 1), replay("2026-08-13T20:35:39", 2)];
    const { deps, renderizados } = espiao([0, 1]);

    await renderReplays(pedido(misto, deps));

    expect(renderizados.map((r) => r.columns)).toEqual([2, 2]);
  });

  test("usa quadro simples quando nenhum lance tem segunda câmera", async () => {
    const { deps, renderizados } = espiao([0]);

    await renderReplays(pedido([replay("2026-08-13T20:34:25", 1)], deps));

    expect(renderizados[0]?.columns).toBe(1);
  });

  test("concat monta o vídeo único com os clipes em ordem", async () => {
    const { deps, concatenados } = espiao([2, 0, 1]);

    const result = await renderReplays(pedido(TRES, deps, { concat: true }));

    expect(concatenados[0]).toEqual([
      "/tmp/out/01_20-34-25.mp4",
      "/tmp/out/02_20-35-39.mp4",
      "/tmp/out/03_20-48-28.mp4",
    ]);
    expect(result.merged).toEqual({ path: "/tmp/out/completo.mp4", duration: 42 });
  });

  test("sem concat não produz vídeo único", async () => {
    const { deps, concatenados } = espiao([0]);

    const result = await renderReplays(pedido([TRES[0]!], deps));

    expect(concatenados).toEqual([]);
    expect(result.merged).toBeNull();
  });

  test("lance que falhou no download entra em failed sem parar o resto", async () => {
    const { deps } = espiao([0, 1], ["2026-08-13T20:48:28"]);

    const result = await renderReplays(pedido(TRES, deps));

    expect(result.clips).toHaveLength(2);
    expect(result.failed).toEqual([
      { timestamp: "2026-08-13T20:48:28", error: "rede caiu" },
    ]);
  });

  test("lance que falhou na renderização entra em failed sem parar o resto", async () => {
    const { deps } = espiao([0, 1, 2]);
    const original = deps.renderClip;
    deps.renderClip = async (options) => {
      if (options.output.includes("02_")) throw new Error("ffmpeg quebrou");
      return original(options);
    };

    const result = await renderReplays(pedido(TRES, deps));

    expect(result.clips).toHaveLength(2);
    expect(result.failed[0]?.error).toBe("ffmpeg quebrou");
  });

  test("emite progresso das fases", async () => {
    const { deps } = espiao([0, 1, 2]);
    const fases: string[] = [];

    await renderReplays(
      pedido(TRES, deps, {
        concat: true,
        onProgress: (p: { phase: string }) => fases.push(p.phase),
      }),
    );

    expect(fases).toContain("render");
    expect(fases).toContain("concat");
  });

  test("chama onClip conforme cada clipe fica pronto", async () => {
    const { deps } = espiao([2, 0, 1]);
    const vistos: Clip[] = [];

    await renderReplays(pedido(TRES, deps, { onClip: (c: Clip) => vistos.push(c) }));

    // onClip segue a ordem de conclusão, não a cronológica.
    expect(vistos.map((c) => c.index)).toEqual([2, 0, 1]);
  });
});
