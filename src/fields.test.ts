import { describe, expect, test } from "bun:test";
import { FIELDS, resolveField } from "./fields.ts";

describe("FIELDS", () => {
  test("exposes the two supported fields, with their official labels", () => {
    expect(FIELDS.map((f) => [f.slug, f.label])).toEqual([
      ["placar-society", "Placar Society"],
      ["four-play-3", "Four Play - Quadra 3"],
    ]);
  });
});

describe("resolveField", () => {
  test("Four Play already comes with the cameras swapped", () => {
    // This field's API numbering doesn't match the physical camera position.
    expect(resolveField("four-play-3")?.defaultSwap).toBe(true);
  });

  test("Placar Society does not swap", () => {
    expect(resolveField("placar-society")?.defaultSwap).toBe(false);
  });

  test("unknown but valid slug becomes a standalone field", () => {
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
  ])("rejects invalid slug %p", (slug) => {
    expect(resolveField(slug)).toBeNull();
  });
});
