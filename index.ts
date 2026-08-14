#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  fetchReplaysForDate,
  groupReplaysByHour,
  normalizeHour,
} from "./src/api.ts";
import { assertFfmpegAvailable } from "./src/ffmpeg.ts";
import { renderReplays } from "./src/render.ts";

const DEFAULTS = {
  field: "placar-society",
  outDir: "output",
  downloadsDir: "downloads",
  concurrency: 4,
  crf: 20,
  preset: "veryfast",
  fps: 30,
} as const;

interface CliArgs {
  help: boolean;
  list: boolean;
  concat: boolean;
  swap: boolean;
  date: string | undefined;
  time: string | undefined;
  field: string;
  outDir: string;
  downloadsDir: string;
  concurrency: number;
  crf: number;
  preset: string;
  fps: number;
}

const USAGE = `
replaybr-extended — baixa replays do ReplayBR e junta as duas câmeras lado a lado

Gera um vídeo por lance (câmera 1 | câmera 2 tocando ao mesmo tempo).

Uso:
  bun run index.ts <data> <hora> [opções]
  bun run index.ts --date 2026-07-29 --time 20

Argumentos:
  <data>   YYYY-MM-DD
  <hora>   a hora exibida no site (ex: 20 ou 20:00)

Opções:
  -f, --field <slug>     quadra (padrão: ${DEFAULTS.field})
  -l, --list             lista as horas disponíveis na data e sai
  -c, --concat           além dos individuais, gera também um vídeo com todos
  -s, --swap             inverte a ordem das câmeras (câmera 2 | câmera 1)
  -o, --out-dir <dir>    diretório de saída (padrão: ${DEFAULTS.outDir})
      --downloads <dir>  diretório dos brutos (padrão: ${DEFAULTS.downloadsDir})
  -j, --concurrency <n>  downloads em paralelo (padrão: ${DEFAULTS.concurrency})
      --crf <n>          qualidade x264, menor = melhor (padrão: ${DEFAULTS.crf})
      --preset <p>       preset x264 (padrão: ${DEFAULTS.preset})
      --fps <n>          fps de saída (padrão: ${DEFAULTS.fps})
  -h, --help             mostra esta ajuda

Exemplos:
  bun run index.ts 2026-07-29 --list
  bun run index.ts 2026-07-29 20
  bun run index.ts 2026-07-29 20 --concat
  bun run index.ts 2026-07-29 22 --field global-society
  bun run index.ts 2026-07-29 20 --field four-play-2 --swap
`.trim();

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      date: { type: "string" },
      time: { type: "string" },
      field: { type: "string", short: "f" },
      list: { type: "boolean", short: "l" },
      concat: { type: "boolean", short: "c" },
      swap: { type: "boolean", short: "s" },
      "out-dir": { type: "string", short: "o" },
      downloads: { type: "string" },
      concurrency: { type: "string", short: "j" },
      crf: { type: "string" },
      preset: { type: "string" },
      fps: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  return {
    help: values.help ?? false,
    list: values.list ?? false,
    concat: values.concat ?? false,
    swap: values.swap ?? false,
    date: values.date ?? positionals[0],
    time: values.time ?? positionals[1],
    field: values.field ?? DEFAULTS.field,
    outDir: values["out-dir"] ?? DEFAULTS.outDir,
    downloadsDir: values.downloads ?? DEFAULTS.downloadsDir,
    concurrency: Number(values.concurrency ?? DEFAULTS.concurrency),
    crf: Number(values.crf ?? DEFAULTS.crf),
    preset: values.preset ?? DEFAULTS.preset,
    fps: Number(values.fps ?? DEFAULTS.fps),
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help || !args.date) {
    console.log(USAGE);
    process.exit(args.date ? 0 : 1);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    fail(`Data inválida: "${args.date}". Use o formato YYYY-MM-DD.`);
  }

  console.log(`→ Buscando replays de "${args.field}" em ${args.date}...`);
  const replays = await fetchReplaysForDate(args.field, args.date);

  if (replays.length === 0) {
    fail(`Nenhum replay encontrado para "${args.field}" em ${args.date}.`);
  }

  const groups = groupReplaysByHour(replays);
  console.log(`  ${replays.length} replays em ${groups.length} horas.`);

  if (args.list || !args.time) {
    console.log("\nHoras disponíveis:");
    for (const group of groups) {
      console.log(`  ${group.label}  —  ${group.replays.length} replay(s)`);
    }
    if (!args.list) {
      console.log("\nInforme uma hora para gerar o vídeo. Ex:");
      console.log(`  bun run index.ts ${args.date} ${groups.at(-1)?.hour ?? "20"}`);
    }
    return;
  }

  const hour = normalizeHour(args.time);
  if (!hour) fail(`Horário inválido: "${args.time}". Use a hora (ex: 20).`);

  const group = groups.find((candidate) => candidate.hour === hour);
  if (!group) {
    const available = groups.map((g) => g.label).join(", ");
    fail(`Nenhum replay na hora ${hour}:00. Disponíveis: ${available}`);
  }

  await assertFfmpegAvailable();

  const rawDir = `${args.downloadsDir}/${args.field}/${args.date}/${hour}/raw`;
  const outDir = `${args.outDir}/${args.field}/${args.date}/${hour}`;

  const withTwo = group.replays.filter((replay) => replay.camera2_url).length;
  const files = group.replays.length + withTwo;

  console.log(
    `\n→ ${group.replays.length} replay(s) na hora ${group.label}. Baixando ${files} arquivos...`,
  );
  if (withTwo < group.replays.length) {
    console.log(`  ${group.replays.length - withTwo} lance(s) com uma câmera só.`);
  }

  const result = await renderReplays({
    replays: group.replays,
    rawDir,
    outDir,
    swap: args.swap,
    concat: args.concat,
    fps: args.fps,
    crf: args.crf,
    preset: args.preset,
    concurrency: args.concurrency,
    onProgress: ({ phase, done, total }) => {
      if (phase === "download") {
        process.stdout.write(`\r  Baixando ${done}/${total}   `);
      }
    },
    onClip: (clip) => {
      const tag = clip.cameras === 1 ? "  (1 câmera)" : "";
      console.log(`\r  ✓ ${clip.path}${tag}`);
    },
  });

  const layout =
    result.clips.some((clip) => clip.cameras === 2)
      ? args.swap
        ? "câmera 2 | câmera 1"
        : "câmera 1 | câmera 2"
      : "câmera 1";

  console.log(`\n✓ ${result.clips.length} vídeo(s) em ${outDir}/`);
  console.log(`  ${layout}`);

  for (const failure of result.failed) {
    console.error(`  ✗ ${failure.timestamp}: ${failure.error}`);
  }

  if (result.merged) {
    console.log(
      `✓ ${result.merged.path} · ${result.merged.duration.toFixed(1)}s`,
    );
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
