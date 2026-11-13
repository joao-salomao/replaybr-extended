import { describe, expect, test } from "bun:test";
import { FIELDS, fieldFromInput, resolveField } from "./fields.ts";

describe("FIELDS", () => {
  test("lists the 77 active fields from the official site", () => {
    expect(FIELDS).toHaveLength(77);
    expect(FIELDS.find((f) => f.slug === "four-play-1")?.label).toBe("Four Play - Quadra 1");
  });

  test("leaves out the fields the site marks inactive", () => {
    const slugs = FIELDS.map((f) => f.slug);
    for (const inactive of ["arena-beach-prime-1", "arena-beach-prime-2", "golacos-society-1", "golacos-society-2"]) {
      expect(slugs).not.toContain(inactive);
    }
  });

  test("is sorted by label, for the dropdown", () => {
    const labels = FIELDS.map((f) => f.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "pt-BR")));
  });

  test("every slug is unique and valid", () => {
    const slugs = FIELDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(resolveField(slug)?.slug).toBe(slug);
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
    expect(resolveField("campo-novo")).toEqual({
      slug: "campo-novo",
      label: "campo-novo",
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

describe("fieldFromInput", () => {
  const fields = [
    { slug: "four-play-3", label: "Four Play - Quadra 3", defaultSwap: true },
    { slug: "olaria", label: "Olaria", defaultSwap: false },
  ];

  test("a picked label resolves to its field", () => {
    expect(fieldFromInput("Four Play - Quadra 3", fields)?.slug).toBe("four-play-3");
  });

  test("ignores case and surrounding spaces", () => {
    expect(fieldFromInput("  olaria ", fields)?.slug).toBe("olaria");
  });

  test("a typed slug of a field outside the list still works", () => {
    expect(fieldFromInput("campo-novo", fields)).toEqual({
      slug: "campo-novo",
      label: "campo-novo",
      defaultSwap: false,
    });
  });

  test("partial text that is neither a label nor a valid slug is no field", () => {
    expect(fieldFromInput("Four Pl", fields)).toBeNull();
    expect(fieldFromInput("", fields)).toBeNull();
  });
});
