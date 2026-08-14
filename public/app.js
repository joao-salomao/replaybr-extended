const $ = (id) => document.getElementById(id);

const el = {
  field: $("field"),
  slugLabel: $("slug-label"),
  slug: $("slug"),
  date: $("date"),
  hour: $("hour"),
  selectionNotice: $("selection-notice"),
  plays: $("plays"),
  playList: $("play-list"),
  checkAll: $("check-all"),
  swapLabel: $("swap-label"),
  swap: $("swap"),
  concat: $("concat"),
  generate: $("generate"),
  result: $("result"),
  progress: $("progress"),
  actions: $("actions"),
  expiration: $("expiration"),
  failures: $("failures"),
  clips: $("clips"),
};

const OTHER = "__other__";
let fields = [];
let hours = [];
let source = null;

const currentSlug = () =>
  el.field.value === OTHER ? el.slug.value.trim() : el.field.value;

const notice = (message) => {
  el.selectionNotice.textContent = message;
  el.selectionNotice.hidden = !message;
};

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Erro ${res.status}`);
  return body;
}

async function loadFields() {
  fields = await fetchJSON("/api/fields");

  for (const field of fields) {
    el.field.append(new Option(field.label, field.slug));
  }
  el.field.append(new Option("Outra quadra…", OTHER));
  el.date.value = new Date().toISOString().slice(0, 10);
}

function applyDefaultSwap() {
  const field = fields.find((f) => f.slug === currentSlug());
  el.swap.checked = field?.defaultSwap ?? false;
}

async function loadDay() {
  const field = currentSlug();
  if (!field || !el.date.value) return;

  el.hour.innerHTML = "";
  el.hour.disabled = true;
  el.plays.hidden = true;
  notice("Buscando…");

  try {
    const day = await fetchJSON(
      `/api/replays?field=${encodeURIComponent(field)}&date=${el.date.value}`,
    );
    hours = day.hours;

    if (hours.length === 0) {
      notice("Nenhum replay nessa data.");
      return;
    }

    for (const hour of hours) {
      el.hour.append(new Option(`${hour.label} — ${hour.replays.length} lance(s)`, hour.hour));
    }
    el.hour.disabled = false;
    notice("");
    showPlays();
  } catch (error) {
    notice(error.message);
  }
}

function showPlays() {
  const hour = hours.find((h) => h.hour === el.hour.value);
  if (!hour) return;

  el.playList.innerHTML = "";
  for (const play of hour.replays) {
    const li = document.createElement("li");
    const label = document.createElement("label");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.value = play.timestamp;
    checkbox.addEventListener("change", updateButton);

    const text = document.createElement("span");
    text.textContent = play.time;

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = play.cameras === 2 ? "2 câmeras" : "1 câmera";

    label.append(checkbox, text, badge);
    li.append(label);
    el.playList.append(li);
  }

  // With only one camera the swap makes no difference; a dead control just confuses.
  el.swapLabel.hidden = !hour.anyTwoCameras;
  applyDefaultSwap();
  el.checkAll.checked = true;
  el.plays.hidden = false;
  updateButton();
}

const selectedTimestamps = () =>
  [...el.playList.querySelectorAll("input:checked")].map((c) => c.value);

function updateButton() {
  const hour = hours.find((h) => h.hour === el.hour.value);
  const chosen = selectedTimestamps();
  const fileCount = hour
    ? hour.replays.filter((r) => chosen.includes(r.timestamp))
        .reduce((sum, r) => sum + r.cameras, 0)
    : 0;

  el.generate.disabled = chosen.length === 0;
  el.generate.textContent =
    chosen.length === 0
      ? "Selecione ao menos um lance"
      : `Gerar · ${chosen.length} lance(s) · ${fileCount} arquivo(s) para baixar`;
}

async function generate() {
  el.generate.disabled = true;

  try {
    const { jobId } = await fetchJSON("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: currentSlug(),
        date: el.date.value,
        hour: el.hour.value,
        replays: selectedTimestamps(),
        swap: el.swap.checked,
        concat: el.concat.checked,
      }),
    });

    history.pushState({}, "", `/j/${jobId}`);
    track(jobId);
  } catch (error) {
    notice(error.message);
    el.generate.disabled = false;
  }
}

function track(jobId) {
  el.result.hidden = false;
  el.progress.textContent = "Preparando…";
  el.clips.innerHTML = "";
  el.actions.hidden = true;
  el.expiration.hidden = true;
  el.failures.hidden = true;

  source?.close();
  source = new EventSource(`/api/jobs/${jobId}/events`);
  source.onmessage = (event) => renderState(jobId, JSON.parse(event.data));
  source.onerror = () => void checkJobStillExists(jobId);
}

// EventSource already reconnects on its own after an error — closing the
// connection here would throw away that built-in reconnect over a passing
// blip, and the job may well still be running fine on the other end. We only
// actually stop when the job is truly gone (expired, or the server restarted
// and lost the work dir).
let checkingJob = false;
async function checkJobStillExists(jobId) {
  if (checkingJob) return;
  checkingJob = true;

  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (res.status !== 404) return;

    const body = await res.json().catch(() => ({}));
    source?.close();

    el.progress.textContent = "";
    const text = document.createElement("span");
    text.textContent = body.error ?? "Esse link expirou.";
    const link = document.createElement("a");
    link.href = "/";
    link.textContent = "Voltar ao início";
    el.progress.append(text, document.createElement("br"), link);
  } catch {
    // Check failed: let the EventSource keep trying to reconnect on its own.
  } finally {
    checkingJob = false;
  }
}

const PHASES = { download: "Baixando", render: "Renderizando", concat: "Juntando" };

function renderState(jobId, state) {
  if (state.status === "running") {
    el.progress.textContent = state.progress
      ? `${PHASES[state.progress.phase]} ${state.progress.done}/${state.progress.total}`
      : "Preparando…";
  } else if (state.status === "error") {
    el.progress.textContent = `Falhou: ${state.error}`;
  } else {
    el.progress.textContent = `Pronto — ${state.clips.length} vídeo(s).`;
  }

  for (const clip of state.clips) {
    if (document.getElementById(`clip-${clip.index}`)) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "clip";
    wrapper.id = `clip-${clip.index}`;

    const title = document.createElement("h3");
    title.textContent = clip.time;

    const video = document.createElement("video");
    video.controls = true;
    video.preload = "none";
    video.src = clip.url;

    const downloadLink = document.createElement("a");
    downloadLink.href = `${clip.url}?download=1`;
    downloadLink.textContent = "Baixar";

    const actionsRow = document.createElement("div");
    actionsRow.className = "actions";
    actionsRow.append(downloadLink);

    wrapper.append(title, video, actionsRow);
    el.clips.append(wrapper);
  }

  if (state.failed.length > 0) {
    el.failures.innerHTML = "";
    for (const failure of state.failed) {
      const li = document.createElement("li");
      li.textContent = `${failure.time}: ${failure.error}`;
      el.failures.append(li);
    }
    el.failures.hidden = false;
  }

  if (state.status !== "running") {
    source?.close();
    // The job is finished (successfully or not): the user needs to be able
    // to generate another one without first touching a checkbox.
    updateButton();
    el.actions.innerHTML = "";

    if (state.merged) {
      const link = document.createElement("a");
      link.href = `${state.merged.url}?download=1`;
      link.textContent = `Baixar vídeo único (${state.merged.duration.toFixed(0)}s)`;
      el.actions.append(link);
    }
    if (state.clips.length > 0) {
      const zip = document.createElement("a");
      zip.href = `/api/jobs/${jobId}/zip`;
      zip.textContent = "Baixar todos (.zip)";
      el.actions.append(zip);
      el.actions.hidden = false;
    }

    if (state.expiresAt) {
      const when = new Date(state.expiresAt).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      });
      el.expiration.textContent = `Os arquivos somem às ${when}.`;
      el.expiration.hidden = false;
    }
  }
}

el.field.addEventListener("change", () => {
  el.slugLabel.hidden = el.field.value !== OTHER;
  applyDefaultSwap();
  void loadDay();
});
el.slug.addEventListener("change", () => void loadDay());
el.date.addEventListener("change", () => void loadDay());
el.hour.addEventListener("change", showPlays);
el.checkAll.addEventListener("change", () => {
  for (const checkbox of el.playList.querySelectorAll("input")) {
    checkbox.checked = el.checkAll.checked;
  }
  updateButton();
});
el.generate.addEventListener("click", () => void generate());

await loadFields();

// `/j/<id>` reopens an existing job: reloading doesn't lose progress.
const inProgress = location.pathname.match(/^\/j\/([\w-]+)$/);
if (inProgress) track(inProgress[1]);
else void loadDay();
