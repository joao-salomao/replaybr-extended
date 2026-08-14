import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zip.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replaybr-zip-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Roda o `unzip` do sistema e devolve saída e código de saída. */
async function unzip(args: string[]): Promise<{ saida: string; code: number }> {
  const proc = Bun.spawn(["unzip", ...args], { stdout: "pipe", stderr: "pipe" });
  const [saida, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { saida, code };
}

test("o unzip do sistema valida o CRC de todas as entradas", async () => {
  const primeiro = join(dir, "01_20-34-25.mp4");
  const segundo = join(dir, "02_20-35-39.mp4");
  await Bun.write(primeiro, "conteúdo do primeiro");
  // Bytes binários de verdade: texto não exercita o formato direito.
  await Bun.write(
    segundo,
    new Uint8Array(Array.from({ length: 3000 }, (_, i) => i % 256)),
  );

  const saida = await buildZip([primeiro, segundo], join(dir, "todos.zip"));
  const { code } = await unzip(["-t", saida]);

  expect(code).toBe(0);
});

test("lista as entradas pelo nome do arquivo, sem caminho", async () => {
  const clipe = join(dir, "01_20-34-25.mp4");
  await Bun.write(clipe, "vídeo");

  const saida = await buildZip([clipe], join(dir, "todos.zip"));
  const { saida: listagem } = await unzip(["-l", saida]);

  expect(listagem).toContain("01_20-34-25.mp4");
  // O nome da entrada não pode carregar o caminho absoluto do servidor.
  expect(listagem).not.toContain(clipe);
});

test("o conteúdo extraído é idêntico ao original, byte a byte", async () => {
  const clipe = join(dir, "01_20-34-25.mp4");
  const original = new Uint8Array(
    Array.from({ length: 5000 }, (_, i) => (i * 7) % 256),
  );
  await Bun.write(clipe, original);

  const saida = await buildZip([clipe], join(dir, "todos.zip"));
  const destino = join(dir, "extraido");
  await unzip(["-o", "-q", saida, "-d", destino]);

  const extraido = new Uint8Array(
    await Bun.file(join(destino, "01_20-34-25.mp4")).arrayBuffer(),
  );
  expect(extraido).toEqual(original);
});

test("lista vazia produz um zip estruturalmente válido", async () => {
  const saida = await buildZip([], join(dir, "vazio.zip"));
  const bytes = new Uint8Array(await Bun.file(saida).arrayBuffer());

  // Só o End Of Central Directory: 22 bytes começando por "PK\x05\x06".
  expect(bytes).toHaveLength(22);
  expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
});
