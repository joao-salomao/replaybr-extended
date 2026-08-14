import { describe, expect, test } from "bun:test";
import { FIELDS, resolveField } from "./fields.ts";

describe("FIELDS", () => {
  test("expõe as duas quadras suportadas, com os rótulos oficiais", () => {
    expect(FIELDS.map((f) => [f.slug, f.label])).toEqual([
      ["placar-society", "Placar Society"],
      ["four-play-3", "Four Play - Quadra 3"],
    ]);
  });
});

describe("resolveField", () => {
  test("Four Play já vem com as câmeras invertidas", () => {
    // A numeração da API não corresponde à posição física nessa quadra.
    expect(resolveField("four-play-3")?.defaultSwap).toBe(true);
  });

  test("Placar Society não inverte", () => {
    expect(resolveField("placar-society")?.defaultSwap).toBe(false);
  });

  test("slug desconhecido mas válido vira quadra avulsa", () => {
    expect(resolveField("global-society")).toEqual({
      slug: "global-society",
      label: "global-society",
      defaultSwap: false,
    });
  });

  test.each([
    ["../etc/passwd"],
    ["four/play"],
    ["Four-Play-3"],
    ["four_play_3"],
    [""],
    ["-four-play"],
    ["four--play"],
  ])("rejeita o slug inválido %p", (slug) => {
    expect(resolveField(slug)).toBeNull();
  });
});
