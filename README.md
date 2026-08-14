# replaybr-extended

Baixa os replays do [ReplayBR](https://www.replaybr.com.br/replay?fieldName=four-play-3) de uma data e hora e gera **um vídeo por lance**, com as **duas câmeras lado a lado** tocando ao mesmo tempo.

Disponível como CLI e como aplicação web.

Quadras com uma câmera só também funcionam — veja [Câmera única](#câmera-única).

## Requisitos

- `bun`
- `ffmpeg` e `ffprobe` no PATH (`brew install ffmpeg`)

```bash
bun install
```

## Uso

Listar os horários disponíveis em uma data:

```bash
bun run index.ts 2026-07-29 --list
```

Gerar os vídeos de um horário:

```bash
bun run index.ts 2026-07-29 20
```

Saída — **um arquivo por lance**, nomeado pelo horário em que aconteceu:

```
output/placar-society/2026-07-29/20/
  01_20-02-49.mp4    1408x560 · 30s
  02_20-08-14.mp4    1408x560 · 30s
  …
```

Para também juntar tudo em um vídeo único (`completo.mp4`), use `--concat`:

```bash
bun run index.ts 2026-07-29 20 --concat
```

### Opções

| Opção | Padrão | Descrição |
|---|---|---|
| `-f, --field <slug>` | `placar-society` | Campo (o `fieldName` da URL do site) |
| `-l, --list` | — | Lista os horários da data e sai |
| `-c, --concat` | — | Gera também um `completo.mp4` com todos os lances |
| `-s, --swap` | — | Inverte os lados das câmeras (`câmera 2 \| câmera 1`) |
| `-o, --out-dir <dir>` | `output` | Diretório de saída |
| `--downloads <dir>` | `downloads` | Diretório dos arquivos brutos |
| `-j, --concurrency <n>` | `4` | Downloads em paralelo |
| `--crf <n>` | `20` | Qualidade x264 (menor = melhor) |
| `--preset <p>` | `veryfast` | Preset x264 |
| `--fps <n>` | `30` | FPS de saída |

O horário é a **hora cheia** exibida no site, e aceita `20`, `20:00`, `2030` ou `20h30` — todos resolvem para a hora `20`.

## Como funciona

1. **`src/api.ts`** — consulta `GET https://replays.replaybr.com.br/available-hours?fieldName=…&date=…`, que devolve `{ replays: [{ timestamp, camera1_url, camera2_url }] }`, e agrupa os replays **pela hora do timestamp, igual ao site oficial** — é o mesmo segmento que aparece na URL do vídeo (`.../2026-08-13/21/...`).

2. **`src/download.ts`** — baixa `camera1.mp4` e `camera2.mp4` de cada replay (~7 MB cada, 30s, 704x560, sem áudio), com paralelismo limitado. Arquivos já baixados são reaproveitados.

3. **`src/ffmpeg.ts`** — para cada replay, normaliza as câmeras para o mesmo tamanho e faz `hstack` (1408x560), gerando um arquivo por lance. Com `--concat`, junta os clipes com o concat demuxer sem recodificar — o que só funciona porque todos foram codificados com parâmetros idênticos.

### Câmera única

`camera2_url` é opcional **por lance**, não por campo: `four-play-1` não tem nenhuma segunda câmera, e `four-play-2` tem em apenas 7 dos 44 lances de um dia. A regra é decidida por horário:

- Se **nenhum** lance do horário tem segunda câmera → os clipes saem em largura simples (704x560).
- Se **algum** tem → o quadro é duplo (1408x560) e os lances de câmera única ficam centralizados, com barras nas laterais.

Assim todos os clipes de um horário mantêm as mesmas dimensões, e o `--concat` sem recodificar continua válido.

A duração também varia por campo: `placar-society` grava ~30s por lance, enquanto `four-play-1` grava ~3s. O resumo ao final mede a duração real em vez de assumir.

### Ordem das câmeras

Por padrão a `camera1` fica à esquerda e a `camera2` à direita. A numeração da API, porém, não descreve a posição física das câmeras em campo — nos vídeos do Four Play os lados saem trocados em relação ao que se espera. Use `--swap` para inverter:

```bash
bun run index.ts 2026-07-29 20 --field four-play-2 --swap
```

A troca acontece na renderização (os brutos continuam nomeados pela numeração da API), e lances de câmera única não são afetados.

### Estrutura de saída (gerada)

```
output/<campo>/<data>/<HH>/
  01_20-02-49.mp4, 02_20-08-14.mp4, …   ← um vídeo por lance (câmera 1 | câmera 2)
  completo.mp4                          ← só com --concat
```

Os brutos (`downloads/<campo>/<data>/<HH>/raw/`) são apagados logo depois que cada lance termina de renderizar — o disco não acumula mais que um par de câmeras por vez.

## Aplicação web

Sobe a interface em `http://localhost:3000`:

```bash
bun run web
```

Escolha a quadra, a data e a hora, marque os lances que quer e clique em Gerar. O progresso aparece ao vivo e cada clipe fica disponível para reproduzir e baixar assim que sai do ffmpeg. Há também o vídeo único (`--concat` equivalente) e o download de todos em `.zip`.

Os arquivos são **efêmeros**: somem 2h depois que o job termina, e um restart do servidor limpa tudo.

### Deploy com Docker

O host precisa de Docker, não de ffmpeg — ele vem dentro da imagem.

```bash
docker compose up -d
```

Variáveis: `PORT` (padrão `3000`) e `WORK_DIR` (padrão `/app/work`, montado como volume).

## Binário único

Gera um executável standalone em `dist/replaybr-extended`, com o runtime do Bun embutido:

```bash
bun run build
```

O binário roda sem Bun instalado e de qualquer diretório (os caminhos de saída são relativos ao diretório atual):

```bash
./dist/replaybr-extended 2026-07-29 20
```

Por incluir o runtime, o binário é grande (~58 MB no macOS arm64, ~100 MB no alvo Linux). E **`ffmpeg` e `ffprobe` continuam sendo dependências externas** — não são embutidos.

Para gerar para outra plataforma, acrescente `--target`:

```bash
bun build ./index.ts --compile --minify --target=bun-linux-x64 --outfile dist/replaybr-extended-linux
```

## Desenvolvimento

O projeto é TypeScript puro. Bun executa os `.ts` diretamente, então **não há build step** para rodar — `tsc` é usado só para checagem de tipos e para o suporte no editor.

```bash
bun run typecheck
```

O `tsconfig.json` roda em modo `strict` com `noUncheckedIndexedAccess`, e `@types/bun` fornece os tipos das APIs do Bun (`Bun.write`, `Bun.spawn`, `Bun.file`).

```
index.ts            CLI: argumentos, validação e progresso
server.ts           web: bootstrap, sweeper e estáticos
src/api.ts          cliente da API + agrupamento por hora
src/fields.ts       quadras suportadas e rótulos
src/download.ts     download paralelo, com retry e entrega por conclusão
src/ffmpeg.ts       hstack das duas câmeras + concat sem recodificar
src/render.ts       pipeline download → render → concat
src/web/            jobs, rotas e zip
public/             interface
```
