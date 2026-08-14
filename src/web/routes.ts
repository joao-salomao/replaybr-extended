import { rename } from "node:fs/promises";
import { basename } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  groupReplaysByHour,
  normalizeHour,
  ReplayBrUnavailableError,
  type Replay,
} from "../api.ts";
import { FIELDS, resolveField } from "../fields.ts";
import { JobStore } from "./jobs.ts";
import { buildZip } from "./zip.ts";

export interface RouteDeps {
  fetchReplays: (field: string, date: string) => Promise<Replay[]>;
  jobs: JobStore;
  publicDir: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Longest gap without writing anything to the SSE before sending a keepalive. */
const SSE_KEEPALIVE_MS = 15_000;

interface JobBody {
  field: unknown;
  date: unknown;
  hour: unknown;
  replays: unknown;
  swap: unknown;
  concat: unknown;
}

export function createApp({ fetchReplays, jobs, publicDir }: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/fields", (c) => c.json(FIELDS));

  app.get("/api/replays", async (c) => {
    const field = resolveField(c.req.query("field") ?? "");
    if (!field) return c.json({ error: "Quadra inválida." }, 400);

    const date = c.req.query("date") ?? "";
    if (!DATE.test(date)) {
      return c.json({ error: "Data inválida. Use YYYY-MM-DD." }, 400);
    }

    const replays = await fetchReplays(field.slug, date);

    return c.json({
      field: field.slug,
      fieldLabel: field.label,
      date,
      hours: groupReplaysByHour(replays).map((group) => ({
        hour: group.hour,
        label: group.label,
        // Decides the frame layout without downloading anything.
        anyTwoCameras: group.replays.some((replay) => replay.camera2_url),
        replays: group.replays.map((replay) => ({
          timestamp: replay.timestamp,
          time: replay.timestamp.slice(11),
          cameras: replay.camera2_url ? 2 : 1,
          // Points the front end's <video> straight at the CDN: no fetch(),
          // no proxying, so previewing a play costs our server nothing.
          camera1Url: replay.camera1_url,
          ...(replay.camera2_url ? { camera2Url: replay.camera2_url } : {}),
        })),
      })),
    });
  });

  app.post("/api/jobs", async (c) => {
    let body: JobBody;
    try {
      body = (await c.req.json()) as JobBody;
    } catch {
      return c.json({ error: "Corpo inválido." }, 400);
    }

    const field =
      typeof body.field === "string" ? resolveField(body.field) : null;
    if (!field) return c.json({ error: "Quadra inválida." }, 400);

    if (typeof body.date !== "string" || !DATE.test(body.date)) {
      return c.json({ error: "Data inválida. Use YYYY-MM-DD." }, 400);
    }

    const hour =
      typeof body.hour === "string" ? normalizeHour(body.hour) : null;
    if (!hour) return c.json({ error: "Hora inválida." }, 400);

    if (
      !Array.isArray(body.replays) ||
      body.replays.length === 0 ||
      !body.replays.every((item) => typeof item === "string")
    ) {
      return c.json({ error: "Selecione ao menos um lance." }, 400);
    }

    const available = groupReplaysByHour(
      await fetchReplays(field.slug, body.date),
    ).find((group) => group.hour === hour);
    if (!available) return c.json({ error: "Hora sem replays." }, 400);

    const chosen = new Set(body.replays as string[]);
    const replays = available.replays.filter((replay) =>
      chosen.has(replay.timestamp),
    );
    if (replays.length !== chosen.size) {
      return c.json({ error: "Algum lance selecionado não existe." }, 400);
    }

    const job = jobs.create({
      field: field.slug,
      fieldLabel: field.label,
      date: body.date,
      hour,
      replays,
      swap: body.swap === true,
      concat: body.concat === true,
    });

    return c.json({ jobId: job.id });
  });

  app.get("/api/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "Esse link expirou." }, 404);

    return c.json(jobs.serialize(job));
  });

