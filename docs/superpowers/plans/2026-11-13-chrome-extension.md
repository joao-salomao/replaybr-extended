# Plano de implementação: replaybr-extended como extensão do Chrome

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Objetivo:** levar o app inteiro (lista de quadras, lances por hora, prévia, render lado a lado, zip) para uma extensão do Chrome MV3, para as chamadas saírem do navegador que já passou pelo Cloudflare.

**Arquitetura:** uma página da extensão (`app.html`) roda o pipeline inteiro na aba: busca na API com `host_permissions`, baixa as câmeras para memória, renderiza cada lance com `ffmpeg.wasm` single-thread e monta o zip com JSZip. `render.ts` depende só da interface `ClipEncoder`. Assim, trocar o `ffmpeg.wasm` pela Mediabunny muda um arquivo só. O servidor, o CLI e o Docker são apagados.

**Stack:** TypeScript, Vite + `@crxjs/vite-plugin`, `@ffmpeg/ffmpeg` + `@ffmpeg/util` + `@ffmpeg/core` (single-thread), JSZip, `bun test` para a lógica pura, `@types/chrome`.

**Spec:** `docs/superpowers/specs/2026-11-13-chrome-extension-design.md`

## Restrições globais

- Manifest V3. Nenhum código remoto: o `ffmpeg-core.js` e o `ffmpeg-core.wasm` vão dentro do `dist/`.
- CSP de `extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- `host_permissions`: `https://replays.replaybr.com.br/*` e `https://www.replaybr.com.br/*`.
- Núcleo **single-thread** do ffmpeg.wasm. Sem COEP e sem COOP no manifest, porque isso quebra a prévia com `<video>`.
- A extensão nunca lê, guarda ou manda o `cf_clearance`. Os `fetch` usam `credentials: "include"` e mais nada.
- Padrões de encode: `fps 30`, `crf 20`, `preset veryfast`. Um encode por vez. Downloads com `concurrency 4`, `retries 2` e timeout de 3 min por arquivo.
- Meta: uma hora inteira pronta em **no máximo 5 minutos** no Mac do usuário, ou seja, de 30 a 60 s por lance.
- Sem a opção de juntar a hora num vídeo só (`concat`).
- Textos da interface em português. Comentários de código em inglês, como hoje.
- Sem travessões (em dash ou en dash) em texto novo.

## Foco da revisão

1. **O Cloudflare pede a verificação de novo no meio de um job.** O `cf_clearance` expira, e os vídeos voltam 403 com `cf-mitigated: challenge`. O usuário espera ver a mensagem para abrir o site, sem 3 tentativas inúteis por arquivo. Teste na Tarefa 3.
2. **O site muda o bundle e a extração da lista falha.** O usuário espera ver a lista de reserva e um aviso, nunca um dropdown vazio. Teste na Tarefa 2.
3. **Um render falha no meio da hora.** Os arquivos do lance precisam sair do FS do ffmpeg mesmo assim, ou a memória cresce até travar a aba. Teste na Tarefa 5.
4. **A hora mistura lances de uma e de duas câmeras.** O lance de uma câmera sai centralizado no quadro de duas colunas, com a mesma medida dos outros. O teste do filtro está na Tarefa 5.
5. **A troca de câmeras (`swap`) num lance de uma câmera só.** Não pode quebrar nem mudar nada. Teste na Tarefa 6.

---

### Tarefa 0: branch e ponto de partida

O usuário ainda não autorizou commits. Antes de qualquer commit, pergunte se pode:
1. commitar as mudanças atuais (erro do Cloudflare e 77 quadras) num commit próprio no `main`;
2. criar a branch `feat/chrome-extension` a partir dele.

O plano parte da árvore atual, com essas mudanças. Não descarte nada.

---

### Tarefa 1: esqueleto da extensão e teste do Cloudflare (decide se segue)

**Arquivos:**
- Criar: `vite.config.ts`, `manifest.config.ts`, `src/background.ts`, `probe.html`, `src/probe.ts`
- Modificar: `package.json` (scripts `dev`, `build`; dependências), `tsconfig.json` (`lib: ["ESNext", "DOM"]`, `types: ["bun", "chrome"]`, `include` com `*.config.ts` e `src/**/*.ts`), `.gitignore` (`dist/`)

