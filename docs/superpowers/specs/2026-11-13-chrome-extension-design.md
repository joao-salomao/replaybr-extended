# replaybr-extended como extensão do Chrome

Data: 2026-11-13

## Intenção

O ReplayBR (`www.replaybr.com.br` e a API `replays.replaybr.com.br`) agora fica atrás da verificação anti-bot do Cloudflare. O servidor Bun leva 403 em toda chamada, a menos que alguém cole um `cf_clearance` e o User-Agent no boot. Esse cookie expira, e o processo é manual.

O app inteiro passa a rodar como extensão do Chrome. As chamadas saem do navegador do usuário, que já passou pela verificação. Assim acaba a etapa de colar o cookie.

## Objetivos

O app mantém o que o usuário faz hoje na interface web (`public/`):

1. Escolher a quadra. A lista vem do site oficial (ver "Lista de quadras").
2. Escolher a data e ver os lances agrupados por hora (`groupReplaysByHour`, igual ao site).
3. Abrir a prévia das câmeras originais de um lance, com `<video>` direto na URL do vídeo.
4. Marcar os lances e a opção de inverter as câmeras (`swap`). O valor inicial vem de `defaultSwap` da quadra.
5. Gerar um vídeo por lance, com as duas câmeras lado a lado. Uma câmera só fica centralizada no quadro de duas colunas. A regra é a de `renderClip` em `src/ffmpeg.ts`.
6. Ver o progresso ao vivo: baixando, renderizando e cada clipe pronto assim que sai.
7. Baixar cada clipe e baixar todos num `.zip`.

**Meta de tempo (do usuário):** os vídeos de uma hora inteira ficam prontos para baixar em **no máximo 5 minutos**, no Mac do usuário. O tempo conta do clique em "Gerar" até o último clipe pronto. Uma hora tem em geral de 5 a 10 lances, então cada lance tem de 30 a 60 segundos para baixar e renderizar.

## Fora do escopo

- **Juntar a hora num vídeo só.** A opção `concat` sai. Decisão do usuário.
- **CLI, servidor web e Docker.** São apagados: `index.ts`, `server.ts`, `src/web/`, `Dockerfile`, `docker-compose.yml`, `.dockerignore` e a dependência `ffmpeg-static`. Decisão minha, não contestada pelo usuário.
- **Links de job compartilháveis** (`/j/:id`) e jobs que sobrevivem a fechar a aba. Os clipes ficam na memória da aba até ela fechar. Decisão minha: com o servidor fora, não há onde guardar, e o uso é pessoal.
- **Publicar na Chrome Web Store.** A extensão é carregada sem empacotar (`chrome://extensions` > "Carregar sem compactação"). Decisão minha.
- **Firefox e outros navegadores.**

## O que não pode acontecer

- O usuário precisar colar cookie, User-Agent ou qualquer valor do DevTools.
- A extensão ler, guardar ou mandar o `cf_clearance` para qualquer lugar. Ela só usa a sessão que o navegador já tem.

## Restrições

- **Manifest V3.** Não pode carregar código remoto. O núcleo do `ffmpeg.wasm` (`ffmpeg-core.js` e `ffmpeg-core.wasm`) vai dentro do pacote da extensão. A CSP das páginas da extensão precisa de `'wasm-unsafe-eval'`.
- **Memória do wasm.** O `ffmpeg.wasm` tem limite de cerca de 2 GB e um sistema de arquivos em memória. Cada lance é baixado, renderizado e apagado do FS do ffmpeg antes do próximo. Um lance tem duas entradas de cerca de 7 MB cada.
- **Núcleo single-thread do ffmpeg.wasm.** O núcleo multi-thread precisa de isolamento cross-origin (COEP `require-corp`). Isso quebra a prévia com `<video src>` apontando para `replays.replaybr.com.br`, que não manda header CORP. Decisão minha: usar o núcleo single-thread. Ele é mais lento, mas a prévia continua funcionando.
- **A lista de quadras vem de um bundle minificado.** O nome do chunk muda a cada deploy, e o formato pode mudar.

## Abordagens consideradas

