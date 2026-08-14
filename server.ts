import { serveStatic } from "hono/bun";
import { fetchReplaysForDate } from "./src/api.ts";
import { assertFfmpegAvailable } from "./src/ffmpeg.ts";
import { JobStore } from "./src/web/jobs.ts";
import { createApp } from "./src/web/routes.ts";
import { rm, mkdir, readdir } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 3000);
const WORK_DIR = process.env.WORK_DIR ?? "work";
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Better to fail here than to fail on the first user.
await assertFfmpegAvailable();

// Job state lives in memory: whatever was running before a restart is
// unreachable. Clear the contents instead of recreating the directory
// itself: when WORK_DIR is a Docker volume's mount point, removing the
// directory fails with EBUSY — only its contents can be wiped.
await mkdir(WORK_DIR, { recursive: true });
for (const entry of await readdir(WORK_DIR)) {
  try {
    await rm(`${WORK_DIR}/${entry}`, { recursive: true, force: true });
  } catch (error) {
    // An entry that can't be removed shouldn't block boot: the server
    // still comes up, just with that leftover taking up space.
    console.warn(
      `⚠ Não foi possível remover "${entry}" de ${WORK_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const jobs = new JobStore({ root: WORK_DIR });

setInterval(() => {
  void jobs.sweep().then((removed) => {
    if (removed.length > 0) {
      console.log(`⌫ ${removed.length} job(s) expirado(s) removido(s)`);
    }
  }).catch((error) => {
    console.error(`✗ Falha ao varrer jobs expirados: ${error instanceof Error ? error.message : String(error)}`);
  });
}, SWEEP_INTERVAL_MS);

const app = createApp({
  fetchReplays: fetchReplaysForDate,
  jobs,
  publicDir: "public",
});

app.use("/*", serveStatic({ root: "./public" }));

// No host in the message: the server may be reached through a reverse proxy
// or a public address, and printing "localhost" would name the wrong one.
console.log(`▶ replaybr-extended ouvindo na porta ${PORT}`);

export default { port: PORT, fetch: app.fetch, idleTimeout: 255 };