**Interfaces:**
- Produz: `bun run build` gera `dist/`, que carrega em `chrome://extensions`. Clicar no ícone abre `app.html` numa aba nova. Nesta tarefa, o ícone abre um `app.html` vazio, e `probe.html` existe só para o teste.

- [ ] **Passo 1:** `bun add -d vite @crxjs/vite-plugin @types/chrome`. Escreva `manifest.config.ts` com `defineManifest`: `manifest_version: 3`, `name: "replaybr-extended"`, `action` sem popup, `background.service_worker: "src/background.ts"`, as `host_permissions` e a CSP das Restrições globais.
- [ ] **Passo 2:** `src/background.ts`: `chrome.action.onClicked` abre `chrome.runtime.getURL("app.html")` com `chrome.tabs.create`. Em `vite.config.ts`, use `crx({ manifest })` e coloque `app.html` e `probe.html` em `build.rollupOptions.input`.
- [ ] **Passo 3:** `src/probe.ts` mostra na página o status HTTP e o header `cf-mitigated` de três chamadas, todas com `credentials: "include"`:
  1. `https://replays.replaybr.com.br/available-hours?fieldName=four-play-3&date=<ontem>`;
  2. o `camera1_url` do primeiro lance da resposta, com o tamanho em bytes;
  3. `https://www.replaybr.com.br/replay`.
- [ ] **Passo 4:** rode `bun run build`. Esperado: termina sem erro e cria `dist/manifest.json`.
- [ ] **Passo 5 (manual, usuário):** peça ao usuário para abrir `www.replaybr.com.br` uma vez e carregar o `dist/` em `chrome://extensions` > "Carregar sem compactação". Depois abra `chrome-extension://<id>/probe.html` pelo Claude in Chrome e leia o resultado.
  - **Esperado:** as três chamadas dão 200. Então siga em frente.
  - **Se alguma der 403 com `cf-mitigated: challenge`: PARE.** Leve ao usuário. A saída provável é a interface injetada na página do site, e a escolha é dele.
- [ ] **Passo 6:** faça commit (se a Tarefa 0 liberou): `Add Chrome extension scaffold with Cloudflare probe`.

---

### Tarefa 2: lista de quadras extraída do site

**Arquivos:**
- Criar: `src/fieldsExtract.ts`, `src/fieldsExtract.test.ts`
- Modificar: `src/fields.ts` (exportar `SWAP_BY_DEFAULT`)

**Interfaces:**
- Consome: `Field`, `FIELDS` e `resolveField` de `src/fields.ts`.
- Produz:
  - `parseFieldsFromBundle(js: string): { labels: Record<string, string>; inactive: string[] } | null`
  - `buildFieldList(labels: Record<string, string>, inactive: string[]): Field[]`
  - `loadFields(fetchText?: (url: string) => Promise<string>): Promise<{ fields: Field[]; fromSite: boolean }>`
  - `SWAP_BY_DEFAULT: ReadonlySet<string>` (hoje só tem `four-play-3`)

- [ ] **Passo 1: escreva os testes que falham.** A fixture é o trecho real do chunk, copiado da spec, seção "Lista de quadras", com 3 pares. Inclua a chave sem aspas (`olaria:"Olaria"`) e o `new Set([...])` antes do `e.s(`.
  - `parses quoted and unquoted keys`: `labels` igual a `{ olaria: "Olaria", "luiza-futsal": "Guabisoccer Futsal", "four-play-3": "Four Play - Quadra 3" }`.
  - `reads the inactive set`: `inactive` igual a `["s-e-sao-paulo", "golacos-society-2"]` (o Set da fixture).
  - `returns null when the export is missing`: `parseFieldsFromBundle("var a=1")` dá `null`.
  - `buildFieldList drops inactive, sorts by label in pt-BR, applies SWAP_BY_DEFAULT`: `four-play-3` vem com `defaultSwap: true`, e as outras com `false`.
  - `loadFields falls back to FIELDS when no chunk has the mapping`: um `fetchText` falso devolve um HTML com 2 `<script src="/_next/static/chunks/x.js">` e chunks sem o export. O resultado é `{ fields: FIELDS, fromSite: false }`.
  - `loadFields falls back when fetch throws`: o mesmo resultado quando `fetchText` rejeita.
  - `loadFields uses the site list when found`: `fromSite: true`, e `fields` contém `four-play-3`.
