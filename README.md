# replaybr-extended

Extensão do Chrome que baixa os replays do [ReplayBR](https://www.replaybr.com.br/replay?fieldName=four-play-3) de uma data e hora e gera **um vídeo por lance**, com as **duas câmeras lado a lado** tocando ao mesmo tempo.

Tudo roda no seu navegador: a busca, o download, a montagem dos vídeos (ffmpeg.wasm) e o `.zip`. O ReplayBR fica atrás da verificação do Cloudflare, e como as chamadas saem do seu Chrome, que já passou por ela, nada precisa ser copiado nem colado.

![A interface: seleção de quadra, data e hora, a lista de lances com as câmeras originais abertas para prévia, e o botão de gerar](docs/ui.png)

## Instalar

Precisa do [Bun](https://bun.sh).

```bash
bun install
bun run build
```

1. No Chrome, abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e escolha a pasta `dist/`.
3. Abra `https://www.replaybr.com.br` uma vez nesse Chrome, para o Cloudflare liberar.
4. Clique no ícone da extensão: o app abre numa aba nova.

Depois de um `bun run build` novo, clique em recarregar (↻) no card da extensão.

## Usar

Escolha a quadra, a data e a hora, marque os lances e clique em **Gerar**. Cada clipe aparece para tocar e baixar assim que fica pronto, e no final há o download de todos em `.zip`. Os vídeos ficam na memória da aba: fechou a aba, perdeu os clipes.

Se aparecer a mensagem do Cloudflare, abra `www.replaybr.com.br` nessa mesma janela e tente de novo.

### Quadras

A lista vem do próprio site: a extensão lê o mapa `humanReadableFieldNameMapping` do JavaScript da página e tira as quadras que o site marca como inativas. Se o site mudar e a leitura falhar, a extensão usa a lista salva em `src/fields.ts` e avisa. O campo **Quadra** filtra a lista enquanto você digita, e também aceita um slug digitado direto (o `fieldName` da URL do site), para quadras fora da lista.

### Câmera única

Quadras com uma câmera só também funcionam. Se a hora tiver lances de uma e de duas câmeras, o lance de uma câmera sai centralizado no mesmo quadro de duas colunas, para todos os clipes terem o mesmo tamanho.

### Ordem das câmeras

A `camera1` fica à esquerda e a `camera2` à direita. A numeração da API, porém, não descreve a posição física das câmeras em campo: na Four Play - Quadra 3 os lados saem trocados. Para essas quadras, **Inverter câmeras** já vem marcado (`SWAP_BY_DEFAULT` em `src/fields.ts`).

## Desenvolvimento

```bash
bun run typecheck   # tsc, só checagem de tipos
bun test            # lógica pura, sem rede
bun run e2e         # build + a extensão no Chromium do Playwright
```

O `bun run e2e` precisa do Chromium do Playwright uma vez: `bunx playwright install chromium`. Ele carrega o `dist/` e responde às chamadas aos dois domínios do ReplayBR com as fixtures de `e2e/`, então não toca o site real.

```
manifest.config.ts   manifesto MV3 (CRXJS)
app.html             página do app
src/background.ts    o ícone abre o app numa aba
src/ui/              interface e carregamento do ffmpeg.wasm
src/api.ts           cliente da API + agrupamento por hora
src/fields.ts        lista salva de quadras
src/fieldsExtract.ts lista de quadras lida do site
src/download.ts      download paralelo para a memória, com retry
src/encoder.ts       filtro lado a lado + ffmpeg.wasm
src/mp4.ts           dimensões via árvore de caixas MP4
src/render.ts        pipeline download → render, um lance por vez
src/zip.ts           o .zip de todos os clipes
e2e/                 teste ponta a ponta e fixtures
```
