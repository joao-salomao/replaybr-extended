import { createFfmpegEncoder } from "./encoder.ts";
import { probeDimensions } from "./mp4.ts";
import { loadFfmpeg } from "./ui/loadFfmpeg.ts";
// Throwaway diagnostic page: does Cloudflare let the extension through?
// Removed once the app itself works.
const out = document.getElementById("out")!;
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
  out.textContent = lines.join("\n");
};

const describe = (res: Response) =>
  `${res.status} cf-mitigated=${res.headers.get("cf-mitigated") ?? "-"}`;

async function run(): Promise<void> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const listing = `https://replays.replaybr.com.br/available-hours?fieldName=four-play-3&date=${yesterday}`;

  const res = await fetch(listing, { credentials: "include" });
  log(`1. available-hours (${yesterday}): ${describe(res)}`);
  if (!res.ok) return;

  const body = (await res.json()) as { replays?: { camera1_url: string }[] };
  const first = body.replays?.[0];
  if (!first) {
    log("2. vídeo: nenhum lance nessa data");
  } else {
    const video = await fetch(first.camera1_url, { credentials: "include" });
    const bytes = video.ok ? (await video.arrayBuffer()).byteLength : 0;
    log(`2. vídeo: ${describe(video)} bytes=${bytes}`);
  }

  const page = await fetch("https://www.replaybr.com.br/replay", { credentials: "include" });
  log(`3. www.replaybr.com.br/replay: ${describe(page)}`);
}


// Render timing: one real two-camera play, three encoder settings.

async function findTwoCameraPlay(field: string): Promise<{ date: string; urls: string[] } | null> {
  for (let back = 1; back <= 7; back++) {
    const date = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    const res = await fetch(
      `https://replays.replaybr.com.br/available-hours?fieldName=${field}&date=${date}`,
      { credentials: "include" },
    );
    if (!res.ok) continue;
    const body = (await res.json()) as { replays?: { camera1_url: string; camera2_url?: string }[] };
    const play = body.replays?.find((r) => r.camera2_url);
    if (play) return { date, urls: [play.camera1_url, play.camera2_url!] };
  }
  return null;
}

async function timing(): Promise<void> {
  const play = await findTwoCameraPlay("placar-society");
  if (!play) return log("4. render: nenhum lance com duas câmeras na placar-society nos últimos 7 dias");

  const sources = await Promise.all(
    play.urls.map(async (url) =>
      new Uint8Array(await (await fetch(url, { credentials: "include" })).arrayBuffer()),
    ),
  );
  const full = await probeDimensions(new Blob([sources[0]!]));
  log(`4. lance de ${play.date}: ${full.width}x${full.height}, ${sources.map((s) => s.byteLength).join(" + ")} bytes`);

  const loadStart = performance.now();
  const encoder = createFfmpegEncoder(await loadFfmpeg());
  log(`   ffmpeg.wasm carregou em ${((performance.now() - loadStart) / 1000).toFixed(1)} s`);

  const small = full.height > 720
    ? { width: Math.round((full.width * 720) / full.height / 2) * 2, height: 720 }
    : full;
  const variants = [
    { label: "veryfast", preset: "veryfast", cell: full },
    { label: "ultrafast", preset: "ultrafast", cell: full },
    { label: `ultrafast ${small.width}x${small.height}`, preset: "ultrafast", cell: small },
  ];
  for (const variant of variants) {
    const start = performance.now();
    const out = await encoder.render({
      sources, cell: variant.cell, columns: 2, fps: 30, crf: 20, preset: variant.preset,
    });
    log(`   ${variant.label}: ${((performance.now() - start) / 1000).toFixed(1)} s, ${out.byteLength} bytes`);
  }
}

run()
  .then(timing)
  .catch((error: unknown) => log(`erro: ${String(error)}`));