- [ ] **Passo 2:** rode `bun test src/fieldsExtract.test.ts`. Esperado: FAIL, módulo não encontrado.
- [ ] **Passo 3:** implemente `parseFieldsFromBundle` sem `eval`. Ache `"humanReadableFieldNameMapping",0,{`. Leia o objeto contando chaves até a que fecha. Extraia os pares com `/(?:"([^"]+)"|([A-Za-z_$][\w$]*)):"([^"]*)"/g`. Ache o último `new Set([` antes do `e.s([` e faça `JSON.parse` do array.
- [ ] **Passo 4:** implemente `loadFields`. Baixe `https://www.replaybr.com.br/replay`, extraia os `src` de `/_next/static/chunks/*.js`, baixe cada chunk e pare no primeiro em que `parseFieldsFromBundle` não der `null`. O `fetchText` padrão é `fetch(url, { credentials: "include" }).then(r => r.text())`, e ele lança erro se `!r.ok`. Qualquer erro cai na reserva.
- [ ] **Passo 5:** rode `bun test`. Esperado: tudo passa.
- [ ] **Passo 6:** commit: `Extract the field list from the ReplayBR bundle`.

---

### Tarefa 3: API e download em memória

**Arquivos:**
- Modificar: `src/api.ts`, `src/api.test.ts`, `src/download.ts`, `src/download.test.ts`

**Interfaces:**
- Produz:
  - `fetchReplaysForDate(fieldName: string, date: string): Promise<Replay[]>`
  - `class CloudflareBlockedError extends ReplayBrUnavailableError`
  - `isCloudflareChallenge(res: Response): boolean`
  - `ReplayPair = { index: number; timestamp: string; cameras: Uint8Array[] }`
  - `downloadReplayPairs(replays: Replay[], options?: DownloadOptions): Promise<DownloadOutcome>`. Sem `rawDir`. O `DownloadResult` passa a ser `{ bytes: number }`.

- [ ] **Passo 1: testes que falham.**
  - api: `sends credentials: "include"`, conferindo `calls[0].init.credentials === "include"`.
  - api: a mensagem do `CloudflareBlockedError` contém `"www.replaybr.com.br"`.
  - Remova os testes de `setCloudflareClearance`, de `replayBrHeaders` e do cookie.
  - download: `keeps the bytes in memory`. Um lance com 2 câmeras gera um `pair.cameras` com dois `Uint8Array` iguais aos corpos falsos.
  - download: `a Cloudflare challenge on a video is not retried and surfaces CloudflareBlockedError`. A resposta 403 com `cf-mitigated: challenge` gera 1 chamada por URL, não 3. O `failed[0].error` contém `"www.replaybr.com.br"`.
  - Remova os testes de "resume" e do cookie no download.
- [ ] **Passo 2:** rode `bun test src/api.test.ts src/download.test.ts`. Esperado: FAIL nos testes novos.
- [ ] **Passo 3:** em `src/api.ts`:
  - Remova `CloudflareClearance`, `setCloudflareClearance` e `replayBrHeaders`.
  - Crie `isCloudflareChallenge`: status 403 e `cf-mitigated: challenge`.
  - A mensagem do `CloudflareBlockedError` é exatamente: `O Cloudflare bloqueou o acesso. Abra www.replaybr.com.br nesta janela para liberar e tente de novo.`
  - O `fetch` usa `credentials: "include"`.
- [ ] **Passo 4:** em `src/download.ts`:
  - `downloadFile(url): Promise<Uint8Array>` usa `credentials: "include"` e lança `CloudflareBlockedError` quando `isCloudflareChallenge`.
  - `withRetry` relança `CloudflareBlockedError` na hora, sem nova tentativa.
  - Remova `fileSize`, `mkdir`, `Bun.write` e os campos `path` e `skipped`.
- [ ] **Passo 5:** rode `bun test`. Esperado: tudo passa.
- [ ] **Passo 6:** commit: `Fetch replays and videos from the browser session`.

---

### Tarefa 4: leitura de MP4 a partir de Blob

**Arquivos:**
- Modificar: `src/mp4.ts`, `src/mp4.test.ts`

**Interfaces:**
- Produz: `probeDimensions(file: Blob): Promise<Dimensions>`. Remova `probeDuration` e `readMvhdDuration`, que só o `concat` usava.

