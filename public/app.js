const $ = (id) => document.getElementById(id);

const el = {
  quadra: $("quadra"),
  rotuloSlug: $("rotulo-slug"),
  slug: $("slug"),
  data: $("data"),
  hora: $("hora"),
  avisoSelecao: $("aviso-selecao"),
  lances: $("lances"),
  listaLances: $("lista-lances"),
  marcarTodos: $("marcar-todos"),
  rotuloSwap: $("rotulo-swap"),
  swap: $("swap"),
  concat: $("concat"),
  gerar: $("gerar"),
  resultado: $("resultado"),
  progresso: $("progresso"),
  acoes: $("acoes"),
  expiracao: $("expiracao"),
  falhas: $("falhas"),
  clipes: $("clipes"),
};

const OUTRA = "__outra__";
let quadras = [];
let horas = [];
let fonte = null;

const slugAtual = () =>
  el.quadra.value === OUTRA ? el.slug.value.trim() : el.quadra.value;

const aviso = (mensagem) => {
  el.avisoSelecao.textContent = mensagem;
  el.avisoSelecao.hidden = !mensagem;
};

async function pegarJSON(url, options) {
  const res = await fetch(url, options);
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(corpo.error ?? `Erro ${res.status}`);
  return corpo;
}

async function carregarQuadras() {
  quadras = await pegarJSON("/api/fields");

  for (const quadra of quadras) {
    el.quadra.append(new Option(quadra.label, quadra.slug));
  }
  el.quadra.append(new Option("Outra quadra…", OUTRA));
  el.data.value = new Date().toISOString().slice(0, 10);
}

function aplicarSwapPadrao() {
  const quadra = quadras.find((q) => q.slug === slugAtual());
  el.swap.checked = quadra?.defaultSwap ?? false;
}

async function carregarDia() {
  const field = slugAtual();
  if (!field || !el.data.value) return;

  el.hora.innerHTML = "";
  el.hora.disabled = true;
  el.lances.hidden = true;
  aviso("Buscando…");

  try {
    const dia = await pegarJSON(
      `/api/replays?field=${encodeURIComponent(field)}&date=${el.data.value}`,
    );
    horas = dia.hours;

    if (horas.length === 0) {
      aviso("Nenhum replay nessa data.");
      return;
    }

    for (const hora of horas) {
      el.hora.append(new Option(`${hora.label} — ${hora.replays.length} lance(s)`, hora.hour));
    }
    el.hora.disabled = false;
    aviso("");
    mostrarLances();
  } catch (erro) {
    aviso(erro.message);
  }
}

function mostrarLances() {
  const hora = horas.find((h) => h.hour === el.hora.value);
  if (!hora) return;

  el.listaLances.innerHTML = "";
  for (const lance of hora.replays) {
    const li = document.createElement("li");
    const label = document.createElement("label");

    const caixa = document.createElement("input");
    caixa.type = "checkbox";
    caixa.checked = true;
    caixa.value = lance.timestamp;
    caixa.addEventListener("change", atualizarBotao);

    const texto = document.createElement("span");
    texto.textContent = lance.time;

    const selo = document.createElement("span");
    selo.className = "selo";
    selo.textContent = lance.cameras === 2 ? "2 câmeras" : "1 câmera";

    label.append(caixa, texto, selo);
    li.append(label);
    el.listaLances.append(li);
  }

  // Com uma câmera só o swap não faz diferença; um controle inerte só confunde.
  el.rotuloSwap.hidden = !hora.anyTwoCameras;
  aplicarSwapPadrao();
  el.marcarTodos.checked = true;
  el.lances.hidden = false;
  atualizarBotao();
}

const selecionados = () =>
  [...el.listaLances.querySelectorAll("input:checked")].map((c) => c.value);

function atualizarBotao() {
  const hora = horas.find((h) => h.hour === el.hora.value);
  const escolhidos = selecionados();
  const arquivos = hora
    ? hora.replays.filter((r) => escolhidos.includes(r.timestamp))
        .reduce((soma, r) => soma + r.cameras, 0)
    : 0;

  el.gerar.disabled = escolhidos.length === 0;
  el.gerar.textContent =
    escolhidos.length === 0
      ? "Selecione ao menos um lance"
      : `Gerar · ${escolhidos.length} lance(s) · ${arquivos} arquivo(s) para baixar`;
}

async function gerar() {
  el.gerar.disabled = true;

  try {
    const { jobId } = await pegarJSON("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        field: slugAtual(),
        date: el.data.value,
        hour: el.hora.value,
        replays: selecionados(),
        swap: el.swap.checked,
        concat: el.concat.checked,
      }),
    });

    history.pushState({}, "", `/j/${jobId}`);
    acompanhar(jobId);
  } catch (erro) {
    aviso(erro.message);
    el.gerar.disabled = false;
  }
}

