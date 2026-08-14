import { serveStatic } from "hono/bun";
import { fetchReplaysForDate } from "./src/api.ts";
import { assertFfmpegAvailable } from "./src/ffmpeg.ts";
import { JobStore } from "./src/web/jobs.ts";
import { createApp } from "./src/web/routes.ts";
import { rm, mkdir, readdir } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 3000);
const WORK_DIR = process.env.WORK_DIR ?? "work";
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Falhar aqui é melhor que falhar no primeiro usuário.
await assertFfmpegAvailable();

// O estado dos jobs é em memória: o que sobrou de um restart é inalcançável.
// Limpa o conteúdo em vez de recriar o diretório em si: quando WORK_DIR é o
// ponto de montagem de um volume (caso do Docker), remover o diretório falha
// com EBUSY — só o conteúdo pode ser apagado.
await mkdir(WORK_DIR, { recursive: true });
for (const entrada of await readdir(WORK_DIR)) {
  try {
    await rm(`${WORK_DIR}/${entrada}`, { recursive: true, force: true });
  } catch (erro) {
    // Uma entrada que não pode ser removida não deve impedir o boot: o
    // servidor sobe do mesmo jeito, com esse resto ocupando espaço.
    console.warn(
      `⚠ Não foi possível remover "${entrada}" de ${WORK_DIR}: ${erro instanceof Error ? erro.message : String(erro)}`,
    );
  }
}

const jobs = new JobStore({ root: WORK_DIR });

setInterval(() => {
  void jobs.sweep().then((removidos) => {
    if (removidos.length > 0) {
      console.log(`⌫ ${removidos.length} job(s) expirado(s) removido(s)`);
    }
  }).catch((erro) => {
    console.error(`✗ Falha ao varrer jobs expirados: ${erro instanceof Error ? erro.message : String(erro)}`);
  });
}, SWEEP_INTERVAL_MS);

const app = createApp({
  fetchReplays: fetchReplaysForDate,
  jobs,
  publicDir: "public",
});

app.use("/*", serveStatic({ root: "./public" }));

console.log(`▶ replaybr-extended em http://localhost:${PORT}`);

export default { port: PORT, fetch: app.fetch, idleTimeout: 255 };
