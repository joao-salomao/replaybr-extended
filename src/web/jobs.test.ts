import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Replay } from "../api.ts";
import type { RenderRequest, RenderResult } from "../render.ts";
import { JobStore, RUNNING_CEILING_MS, TTL_MS, type JobState } from "./jobs.ts";

const replay = (timestamp: string): Replay => ({
  timestamp,
  camera1_url: `https://exemplo/${timestamp}/camera1.mp4`,
  camera2_url: `https://exemplo/${timestamp}/camera2.mp4`,
});

const ENTRADA = {
  field: "four-play-3",
  fieldLabel: "Four Play - Quadra 3",
  date: "2026-08-13",
  hour: "20",
  replays: [replay("2026-08-13T20:34:25"), replay("2026-08-13T20:35:39")],
  swap: true,
  concat: false,
};

let root: string;
let contador: number;

/** Gera ids previsíveis para os testes. */
const newId = () => `job${contador++}`;

const sucesso = async (request: RenderRequest): Promise<RenderResult> => {
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
  contador = 1;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("JobStore.create", () => {
  test("o job nasce em running e sem prazo de expiração", async () => {
    const store = new JobStore({ root, render: () => new Promise<RenderResult>(() => {}), newId, now: () => 0 });
    const job = store.create(ENTRADA);

    const estado = store.serialize(job);
    expect(estado.status).toBe("running");
    expect(estado.expiresAt).toBeNull();
  });

  test("ao terminar vira done e ganha prazo de 2h", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 1_000 });
    const job = store.create(ENTRADA);
    await job.done;

    const estado = store.serialize(job);
    expect(estado.status).toBe("done");
    expect(estado.expiresAt).toBe(new Date(1_000 + TTL_MS).toISOString());
  });

  test("expõe os clipes como URLs servíveis", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 0 });
    const job = store.create(ENTRADA);
    await job.done;

    expect(store.serialize(job).clips).toEqual([
      { index: 0, time: "20:34:25", cameras: 2, url: "/files/job1/01_20-34-25.mp4" },
    ]);
  });

  test("repassa as opções e a identificação da hora", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 0 });
    const estado = store.serialize(store.create(ENTRADA));

    expect(estado.field).toBe("four-play-3");
    expect(estado.fieldLabel).toBe("Four Play - Quadra 3");
    expect(estado.hour).toBe("20");
    expect(estado.options).toEqual({ swap: true, concat: false });
  });

  test("erro na renderização deixa o job em error", async () => {
    const store = new JobStore({
      root,
      render: async () => { throw new Error("ffmpeg sumiu"); },
      newId,
      now: () => 0,
    });
    const job = store.create(ENTRADA);
    await job.done;

    const estado = store.serialize(job);
    expect(estado.status).toBe("error");
    expect(estado.error).toBe("ffmpeg sumiu");
  });

  test("nenhum clipe gerado é erro, não sucesso vazio", async () => {
    const store = new JobStore({
      root,
      render: async () => ({
        clips: [],
        merged: null,
        failed: [{ timestamp: "2026-08-13T20:34:25", error: "rede caiu" }],
      }),
      newId,
      now: () => 0,
    });
    const job = store.create(ENTRADA);
    await job.done;

    expect(store.serialize(job).status).toBe("error");
  });

  test("lances que falharam aparecem no estado sem derrubar o job", async () => {
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
          failed: [{ timestamp: "2026-08-13T20:35:39", error: "rede caiu" }],
        };
      },
      newId,
      now: () => 0,
    });
    const job = store.create(ENTRADA);
    await job.done;

    const estado = store.serialize(job);
    expect(estado.status).toBe("done");
    expect(estado.failed).toEqual([{ time: "20:35:39", error: "rede caiu" }]);
  });
});

describe("JobStore.create — ids", () => {
  test("o id gerado por padrão tem 12+ caracteres hexadecimais", () => {
    const store = new JobStore({ root, render: sucesso, now: () => 0 });
    const job = store.create(ENTRADA);

    expect(job.id).toMatch(/^[0-9a-f]{12,}$/);
  });

  test("reamostra o id quando ele colide com um job já existente", () => {
    const ids = ["repetido", "repetido", "unico"];
    let chamadas = 0;
    const store = new JobStore({
      root,
      render: sucesso,
      newId: () => ids[chamadas++] ?? "sobra",
      now: () => 0,
    });

    const job1 = store.create(ENTRADA);
    expect(job1.id).toBe("repetido");

    // A segunda chamada de newId() repete "repetido": create() precisa
    // perceber a colisão e pedir outro id em vez de substituir job1 no mapa.
    const job2 = store.create(ENTRADA);
    expect(job2.id).toBe("unico");
    expect(store.get("repetido")).toBe(job1);
    expect(store.get("unico")).toBe(job2);
  });
});

