import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Replay } from "../api.ts";
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
  camera1_url: `https://exemplo/${timestamp}/camera1.mp4`,
  camera2_url: `https://exemplo/${timestamp}/camera2.mp4`,
}));

let root: string;
let app: ReturnType<typeof createApp>;
let store: JobStore;

const render = async (request: RenderRequest): Promise<RenderResult> => {
  const path = `${request.outDir}/01_20-34-25.mp4`;
  // ASCII de propósito: o teste de Range afirma o tamanho exato em bytes.
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
  root = await mkdtemp(join(tmpdir(), "replaybr-rotas-"));
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

const criarJob = async (corpo: Record<string, unknown> = {}) =>
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
      ...corpo,
    }),
  });

/**
 * Lê um `Response` de SSE até o stream fechar e devolve o corpo (já
 * `JSON.parse`ado) de cada mensagem `data:`, na ordem em que chegaram.
 */
const lerEventosSSE = async (res: Response): Promise<unknown[]> => {
  const reader = res.body?.getReader();
  if (!reader) return [];

  const decoder = new TextDecoder();
  const eventos: unknown[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let fim: number;
    while ((fim = buffer.indexOf("\n\n")) !== -1) {
      const bloco = buffer.slice(0, fim);
      buffer = buffer.slice(fim + 2);
      const linha = bloco.split("\n").find((l) => l.startsWith("data: "));
      if (linha) eventos.push(JSON.parse(linha.slice("data: ".length)));
    }
  }

  return eventos;
};

describe("GET /api/fields", () => {
  test("lista as quadras com rótulo e swap padrão", async () => {
    const res = await app.request("/api/fields");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { slug: "placar-society", label: "Placar Society", defaultSwap: false },
      { slug: "four-play-3", label: "Four Play - Quadra 3", defaultSwap: true },
    ]);
  });
});

describe("GET /api/replays", () => {
  test("devolve o dia agrupado por hora", async () => {
    const res = await app.request("/api/replays?field=four-play-3&date=2026-08-13");
    const corpo = (await res.json()) as { hours: unknown[] };

    expect(res.status).toBe(200);
    expect(corpo.hours).toHaveLength(2);
    expect(corpo.hours[0]).toEqual({
      hour: "20",
      label: "20:00",
      anyTwoCameras: true,
      replays: [
        { timestamp: "2026-08-13T20:34:25", time: "20:34:25", cameras: 2 },
        { timestamp: "2026-08-13T20:35:39", time: "20:35:39", cameras: 2 },
      ],
    });
  });

  test("rejeita slug inválido", async () => {
    const res = await app.request("/api/replays?field=../etc&date=2026-08-13");
    expect(res.status).toBe(400);
  });

  test("rejeita data em formato errado", async () => {
    const res = await app.request("/api/replays?field=four-play-3&date=13-08-2026");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/jobs", () => {
  test("cria o job e devolve o id", async () => {
    const res = await criarJob();

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { jobId: unknown };
    expect(typeof corpo.jobId).toBe("string");
  });

  test("rejeita seleção vazia", async () => {
    expect((await criarJob({ replays: [] })).status).toBe(400);
  });

  test("rejeita hora inválida", async () => {
    expect((await criarJob({ hour: "99" })).status).toBe(400);
  });

  test("rejeita timestamp que não existe na hora pedida", async () => {
    expect((await criarJob({ replays: ["2026-08-13T23:00:00"] })).status).toBe(400);
  });

  test("rejeita corpo sem os campos obrigatórios", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ field: "four-play-3" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/jobs/:id", () => {
  test("devolve o estado do job", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/api/jobs/${jobId}`);
    const estado = (await res.json()) as {
      status: string;
      clips: Array<{ url: string }>;
    };

    expect(res.status).toBe(200);
    expect(estado.status).toBe("done");
    expect(estado.clips[0]?.url).toBe(`/files/${jobId}/01_20-34-25.mp4`);
  });

  test("job inexistente devolve 404", async () => {
    expect((await app.request("/api/jobs/naoexiste")).status).toBe(404);
  });
});

describe("GET /api/jobs/:id/events", () => {
  test("job já concluído: primeiro evento já traz o estado final", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/api/jobs/${jobId}/events`);
    const eventos = await lerEventosSSE(res);

    expect(eventos.length).toBeGreaterThan(0);
    const primeiro = eventos[0] as {
      status: string;
      clips: Array<{ url: string }>;
    };
    expect(primeiro.status).toBe("done");
    expect(primeiro.clips[0]?.url).toBe(`/files/${jobId}/01_20-34-25.mp4`);
  });

  test("conectado no meio do job, recebe o estado final quando ele termina", async () => {
    let liberar: () => void = () => {};
    const portao = new Promise<void>((resolve) => {
      liberar = resolve;
    });

    // Igual ao `render` padrão, mas só termina quando o teste liberar o
    // portão — simula um job ainda "running" no momento em que o SSE conecta.
    const renderControlado = async (
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
      await portao;
      return { clips: [clip], merged: null, failed: [] };
    };

    const storeControlado = new JobStore({
      root,
      render: renderControlado,
      now: () => 0,
    });
    const appControlado = createApp({
      fetchReplays: async () => REPLAYS,
      jobs: storeControlado,
      publicDir: "public",
    });

    const jobRes = await appControlado.request("/api/jobs", {
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
    const job = storeControlado.get(jobId);
    expect(job?.status).toBe("running");

    const sseRes = await appControlado.request(`/api/jobs/${jobId}/events`);

    // Solta o render só depois de já estar conectado ao stream: é o cenário
    // que prova que nenhuma atualização se perde na virada running → done.
    liberar();
    const eventos = await lerEventosSSE(sseRes);

    const ultimo = eventos.at(-1) as {
      status: string;
      clips: Array<{ url: string }>;
    };
    expect(ultimo.status).toBe("done");
    expect(ultimo.clips).toHaveLength(1);
    expect(ultimo.clips[0]?.url).toBe(`/files/${jobId}/01_20-34-25.mp4`);
  });
});

describe("GET /files/:id/:name", () => {
  test("serve o arquivo inline por padrão", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4`);

    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toBe("conteudo-do-video");
  });

  test("com ?download=1 responde como anexo", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4?download=1`);

    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("responde 206 a um Range", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4`, {
      headers: { range: "bytes=0-4" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/17");
  });

  test("range de sufixo (bytes=-5) devolve os últimos bytes, não os 5 primeiros", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/files/${jobId}/01_20-34-25.mp4`, {
      headers: { range: "bytes=-5" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 12-16/17");
    // "conteudo-do-video" tem 17 bytes; os últimos 5 são "video".
    expect(await res.text()).toBe("video");
  });

  test("recusa nome fora da lista de clipes do job", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    expect((await app.request(`/files/${jobId}/segredo.mp4`)).status).toBe(404);
  });
});

describe("GET /api/jobs/:id/zip", () => {
  test("devolve o zip como anexo", async () => {
    const { jobId } = (await (await criarJob()).json()) as { jobId: string };
    await store.get(jobId)?.done;

    const res = await app.request(`/api/jobs/${jobId}/zip`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  test("zip de job inexistente devolve 404", async () => {
    expect((await app.request("/api/jobs/naoexiste/zip")).status).toBe(404);
  });
});
