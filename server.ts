import { serveStatic } from "hono/bun";
import { fetchReplaysForDate } from "./src/api.ts";
import { assertFfmpegAvailable } from "./src/ffmpeg.ts";
import { JobStore } from "./src/web/jobs.ts";
import { createApp } from "./src/web/routes.ts";
import { rm, mkdir } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 3000);
const WORK_DIR = process.env.WORK_DIR ?? "work";
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Falhar aqui é melhor que falhar no primeiro usuário.
await assertFfmpegAvailable();

// O estado dos jobs é em memória: o que sobrou de um restart é inalcançável.
await rm(WORK_DIR, { recursive: true, force: true });
await mkdir(WORK_DIR, { recursive: true });

const jobs = new JobStore({ root: WORK_DIR });

setInterval(() => {
  void jobs.sweep().then((removidos) => {
    if (removidos.length > 0) {
      console.log(`⌫ ${removidos.length} job(s) expirado(s) removido(s)`);
    }
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
