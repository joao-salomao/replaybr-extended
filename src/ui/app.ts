import { fetchReplaysForDate, groupReplaysByHour, type HourGroup, type Replay } from "../api.ts";
import { localDate } from "../dates.ts";
import { downloadReplayPairs } from "../download.ts";
import { createFfmpegEncoder, type FfmpegLike } from "../encoder.ts";
import { resolveField, type Field } from "../fields.ts";
import { loadFields } from "../fieldsExtract.ts";
import { probeDimensions } from "../mp4.ts";
import { renderReplays, type Clip, type RenderProgress } from "../render.ts";
import { buildZip } from "../zip.ts";
import { loadFfmpeg } from "./loadFfmpeg.ts";
import { createSelect } from "./select.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  date: $<HTMLInputElement>("date"),
  hour: $<HTMLSelectElement>("hour"),
  selectionNotice: $("selection-notice"),
  plays: $("plays"),
  playList: $("play-list"),
  checkAll: $<HTMLInputElement>("check-all"),
  swapLabel: $("swap-label"),
  swap: $<HTMLInputElement>("swap"),
  generate: $<HTMLButtonElement>("generate"),
  result: $("result"),
  progress: $("progress"),
  actions: $("actions"),
  failures: $("failures"),
  clips: $("clips"),
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHASES: Record<RenderProgress["phase"], string> = {
  download: "Baixando",
  render: "Renderizando",
};

let fields: Field[] = [];
let hours: HourGroup[] = [];
let running = false;
// Loaded on the first "Gerar" and reused: the wasm core is ~30 MB.
let ffmpeg: Promise<FfmpegLike[]> | null = null;
// Each ffmpeg.wasm instance is single-threaded: one per two cores, up to 3,
// renders plays side by side without starving the rest of the machine (each
// instance also holds its own wasm memory).
const ENCODERS = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
// Object URLs of the last job's clips, revoked when a new job starts.
let objectUrls: string[] = [];

// The court select and the date input both trigger loadDay(),
// so a second request can start before the first one answers. Each call gets
// a sequence number; a call whose number is no longer the latest must not
// touch the UI, or a slow stale answer would clobber a fresh one.
let loadDaySequence = 0;

const fieldSelect = createSelect($("field"), {
  placeholder: "Escolha a quadra",
  filterPlaceholder: "Buscar quadra ou digitar o slug",
  emptyMessage: "Nenhuma quadra encontrada",
  // Courts the list doesn't know stay reachable by their slug.
  freeValue: (text) => {
    const field = resolveField(text);
    return field && text === field.slug ? { value: field.slug, label: `Usar slug: ${field.slug}` } : null;
  },
  onChange: () => {
    applyDefaultSwap();
    void loadDay();
  },
});

const currentField = () =>
  fields.find((f) => f.slug === fieldSelect.value) ?? resolveField(fieldSelect.value);

const notice = (message: string) => {
  el.selectionNotice.textContent = message;
  el.selectionNotice.hidden = !message;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function setUpFields(): Promise<void> {
  const loaded = await loadFields();
  fields = loaded.fields;

  fieldSelect.setOptions(fields.map((field) => ({ value: field.slug, label: field.label })));
  el.date.value = localDate(new Date());

  if (!loaded.fromSite) notice("Lista de quadras do site indisponível. Usando a lista salva.");
}

function applyDefaultSwap(): void {
  el.swap.checked = currentField()?.defaultSwap ?? false;
}

async function loadDay(): Promise<void> {
  const field = currentField();
  if (!field || !DATE.test(el.date.value)) return;

  const sequence = ++loadDaySequence;
  el.hour.innerHTML = "";
  el.hour.disabled = true;
  el.plays.hidden = true;
  notice("Buscando…");

  try {
    const replays = await fetchReplaysForDate(field.slug, el.date.value);
    if (sequence !== loadDaySequence) return;

    hours = groupReplaysByHour(replays);
    if (hours.length === 0) return notice("Nenhum replay nessa data.");

    for (const hour of hours) {
      el.hour.append(new Option(`${hour.label} — ${hour.replays.length} lance(s)`, hour.hour));
    }
    el.hour.disabled = false;
    notice("");
    showPlays();
  } catch (error) {
    if (sequence !== loadDaySequence) return;
    notice(message(error));
  }
}

const currentHour = () => hours.find((h) => h.hour === el.hour.value);

function showPlays(): void {
  const hour = currentHour();
  if (!hour) return;

  el.playList.innerHTML = "";
  for (const play of hour.replays) {
    const li = document.createElement("li");

    // The preview toggle sits beside the <label>, not inside it, so its
    // clicks never toggle the play's checkbox.
    const row = document.createElement("div");
    row.className = "play-row";

    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.value = play.timestamp;
    checkbox.addEventListener("change", updateButton);

    const time = document.createElement("span");
    time.textContent = play.timestamp.slice(11);

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = play.camera2_url ? "2 câmeras" : "1 câmera";
    label.append(checkbox, time, badge);

    const preview = document.createElement("div");
    preview.className = "preview";
    preview.hidden = true;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "preview-toggle";
    toggle.textContent = "Ver câmeras";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => togglePreview(toggle, preview, play));

    row.append(label, toggle);
    li.append(row, preview);
    el.playList.append(li);
  }

  // With only one camera the swap makes no difference; a dead control just confuses.
  el.swapLabel.hidden = !hour.replays.some((r) => r.camera2_url);
  applyDefaultSwap();
  el.checkAll.checked = true;
  el.plays.hidden = false;
  updateButton();
}