- [ ] **Passo 1:** nos testes, troque `probeDimensions(path)` por `probeDimensions(Bun.file(path))`. O `BunFile` é um `Blob`. Remova as asserções de `probeDuration`. Acrescente `accepts an in-memory Blob`: `new Blob([await Bun.file(path).arrayBuffer()])` dá `{ width: 704, height: 560 }`.
- [ ] **Passo 2:** rode `bun test src/mp4.test.ts`. Esperado: FAIL, porque a função ainda recebe `string`.
- [ ] **Passo 3:** troque `type Mp4File` por `Blob`. Na mensagem de erro, use `"o vídeo"` no lugar do caminho. A lógica das caixas não muda.
- [ ] **Passo 4:** rode `bun test`. Esperado: tudo passa.
- [ ] **Passo 5:** commit: `Read MP4 dimensions from a Blob`.

---

### Tarefa 5: encoder com ffmpeg.wasm e medição de tempo (decide o encoder)

**Arquivos:**
- Criar: `src/ui/loadFfmpeg.ts`
- Modificar: `src/ffmpeg.ts`, `src/ffmpeg.test.ts`, `vite.config.ts`, `src/probe.ts`
- Remover de `src/ffmpeg.ts`: `resolveFfmpegPath`, `assertFfmpegAvailable`, `run` e `concatClips`. Remover também os testes deles e a dependência `ffmpeg-static`.

**Interfaces:**
- Consome: `Dimensions` de `src/mp4.ts`.
- Produz:
  - `buildFilterGraph(sourceCount: number, cell: Dimensions, columns: number, fps: number): string`
  - `interface ClipEncoder { render(options: EncodeOptions): Promise<Uint8Array> }`
  - `interface EncodeOptions { sources: Uint8Array[]; cell: Dimensions; columns: number; fps: number; crf: number; preset: string }`
  - `createFfmpegEncoder(ffmpeg: FfmpegLike): ClipEncoder`, que recebe uma instância já carregada. `FfmpegLike` é o subconjunto de `@ffmpeg/ffmpeg` usado: `writeFile`, `exec`, `readFile` e `deleteFile`. O `src/ffmpeg.ts` só importa tipos de `@ffmpeg/ffmpeg`, para o `bun test` não tentar resolver imports do Vite.
  - `loadFfmpeg(): Promise<FfmpegLike>` em `src/ui/loadFfmpeg.ts`. Ele cria o `FFmpeg` e chama `load({ coreURL, wasmURL })` com os imports `?url`. Só a interface usa esse arquivo.

- [ ] **Passo 1: testes que falham.**
  - `buildFilterGraph(2, {width:704,height:560}, 2, 30)` dá exatamente a string que o `renderClip` de hoje monta para 2 fontes: `scale`, `pad`, `setsar=1`, `fps=30` em cada fonte, mais `[c0][c1]hstack=inputs=2[v]`.
  - `buildFilterGraph(1, cell, 2, 30)` termina com `pad=1408:560:(ow-iw)/2:0[v]`.
  - `buildFilterGraph(1, cell, 1, 30)` termina com `[c0]null[v]`.
  - `render passes the same x264 args as before`: um `FfmpegLike` falso grava os `args` do `exec`. Eles contêm `-c:v libx264`, `-preset veryfast`, `-crf 20`, `-pix_fmt yuv420p` e `-an`.
  - `render deletes its input and output files even when exec fails`: o `exec` falso lança erro, e o `deleteFile` é chamado para todo arquivo escrito.
- [ ] **Passo 2:** rode `bun test src/ffmpeg.test.ts`. Esperado: FAIL.
- [ ] **Passo 3:** extraia `buildFilterGraph` do `renderClip` atual sem mudar a string. Implemente `loadFfmpeg` com `coreURL` e `wasmURL` vindos de `import ... from "@ffmpeg/core?url"` e `"@ffmpeg/core/wasm?url"`. Implemente `createFfmpegEncoder`:
  - Escreva `in0.mp4`/`in1.mp4`, rode o `exec`, leia `out.mp4`, e apague os arquivos num `finally`.
  - `bun add @ffmpeg/ffmpeg @ffmpeg/util @ffmpeg/core`. No `vite.config.ts`, coloque `optimizeDeps.exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"]`.
