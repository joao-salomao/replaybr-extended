import { createReadStream } from "node:fs";
import { basename } from "node:path";
import JSZip from "jszip";

/**
 * Empacota os clipes de um job num `.zip`.
 *
 * Tudo em stream: `createReadStream` na entrada e `generateNodeStream` na
 * saída. Com `generateAsync`, um zip de 200 MB custaria ~475 MB de RSS, e como
 * não há fila dois downloads simultâneos dobrariam isso — em stream o pico fica
 * em ~67 MB para o mesmo arquivo.
 *
 * `STORE` porque mp4 já vem comprimido: deflate aqui gasta CPU sem reduzir nada.
 */
export async function buildZip(
  paths: string[],
  output: string,
): Promise<string> {
  const zip = new JSZip();
  for (const path of paths) {
    // O nome dentro do zip é só o arquivo: o caminho no servidor não vaza.
    zip.file(basename(path), createReadStream(path));
  }

  const sink = Bun.file(output).writer();
  const stream = zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "STORE",
  });

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (pedaco: Uint8Array) => {
      sink.write(pedaco);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  await sink.end();

  return output;
}