function acompanhar(jobId) {
  el.resultado.hidden = false;
  el.progresso.textContent = "Preparando…";
  el.clipes.innerHTML = "";
  el.acoes.hidden = true;
  el.expiracao.hidden = true;
  el.falhas.hidden = true;

  fonte?.close();
  fonte = new EventSource(`/api/jobs/${jobId}/events`);
  fonte.onmessage = (evento) => desenhar(jobId, JSON.parse(evento.data));
  fonte.onerror = () => void verificarJobAindaExiste(jobId);
}

// EventSource já reconecta sozinho depois de um erro — fechar a conexão aqui
// jogaria fora esse reconnect embutido por causa de um blip passageiro, e o
// job pode continuar rodando normalmente do outro lado. Só interrompemos de
// verdade quando o job realmente sumiu (expirou, ou o servidor reiniciou e
// perdeu o work dir).
let verificandoJob = false;
async function verificarJobAindaExiste(jobId) {
  if (verificandoJob) return;
  verificandoJob = true;

  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (res.status !== 404) return;

    const corpo = await res.json().catch(() => ({}));
    fonte?.close();

    el.progresso.textContent = "";
    const texto = document.createElement("span");
    texto.textContent = corpo.error ?? "Esse link expirou.";
    const link = document.createElement("a");
    link.href = "/";
    link.textContent = "Voltar ao início";
    el.progresso.append(texto, document.createElement("br"), link);
  } catch {
    // Falha ao checar: deixa o EventSource seguir tentando reconectar sozinho.
  } finally {
    verificandoJob = false;
  }
}

const FASES = { download: "Baixando", render: "Renderizando", concat: "Juntando" };

function desenhar(jobId, estado) {
  if (estado.status === "running") {
    el.progresso.textContent = estado.progress
      ? `${FASES[estado.progress.phase]} ${estado.progress.done}/${estado.progress.total}`
      : "Preparando…";
  } else if (estado.status === "error") {
    el.progresso.textContent = `Falhou: ${estado.error}`;
  } else {
    el.progresso.textContent = `Pronto — ${estado.clips.length} vídeo(s).`;
  }

  for (const clipe of estado.clips) {
    if (document.getElementById(`clipe-${clipe.index}`)) continue;

    const bloco = document.createElement("div");
    bloco.className = "clipe";
    bloco.id = `clipe-${clipe.index}`;

    const titulo = document.createElement("h3");
    titulo.textContent = clipe.time;

    const video = document.createElement("video");
    video.controls = true;
    video.preload = "none";
    video.src = clipe.url;

    const baixar = document.createElement("a");
    baixar.href = `${clipe.url}?download=1`;
    baixar.textContent = "Baixar";

    const acoes = document.createElement("div");
    acoes.className = "acoes";
    acoes.append(baixar);

    bloco.append(titulo, video, acoes);
    el.clipes.append(bloco);
  }

  if (estado.failed.length > 0) {
    el.falhas.innerHTML = "";
    for (const falha of estado.failed) {
      const li = document.createElement("li");
      li.textContent = `${falha.time}: ${falha.error}`;
      el.falhas.append(li);
    }
    el.falhas.hidden = false;
  }

  if (estado.status !== "running") {
    fonte?.close();
    // O job terminou (com sucesso ou não): o usuário precisa poder gerar
    // outro sem precisar mexer numa caixa de seleção antes.
    atualizarBotao();
    el.acoes.innerHTML = "";

    if (estado.merged) {
      const link = document.createElement("a");
      link.href = `${estado.merged.url}?download=1`;
      link.textContent = `Baixar vídeo único (${estado.merged.duration.toFixed(0)}s)`;
      el.acoes.append(link);
    }
    if (estado.clips.length > 0) {
      const zip = document.createElement("a");
      zip.href = `/api/jobs/${jobId}/zip`;
      zip.textContent = "Baixar todos (.zip)";
      el.acoes.append(zip);
      el.acoes.hidden = false;
    }

    if (estado.expiresAt) {
      const quando = new Date(estado.expiresAt).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      });
      el.expiracao.textContent = `Os arquivos somem às ${quando}.`;
      el.expiracao.hidden = false;
    }
  }
}

el.quadra.addEventListener("change", () => {
  el.rotuloSlug.hidden = el.quadra.value !== OUTRA;
  aplicarSwapPadrao();
  void carregarDia();
});
el.slug.addEventListener("change", () => void carregarDia());
el.data.addEventListener("change", () => void carregarDia());
el.hora.addEventListener("change", mostrarLances);
el.marcarTodos.addEventListener("change", () => {
  for (const caixa of el.listaLances.querySelectorAll("input")) {
    caixa.checked = el.marcarTodos.checked;
  }
  atualizarBotao();
});
el.gerar.addEventListener("click", () => void gerar());

await carregarQuadras();

// `/j/<id>` reabre um job existente: recarregar não perde o progresso.
const emAndamento = location.pathname.match(/^\/j\/([\w-]+)$/);
if (emAndamento) acompanhar(emAndamento[1]);
else void carregarDia();
