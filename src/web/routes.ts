import { basename } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  groupReplaysByHour,
  normalizeHour,
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

interface CorpoDoJob {
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
        // Decide o formato do quadro sem baixar nada.
        anyTwoCameras: group.replays.some((replay) => replay.camera2_url),
        replays: group.replays.map((replay) => ({
          timestamp: replay.timestamp,
          time: replay.timestamp.slice(11),
          cameras: replay.camera2_url ? 2 : 1,
        })),
      })),
    });
  });

  app.post("/api/jobs", async (c) => {
    let corpo: CorpoDoJob;
    try {
      corpo = (await c.req.json()) as CorpoDoJob;
    } catch {
      return c.json({ error: "Corpo inválido." }, 400);
    }

    const field =
      typeof corpo.field === "string" ? resolveField(corpo.field) : null;
    if (!field) return c.json({ error: "Quadra inválida." }, 400);

    if (typeof corpo.date !== "string" || !DATE.test(corpo.date)) {
      return c.json({ error: "Data inválida. Use YYYY-MM-DD." }, 400);
    }

    const hour =
      typeof corpo.hour === "string" ? normalizeHour(corpo.hour) : null;
    if (!hour) return c.json({ error: "Hora inválida." }, 400);

    if (
      !Array.isArray(corpo.replays) ||
      corpo.replays.length === 0 ||
      !corpo.replays.every((item) => typeof item === "string")
    ) {
      return c.json({ error: "Selecione ao menos um lance." }, 400);
    }

    const disponiveis = groupReplaysByHour(
      await fetchReplays(field.slug, corpo.date),
    ).find((group) => group.hour === hour);
    if (!disponiveis) return c.json({ error: "Hora sem replays." }, 400);

    const escolhidos = new Set(corpo.replays as string[]);
    const replays = disponiveis.replays.filter((replay) =>
      escolhidos.has(replay.timestamp),
    );
    if (replays.length !== escolhidos.size) {
      return c.json({ error: "Algum lance selecionado não existe." }, 400);
    }

    const job = jobs.create({
      field: field.slug,
      fieldLabel: field.label,
      date: corpo.date,
      hour,
      replays,
      swap: corpo.swap === true,
      concat: corpo.concat === true,
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
      // O primeiro evento é o estado atual: quem reconecta não precisa saber
      // o que perdeu.
      await stream.writeSSE({ data: JSON.stringify(jobs.serialize(job)) });

      const pendentes: string[] = [];
      const cancelar = jobs.subscribe(id, (state) => {
        pendentes.push(JSON.stringify(state));
      });

      try {
        // `write()` do Hono engole erro de escrita: um cliente que já foi
        // embora nunca faria essa promessa rejeitar. Sem checar `aborted`
        // aqui, o laço ficaria sondando a cada 200ms até o job terminar
        // sozinho, escrevendo no vazio.
        while (job.status === "running" && !stream.aborted) {
          const proximo = pendentes.shift();
          if (proximo) await stream.writeSSE({ data: proximo });
          else await stream.sleep(200);
        }
        if (!stream.aborted) {
          // Drena o que sobrou, garantindo que o estado final chegue —
          // inclusive para quem conectou num job que já tinha terminado.
          for (const restante of pendentes) {
            await stream.writeSSE({ data: restante });
          }
          await stream.writeSSE({ data: JSON.stringify(jobs.serialize(job)) });
        }
      } finally {
        cancelar();
      }
    });
  });

  app.get("/api/jobs/:id/zip", async (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "Esse link expirou." }, 404);

    // Montado só na primeira vez que alguém pede.
    job.zipPath ??= await buildZip(
      job.clips.map((clip) => clip.path),
      `${job.dir}/todos.zip`,
    );

    const nome = `${job.input.field}-${job.input.date}-${job.input.hour}.zip`;
    return new Response(Bun.file(job.zipPath), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${nome}"`,
      },
    });
  });

  app.get("/files/:id/:name", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "Esse link expirou." }, 404);

    // O nome precisa ser um arquivo que este job produziu: nunca caminho livre.
    const name = c.req.param("name");
    const permitidos = new Set(job.clips.map((clip) => basename(clip.path)));
    if (job.merged) permitidos.add(basename(job.merged.path));
    if (!permitidos.has(name)) {
      return c.json({ error: "Arquivo não encontrado." }, 404);
    }

    const file = Bun.file(`${job.dir}/${name}`);
    const anexo = c.req.query("download") === "1";
    const headers: Record<string, string> = {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
    };
    if (anexo) headers["content-disposition"] = `attachment; filename="${name}"`;

    const range = c.req.header("range");
    const match = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (match[1] === "" && match[2] === "")) {
      return new Response(file, { headers });
    }

    // Sem Range o `<video>` não consegue buscar posição no meio do vídeo.
    const size = file.size;
    // "bytes=-N" é sufixo — os últimos N bytes — e não "do byte 0 até N"
    // (RFC 7233 §2.1). Só é sufixo quando o início vem vazio.
    const sufixo = match[1] === "";
    const start = sufixo ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    const end = sufixo ? size - 1 : match[2] ? Number(match[2]) : size - 1;
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

  const pagina = () =>
    new Response(Bun.file(`${publicDir}/index.html`), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  app.get("/", pagina);
  app.get("/j/:id", pagina);

  return app;
}