### Onde o app roda

- **A. Página própria da extensão (escolhida pelo usuário).** É uma aba `chrome-extension://<id>/app.html`, aberta pelo ícone da extensão. As chamadas a `replays.replaybr.com.br` e `www.replaybr.com.br` usam `host_permissions`. Isso passa por cima do CORS, e o Chrome manda os cookies do domínio, inclusive o `cf_clearance`. A interface fica independente do site. **Risco aberto:** ninguém testou se o Cloudflare aceita essas chamadas. A origem é `chrome-extension://` e o `Sec-Fetch-Site` é diferente do de uma chamada feita pelo site.
- **B. Interface injetada na página do ReplayBR.** Um content script desenha o app dentro de `www.replaybr.com.br`. As chamadas saem da origem do site. Já foi testado que isso passa pelo Cloudflare. O CSS do site e o nosso se misturam, e um redesign deles pode quebrar a interface.

### Como montar o vídeo

- **A. WebCodecs com a biblioteca Mediabunny.** Os quadros são desenhados num canvas e encodados em H.264 pelo hardware. É rápido, mas a montagem é reescrita do zero.
- **B. `ffmpeg.wasm` (escolhida pelo usuário).** Reaproveita o filtro atual: `scale`, `pad`, `setsar`, `fps` e `hstack`, com `libx264`. O pacote tem cerca de 30 MB e roda bem mais devagar que o ffmpeg nativo.

### Build

Vite com o plugin **CRXJS** (`@crxjs/vite-plugin`), escolhido pelo usuário. Ele gera a pasta `dist/` a partir do `manifest`, com recarga durante o desenvolvimento.

## Primeiro passo: teste do Cloudflare

Antes de tudo, faça uma extensão mínima com uma página. A página precisa:

1. Chamar `https://replays.replaybr.com.br/available-hours?fieldName=four-play-3&date=<ontem>` e mostrar o status.
2. Baixar um `camera1_url` da resposta e mostrar o tamanho.
3. Baixar o HTML de `https://www.replaybr.com.br/replay?fieldName=four-play-3` e os chunks JS, que a lista de quadras usa.

4. Renderizar esse lance com o `ffmpeg.wasm` single-thread e o filtro de hoje, e mostrar o tempo. Use um lance com duas câmeras. A `placar-society` serve como caso pesado, porque grava cerca de 30 s por lance.

Se o tempo de um lance passar de 30 segundos, tente nesta ordem:
- `preset ultrafast`;
- reduzir a altura da célula, por exemplo para 720 linhas.

Se nada disso chegar à meta de 5 minutos por hora, troque a montagem para WebCodecs com a Mediabunny (a abordagem A de "Como montar o vídeo"). O usuário liberou essa troca. Mostre os tempos medidos ao usuário quando trocar.

Faça o teste com o navegador já liberado, depois de abrir o site uma vez. O usuário carrega a extensão sem empacotar em `chrome://extensions`, porque um agente não controla essa página. Depois disso, o agente pode rodar o teste e o primeiro fluxo completo pelo Claude in Chrome, no Chrome do usuário. Decisão minha. Se os passos 1 a 3 derem 200, siga com a abordagem A. Se algum der 403 com `cf-mitigated: challenge`, **pare e leve ao usuário**. A saída provável é a abordagem B, mas a escolha é dele.

## Desenho

### Peças

