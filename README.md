# replaybr-extended

Extensão do Chrome que baixa os replays do [ReplayBR](https://www.replaybr.com.br/replay?fieldName=four-play-3) de uma data e hora e gera **um vídeo por lance**, com as **duas câmeras lado a lado** tocando ao mesmo tempo.

Tudo roda no seu navegador: a busca, o download, a montagem dos vídeos (ffmpeg.wasm) e o `.zip`. O ReplayBR fica atrás da verificação do Cloudflare, e as chamadas saem do seu Chrome, que já passou por ela.

![A interface: seleção de quadra, data e hora, a lista de lances com as câmeras originais abertas para prévia, e o botão de gerar](docs/ui.png)

## Instalar

1. Baixe o `replaybr-extended-<versão>.zip` do [release mais recente](https://github.com/joao-salomao/replaybr-extended/releases/latest) e descompacte.
2. No Chrome, abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta descompactada.
4. Abra `https://www.replaybr.com.br` uma vez nesse Chrome, para o Cloudflare liberar.
5. Clique no ícone da extensão: o app abre numa aba nova.

Para atualizar, descompacte a versão nova por cima da mesma pasta e clique em recarregar (↻) no card da extensão.

### A partir do código

Precisa do [Bun](https://bun.sh). Gere a extensão e carregue a pasta `dist/` no passo 3 acima:

```bash
bun install
bun run build
```

Depois de um `bun run build` novo, clique em recarregar (↻) no card da extensão.

## Usar

Escolha a quadra, a data e a hora, marque os lances e clique em **Gerar**. Cada clipe aparece para tocar e baixar assim que fica pronto, e no final há o download de todos em `.zip`. Os vídeos ficam na memória da aba: fechou a aba, perdeu os clipes.

Se aparecer a mensagem do Cloudflare, abra `www.replaybr.com.br` nessa mesma janela e tente de novo.

### Quadras

A lista vem do próprio site: a extensão lê o mapa `humanReadableFieldNameMapping` do JavaScript da página e tira as quadras que o site marca como inativas. Se o site mudar e a leitura falhar, a extensão usa a lista salva em `src/fields.ts` e avisa. O seletor de **Quadra** tem busca: digite parte do nome, sem se preocupar com acentos, e use as setas e o Enter. Um slug digitado (o `fieldName` da URL do site) aparece como opção, para quadras fora da lista.

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

### Publicar uma versão

1. Suba o `version` do `package.json` (o manifesto lê a mesma versão) e faça o merge no `main`.
2. Em **Actions > Release > Run workflow**, rode no `main`.

O workflow roda o typecheck e os testes, gera o `dist/`, publica o release `v<versão>` com o `.zip` anexado e para se essa tag já existir.

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
src/render.ts        pipeline download → render, vários lances em paralelo
src/zip.ts           o .zip de todos os clipes
e2e/                 teste ponta a ponta e fixtures
```