  app.get("/api/jobs/:id/events", (c) => {
    const id = c.req.param("id");
    const job = jobs.get(id);
    if (!job) return c.json({ error: "Esse link expirou." }, 404);

    return streamSSE(c, async (stream) => {
      // The first event is the current state: whoever reconnects doesn't
      // need to know what they missed.
      await stream.writeSSE({ data: JSON.stringify(jobs.serialize(job)) });

      const pending: string[] = [];
      const unsubscribe = jobs.subscribe(id, (state) => {
        pending.push(JSON.stringify(state));
      });

      try {
        // Hono's `write()` swallows write errors: a client that already left
        // would never make that promise reject. Without checking `aborted`
        // here, the loop would keep polling every 200ms until the job
        // finishes on its own, writing into the void.
        let lastWrite = Date.now();
        while (job.status === "running" && !stream.aborted) {
          const next = pending.shift();
          if (next) {
            await stream.writeSSE({ data: next });
            lastWrite = Date.now();
          } else {
            await stream.sleep(200);
            // A slow job can easily go well past the 200ms between real
            // events: without a keepalive, a long silent stretch would trip
            // Bun's `idleTimeout` and drop the connection.
            // SSE comment line (starts with `:`): the client's EventSource
            // ignores it, it never reaches `onmessage`.
            if (Date.now() - lastWrite >= SSE_KEEPALIVE_MS) {
              await stream.write(": keepalive\n\n");
              lastWrite = Date.now();
            }
          }
        }
        if (!stream.aborted) {
          // Drains whatever is left, guaranteeing the final state arrives —
          // including for someone who connected to a job that had already finished.
          for (const remaining of pending) {
            await stream.writeSSE({ data: remaining });
          }
          await stream.writeSSE({ data: JSON.stringify(jobs.serialize(job)) });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get("/api/jobs/:id/zip", async (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "Esse link expirou." }, 404);

    // `clips` is still being filled while the job runs: building now would
    // only capture the clips ready so far, and that partial zip would stay
    // cached for the job's whole 2h lifetime.
    if (job.status === "running") {
      return c.json(
        { error: "O job ainda está sendo gerado. Aguarde terminar para baixar o zip." },
        409,
      );
    }

    // `??=` here is atomic with respect to the event loop: the check and
    // the assignment have no `await` between them, so two requests arriving
    // "at the same time" never trigger `buildZip` twice — the second one
    // always finds the first one's promise already stored.
    job.zipBuild ??= (async () => {
      const tmp = `${job.dir}/todos.zip.tmp`;
      const final = `${job.dir}/todos.zip`;
      await buildZip(
        job.clips.map((clip) => clip.path),
        tmp,
      );
      // Only renamed once ready: nobody can serve a file being overwritten underneath them.
      await rename(tmp, final);
      return final;
    })();

    let zipPath: string;
    try {
      zipPath = await job.zipBuild;
    } catch (error) {
      // Failed: free it up to retry on a future request, instead of leaving
      // the job stuck on a rejected promise forever.
      job.zipBuild = null;
      throw error;
    }

    const filename = `${job.input.field}-${job.input.date}-${job.input.hour}.zip`;
    return new Response(Bun.file(zipPath), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

  app.get("/files/:id/:name", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "Esse link expirou." }, 404);

    // The name has to be a file this job produced: never a free-form path.
    const name = c.req.param("name");
    const allowed = new Set(job.clips.map((clip) => basename(clip.path)));
    if (job.merged) allowed.add(basename(job.merged.path));
    if (!allowed.has(name)) {
      return c.json({ error: "Arquivo não encontrado." }, 404);
    }

    const file = Bun.file(`${job.dir}/${name}`);
    const attachment = c.req.query("download") === "1";
    const headers: Record<string, string> = {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
    };
    if (attachment) headers["content-disposition"] = `attachment; filename="${name}"`;

    const range = c.req.header("range");
    const match = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (match[1] === "" && match[2] === "")) {
      return new Response(file, { headers });
    }

    // Without Range the `<video>` element can't seek to a position mid-video.
    const size = file.size;
    // "bytes=-N" is a suffix range — the last N bytes — not "from byte 0 to
    // N" (RFC 7233 §2.1). It's only a suffix when the start comes empty.
    const suffix = match[1] === "";
    const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    const end = suffix ? size - 1 : match[2] ? Number(match[2]) : size - 1;
    if (start >= size || end >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }

    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    });
  });

  const page = () =>
    new Response(Bun.file(`${publicDir}/index.html`), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  app.get("/", page);
  app.get("/j/:id", page);

  // Every route returns `{ error }` in Portuguese for the cases we've
  // anticipated, but a throw that escapes (e.g. fetchReplays failing) would
  // fall through to Hono's default handler, which returns plain text
  // "Internal Server Error" — the frontend shows that raw as "Erro 500". By
  // far the most likely cause is the ReplayBR API being down, so that one
  // gets called out explicitly.
  app.onError((err, c) => {
    console.error("✗ Erro não tratado numa rota:", err);

    if (err instanceof ReplayBrUnavailableError) {
      return c.json(
        {
          error:
            "Não foi possível falar com a API do ReplayBR agora. Tente de novo em instantes.",
        },
        502,
      );
    }

    return c.json({ error: "Erro interno do servidor. Tente de novo." }, 500);
  });

  return app;
}
