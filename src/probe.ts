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

run().catch((error: unknown) => log(`erro: ${String(error)}`));