// The <video> elements are built on the first expand, so opening the list
// never downloads a video. `preload="none"` guards the same goal.
function togglePreview(toggle: HTMLButtonElement, preview: HTMLElement, play: Replay): void {
  if (!preview.hidden) {
    for (const video of preview.querySelectorAll("video")) video.pause();
    preview.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Ver câmeras";
    return;
  }

  if (preview.childElementCount === 0) {
    preview.append(previewVideo(play.camera1_url));
    if (play.camera2_url) preview.append(previewVideo(play.camera2_url));
  }
  preview.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  toggle.textContent = "Ocultar câmeras";
}

function previewVideo(url: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "none";
  video.src = url;
  return video;
}

const selectedReplays = (): Replay[] => {
  const chosen = new Set(
    [...el.playList.querySelectorAll<HTMLInputElement>("input:checked")].map((c) => c.value),
  );
  return (currentHour()?.replays ?? []).filter((r) => chosen.has(r.timestamp));
};

function updateButton(): void {
  const chosen = selectedReplays();
  const fileCount = chosen.reduce((sum, r) => sum + (r.camera2_url ? 2 : 1), 0);

  el.generate.disabled = running || chosen.length === 0;
  el.generate.textContent =
    chosen.length === 0
      ? "Selecione ao menos um lance"
      : `Gerar · ${chosen.length} lance(s) · ${fileCount} arquivo(s) para baixar`;
}

function downloadLink(url: string, name: string, text: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = text;
  return link;
}

function showClip(clip: Clip): void {
  const url = URL.createObjectURL(clip.data);
  objectUrls.push(url);

  const wrapper = document.createElement("div");
  wrapper.className = "clip";
  wrapper.dataset.index = String(clip.index);

  const title = document.createElement("h3");
  title.textContent = clip.timestamp.slice(11);

  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.src = url;

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(downloadLink(url, clip.name, "Baixar"));

  wrapper.append(title, video, actions);
  // Parallel encodes finish in any order: slot each clip in chronologically.
  const next = [...el.clips.children].find(
    (other) => Number((other as HTMLElement).dataset.index) > clip.index,
  );
  el.clips.insertBefore(wrapper, next ?? null);
}

async function generate(): Promise<void> {
  const replays = selectedReplays();
  if (replays.length === 0) return;

  running = true;
  updateButton();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  el.result.hidden = false;
  el.clips.innerHTML = "";
  el.actions.innerHTML = "";
  el.actions.hidden = true;
  el.failures.innerHTML = "";
  el.failures.hidden = true;
  el.progress.textContent = "Carregando o ffmpeg…";

  try {
    let encoders;
    try {
      const pool = (ffmpeg ??= Promise.all(Array.from({ length: ENCODERS }, loadFfmpeg)));
      encoders = (await pool).map(createFfmpegEncoder);
    } catch (error) {
      ffmpeg = null;
      el.progress.textContent = `Não foi possível carregar o ffmpeg: ${message(error)}`;
      return;
    }

    el.progress.textContent = "Preparando…";
    const result = await renderReplays({
      replays,
      swap: el.swap.checked,
      fps: 30,
      crf: 20,
      preset: "veryfast",
      // Six cameras downloading keep three encoders fed.
      concurrency: 6,
      onProgress: ({ phase, done, total }) => {
        el.progress.textContent = `${PHASES[phase]} ${done}/${total}`;
      },
      onClip: showClip,
      deps: { downloadReplayPairs, probeDimensions, encoders },
    });

    el.progress.textContent = `Pronto — ${result.clips.length} vídeo(s).`;
    if (result.crashed) {
      // The wasm module is dead: drop it so the next "Gerar" loads a fresh one.
      for (const instance of (await ffmpeg) ?? []) instance.terminate();
      ffmpeg = null;
      el.progress.textContent +=
        " O ffmpeg travou, provavelmente sem memória. Gere os lances que faltaram de novo.";
    }

    for (const failure of result.failed) {
      const li = document.createElement("li");
      li.textContent = `${failure.timestamp.slice(11)}: ${failure.error}`;
      el.failures.append(li);
    }
    el.failures.hidden = result.failed.length === 0;

    if (result.clips.length > 0) {
      const zipButton = document.createElement("button");
      zipButton.type = "button";
      zipButton.textContent = "Baixar todos (.zip)";
      zipButton.addEventListener("click", async () => {
        zipButton.disabled = true;
        const zip = URL.createObjectURL(await buildZip(result.clips));
        objectUrls.push(zip);
        const name = `replays-${currentField()?.slug}-${el.date.value}-${el.hour.value}.zip`;
        downloadLink(zip, name, "").click();
        zipButton.disabled = false;
      });
      el.actions.append(zipButton);
      el.actions.hidden = false;
    }
  } catch (error) {
    el.progress.textContent = `Falhou: ${message(error)}`;
  } finally {
    running = false;
    updateButton();
  }
}

el.date.addEventListener("change", () => void loadDay());
el.hour.addEventListener("change", showPlays);
el.checkAll.addEventListener("change", () => {
  for (const checkbox of el.playList.querySelectorAll<HTMLInputElement>("input")) {
    checkbox.checked = el.checkAll.checked;
  }
  updateButton();
});
el.generate.addEventListener("click", () => void generate());

await setUpFields();
void loadDay();