- [ ] **Passo 4:** rode `bun test` e `bun run build`. Esperado: tudo passa, e o `dist/` contém o `ffmpeg-core.wasm`.
- [ ] **Passo 5 (medição, manual pelo Claude in Chrome):** no `probe.ts`, baixe as duas câmeras de um lance real da `placar-society`, renderize com `createFfmpegEncoder` e mostre o tempo em segundos e o tamanho da saída. Recarregue a extensão e leia o resultado.
  - **Até 30 s por lance:** siga com o ffmpeg.wasm.
  - **Acima de 30 s:** tente `preset ultrafast`. Se não bastar, limite a altura da célula a 720 linhas, mantendo a proporção. Meça de novo.
  - **Ainda acima:** faça a Tarefa 5b e mostre ao usuário os tempos medidos.
- [ ] **Passo 6:** commit: `Encode clips with ffmpeg.wasm`.

### Tarefa 5b (só se a medição falhar): encoder com Mediabunny

**Arquivos:** criar `src/encoderMediabunny.ts` e `src/encoderMediabunny.test.ts`.

**Interfaces:** produz `createMediabunnyEncoder(): Promise<ClipEncoder>`, com o mesmo contrato do `ClipEncoder` da Tarefa 5.

- [ ] **Passo 1:** escreva um teste de `computeLayout(sourceCount, cell, columns)`, uma função pura que devolve os retângulos de destino de cada fonte. Os retângulos seguem a mesma regra do `scale` + `pad` com `force_original_aspect_ratio=decrease`. Valores esperados: 2 fontes `704x560` em 2 colunas dão `[{x:0,y:0,w:704,h:560},{x:704,y:0,w:704,h:560}]`. Uma fonte em 2 colunas dá `[{x:352,y:0,w:704,h:560}]`.
- [ ] **Passo 2:** rode o teste. Esperado: FAIL.
- [ ] **Passo 3:** implemente com `bun add mediabunny`:
  - Use `Input` com `BlobSource` em cada fonte, e `CanvasSink` ou `VideoSampleSink` para os quadros.
  - Desenhe num `OffscreenCanvas` do tamanho do quadro, a `fps` quadros por segundo, até a fonte mais longa terminar. A fonte mais curta repete o último quadro, como faz o `hstack`.
  - Encode com `CanvasSource` em `avc` para `Output` com `Mp4OutputFormat` e `BufferTarget`.
- [ ] **Passo 4:** meça com o `probe.ts`, como no Passo 5 da Tarefa 5, e troque o encoder usado pelo app. Rode `bun test`. Esperado: tudo passa.
- [ ] **Passo 5:** commit: `Encode clips with WebCodecs via Mediabunny`.

---

### Tarefa 6: pipeline de render na aba, sem concat

**Arquivos:**
- Modificar: `src/render.ts`, `src/render.test.ts`
- Remover: `src/semaphore.ts` e `src/semaphore.test.ts`. O limite servia para vários jobs no servidor, e aqui há um job por aba, já serializado pela cadeia de promises.

**Interfaces:**
- Consome: `downloadReplayPairs` (Tarefa 3), `probeDimensions` (Tarefa 4) e `ClipEncoder` (Tarefa 5).
- Produz:
  - `interface Clip { index: number; timestamp: string; name: string; cameras: 1 | 2; data: Blob }`, em que `name` é `NN_HH-MM-SS.mp4`, igual a hoje.
  - `interface RenderResult { clips: Clip[]; failed: RenderFailure[] }`
  - `interface RenderDeps { downloadReplayPairs: typeof downloadReplayPairs; probeDimensions: typeof probeDimensions; encoder: ClipEncoder }`
  - `renderReplays(request: RenderRequest): Promise<RenderResult>`, em que `RenderRequest` é o atual sem `rawDir`, `outDir` e `concat`, e com `deps: RenderDeps` obrigatório.
  - `RenderProgress.phase` passa a ser `"download" | "render"`.

- [ ] **Passo 1:** adapte os testes atuais ao novo formato e remova os de `concat` e do semáforo. Acrescente:
  - `swap with a single camera renders the same sources`: o `render` falso recebe `sources` com 1 item, igual ao original.
  - `clip data is a video/mp4 Blob with the encoder output`.
- [ ] **Passo 2:** rode `bun test src/render.test.ts`. Esperado: FAIL.
- [ ] **Passo 3:** implemente. `probeDimensions(new Blob([pair.cameras[0]]))` define a célula uma vez por hora. A saída do encoder vira `new Blob([bytes], { type: "video/mp4" })`. Os bytes das câmeras não ficam referenciados depois do render.
- [ ] **Passo 4:** rode `bun test`. Esperado: tudo passa.
- [ ] **Passo 5:** commit: `Render plays in the tab without concat`.