- **`manifest`** (MV3, gerado pelo CRXJS): `action` abre `app.html` numa aba nova. `host_permissions` para `https://replays.replaybr.com.br/*` e `https://www.replaybr.com.br/*`. A CSP de `extension_pages` inclui `'wasm-unsafe-eval'`. Permissão `downloads` só se `chrome.downloads` for usado (ver "Deixado para quem constrói").
- **`app.html` e a interface:** parte do `public/index.html`, `public/app.js` e `public/style.css`. Sai o que dependia do servidor: `fetch('/api/...')`, `EventSource` e as URLs `/files/...`. Entra uma chamada direta ao pipeline local.
- **API** (`src/api.ts`): `fetchReplaysForDate` e `groupReplaysByHour` continuam. Saem `CloudflareClearance`, `setCloudflareClearance` e `replayBrHeaders`, porque o navegador cuida da sessão. O `CloudflareBlockedError` fica. A mensagem passa a ser: "Abra www.replaybr.com.br nesta janela para o Cloudflare liberar, e tente de novo". As chamadas usam `credentials: "include"`.
- **Lista de quadras** (`src/fields.ts` + extração nova): ver a seção abaixo.
- **Download** (`src/download.ts`): baixa para `Uint8Array` em memória, não para disco. Mantém o retry e o timeout por arquivo.
- **Leitura de MP4** (`src/mp4.ts`): hoje lê faixas de bytes com `Bun.file`. Passa a ler de `Uint8Array` ou `Blob`. A lógica das caixas não muda.
- **Render** (`src/ffmpeg.ts` + `src/render.ts`): usa `@ffmpeg/ffmpeg` e o núcleo local. Para cada lance: escreve as câmeras no FS do ffmpeg, roda o mesmo filtro de hoje e lê o MP4 de saída. Depois apaga as entradas e a saída do FS. Todos os clipes de uma hora saem com a mesma medida: a primeira câmera define a célula, como hoje. Os padrões continuam: `fps 30`, `crf 20`, `preset veryfast`. Um encode por vez.
- **Zip** (`src/web/zip.ts`): continua com JSZip e roda no navegador.

### Lista de quadras

Na abertura, a extensão:

1. Baixa `https://www.replaybr.com.br/replay`.
2. Pega os `<script src="/_next/static/chunks/*.js">` e baixa cada um.
3. Procura o texto `"humanReadableFieldNameMapping",0,{`. Lê o objeto até a chave que fecha e extrai os pares chave e valor com regex. A chave pode vir com ou sem aspas. Não use `eval`.
4. Procura o `new Set([...])` que alimenta `isFieldInactive`, logo antes do registro dos exports, e tira esses slugs.
5. Ordena por nome (`localeCompare(..., "pt-BR")`) e aplica `defaultSwap` a partir de uma tabela local. Hoje só `four-play-3` é `true`.

Se a extração falhar, use o `FIELDS` de `src/fields.ts` como reserva (77 quadras, extraídas em 2026-11-13). A interface mostra um aviso discreto. A opção "Outra quadra…" continua.

Formato visto em 2026-11-13, no chunk `3y38o7j2dxloe.js`:

    ...,"golacos-society-2"]);e.s(["getFieldInterval",0,r,"humanReadableFieldNameMapping",0,{olaria:"Olaria","luiza-futsal":"Guabisoccer Futsal",...},"isFieldInactive",0,function(e){return!!e&&n.has(e.trim().toLowerCase())}],...)

### Erros

- 403 com `cf-mitigated: challenge` na API ou no vídeo: a mensagem do Cloudflare acima.
- Falha num lance: o lance aparece como falho e os outros continuam, como hoje.
- `ffmpeg.wasm` sem memória ou falhando ao carregar: a mensagem mostra o erro, e o job para.

### Testes

A lógica pura mantém os testes atuais: agrupamento por hora, `normalizeHour`, `resolveField`, leitura de MP4 a partir de bytes, montagem do filtro e o pipeline com dependências falsas. Entra um teste novo para a extração da lista. Use um trecho fixo do chunk real como fixture, incluindo a variante sem aspas. O teste do Cloudflare acima é manual. A primeira passagem pelo fluxo completo também é manual, com uma hora real da `four-play-3`.

## Deixado para quem constrói

- A estrutura de pastas e o runner de testes. Pode manter o `bun test` para a lógica pura ou trocar por Vitest.
- Se o download dos clipes usa `<a download>` com URL de blob ou `chrome.downloads`.
- Se o `ffmpeg.wasm` roda num worker próprio ou no worker que o pacote cria. Ele precisa funcionar sob a CSP do MV3.
- O formato do progresso na interface, desde que mostre as fases e cada clipe assim que fica pronto.
- O texto do README, que precisa explicar como carregar a extensão sem empacotar.

---
Escrito com IA (Claude Code).