describe("JobStore.subscribe", () => {
  test("notifica a cada progresso e ao terminar", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 0 });
    const job = store.create(ENTRADA);
    const estados: JobState[] = [];
    store.subscribe(job.id, (estado) => estados.push(estado));
    await job.done;

    expect(estados.length).toBeGreaterThanOrEqual(2);
    expect(estados.at(-1)?.status).toBe("done");
  });

  test("cancelar a inscrição para as notificações", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 0 });
    const job = store.create(ENTRADA);
    const estados: JobState[] = [];
    const cancelar = store.subscribe(job.id, (estado) => estados.push(estado));
    cancelar();
    await job.done;

    expect(estados).toEqual([]);
  });

  test("um listener que lança não derruba os demais nem o job", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 0 });
    const job = store.create(ENTRADA);
    const estados: JobState[] = [];

    store.subscribe(job.id, () => {
      throw new Error("listener quebrado");
    });
    store.subscribe(job.id, (estado) => estados.push(estado));

    // Se `notify` deixasse a exceção escapar, `job.done` rejeitaria
    // (unhandled rejection) e este `await` lançaria.
    await job.done;

    expect(estados.at(-1)?.status).toBe("done");
  });
});

describe("JobStore.sweep", () => {
  test("remove apenas os jobs vencidos, e apaga o diretório", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 0 });
    const job = store.create(ENTRADA);
    await job.done;
    await mkdir(job.dir, { recursive: true });

    expect(await store.sweep(TTL_MS - 1)).toEqual([]);
    expect(store.get(job.id)).toBeDefined();

    expect(await store.sweep(TTL_MS + 1)).toEqual([job.id]);
    expect(store.get(job.id)).toBeUndefined();
    expect(await readdir(root)).not.toContain(job.id);
  });

  test("nunca remove um job em andamento", async () => {
    const store = new JobStore({ root, render: () => new Promise<RenderResult>(() => {}), newId, now: () => 0 });
    const job = store.create(ENTRADA);

    expect(await store.sweep(TTL_MS * 10)).toEqual([]);
    expect(store.get(job.id)).toBeDefined();
  });

  test("job preso rodando além do teto vira error, e some numa passada seguinte", async () => {
    let agora = 0;
    const store = new JobStore({
      root,
      render: () => new Promise<RenderResult>(() => {}),
      newId,
      now: () => agora,
    });
    const job = store.create(ENTRADA);
    await mkdir(job.dir, { recursive: true });

    // Ainda dentro do teto: continua rodando.
    agora = RUNNING_CEILING_MS - 1;
    expect(await store.sweep(agora)).toEqual([]);
    expect(store.get(job.id)?.status).toBe("running");

    // Passou do teto: vira error, mas ainda não é removido — só ganhou
    // `finishedAt` agora, e o TTL conta a partir daí.
    agora = RUNNING_CEILING_MS + 1;
    expect(await store.sweep(agora)).toEqual([]);
    const marcado = store.get(job.id);
    expect(marcado?.status).toBe("error");
    expect(marcado?.finishedAt).toBe(agora);
    expect(marcado?.error).toBeTruthy();

    // Só depois do TTL contado a partir da marcação é que o diretório some.
    agora = RUNNING_CEILING_MS + 1 + TTL_MS + 1;
    expect(await store.sweep(agora)).toEqual([job.id]);
    expect(store.get(job.id)).toBeUndefined();
  });

  test("continua a varredura mesmo se um job não conseguir ser removido", async () => {
    const store = new JobStore({ root, render: sucesso, newId, now: () => 0 });
    const job1 = store.create(ENTRADA);
    const job2 = store.create({ ...ENTRADA, hour: "21" });
    await job1.done;
    await job2.done;

    // Criar os diretórios para simular jobs completos
    await mkdir(job1.dir, { recursive: true });
    await mkdir(job2.dir, { recursive: true });

    // Tornar o diretório do primeiro job sem permissões de escrita para forçar falha na remoção
    // Usar uma permissão que não permite deletar (chmod 000)
    await chmod(job1.dir, 0o000);

    try {
      // Varrer com tempo além do TTL
      const removidos = await store.sweep(TTL_MS + 1);

      // O segundo job deve ter sido removido mesmo que o primeiro falhe
      expect(removidos).toContain(job2.id);
      expect(removidos).not.toContain(job1.id);

      // O primeiro job deve continuar no mapa (não foi removido)
      expect(store.get(job1.id)).toBeDefined();
      // O segundo job foi removido com sucesso
      expect(store.get(job2.id)).toBeUndefined();
    } finally {
      // Limpar: restaurar permissões para que o afterEach consiga deletar
      await chmod(job1.dir, 0o755);
    }
  });
});