---

### Tarefa 7: zip no navegador

**Arquivos:**
- Criar: `src/zip.ts` (substitui `src/web/zip.ts`) e `src/zip.test.ts` (com os testes de `src/web/zip.test.ts` adaptados)

**Interfaces:** produz `buildZip(files: { name: string; data: Blob }[]): Promise<Blob>`, com `compression: "STORE"` e `generateAsync({ type: "blob" })`.

- [ ] **Passo 1:** adapte os 4 testes atuais para entradas `Blob` e saída `Blob`. A asserção de CRC, de nomes e de bytes idênticos continua.
- [ ] **Passo 2:** rode `bun test src/zip.test.ts`. Esperado: FAIL.
- [ ] **Passo 3:** implemente.
- [ ] **Passo 4:** rode `bun test`. Esperado: tudo passa.
- [ ] **Passo 5:** commit: `Build the zip in the browser`.

---

### Tarefa 8: interface da extensão e remoção do servidor

**Arquivos:**
- Criar: `app.html` (de `public/index.html`), `src/ui/app.ts` (de `public/app.js`) e `src/ui/style.css` (de `public/style.css`)
- Remover: `public/`, `index.ts`, `server.ts`, `src/web/`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `docs/ui.png` (se a imagem não valer mais), `src/probe.ts`, `probe.html`, e as dependências `hono` e `ffmpeg-static`
- Modificar: `README.md`, `.github/workflows/ci.yml` (sai o job `docker`, entra `bun run build` no job `check`), `package.json` (sai o `bin` e os scripts `start` e `web`)

**Interfaces:** consome `loadFields`, `resolveField`, `fetchReplaysForDate`, `groupReplaysByHour`, `renderReplays`, `loadFfmpeg` + `createFfmpegEncoder` (ou `createMediabunnyEncoder`) e `buildZip`.

- [ ] **Passo 1:** porte a interface:
  - `loadFields()` preenche o `<select>`. Se `fromSite` for `false`, mostra o aviso `Lista de quadras do site indisponível. Usando a lista salva.`
  - `fetchReplaysForDate` + `groupReplaysByHour` substituem o `/api/replays`. A prévia continua com `<video src>` direto na URL.
  - "Gerar" chama `renderReplays` com os padrões das Restrições globais. O `onProgress` e o `onClip` atualizam a tela no lugar do `EventSource`.
  - Cada clipe usa `URL.createObjectURL(clip.data)` no `<video>` e no `<a download="<name>">`.
  - "Baixar todos (.zip)" usa `buildZip` e um `<a download="replays-<campo>-<data>-<hora>.zip">`.
  - O ffmpeg carrega uma vez, no primeiro "Gerar", com `loadFfmpeg()`. Se o carregamento falhar, a tela mostra `Não foi possível carregar o ffmpeg: <erro>` e o job não começa.
  - Saem o checkbox `concat`, o `history.pushState`, o `/j/:id` e a expiração.
- [ ] **Passo 2:** apague os arquivos listados e rode `git grep -nE "hono|ffmpeg-static|server\.ts|/api/|EventSource|concat|probeDuration|Semaphore|setCloudflareClearance|replayBrHeaders"`. Esperado: nenhum resultado fora de `docs/`.
- [ ] **Passo 3:** reescreva o README. Explique `bun install`, `bun run build`, como carregar o `dist/` sem compactação, que é preciso abrir `www.replaybr.com.br` uma vez para o Cloudflare liberar, e o `bun test`.
- [ ] **Passo 4:** rode `bun run typecheck`, `bun test` e `bun run build`. Esperado: tudo passa.
- [ ] **Passo 5 (manual, pelo Claude in Chrome):** recarregue a extensão e abra o app pelo ícone. Gere uma hora real da `four-play-3` com todos os lances marcados. Confira:
  - a lista tem 77 quadras e não mostra o aviso;
  - os lances batem com o site;
  - a prévia toca;
  - cada clipe sai lado a lado;
  - o zip abre;
  - **o tempo total fica abaixo de 5 minutos.**

  Mostre ao usuário o tempo medido.
- [ ] **Passo 6:** commit: `Move the app into the extension page and remove the server`.

---
Escrito com IA (Claude Code).
