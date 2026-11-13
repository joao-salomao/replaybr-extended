import { describe, expect, test } from "bun:test";
import { FIELDS } from "./fields.ts";
import { buildFieldList, loadFields, parseFieldsFromBundle } from "./fieldsExtract.ts";

/**
 * Trimmed from the real chunk (`3y38o7j2dxloe.js`, seen on 2026-11-13): the
 * inactive Set, then the module's export registration with the mapping.
 * `olaria` is an unquoted key, as the minifier emits it.
 */
const BUNDLE =
  'let n=new Set(["s-e-sao-paulo","golacos-society-2"]);' +
  'e.s(["getFieldInterval",0,r,"humanReadableFieldNameMapping",0,' +
  '{olaria:"Olaria","luiza-futsal":"Guabisoccer Futsal","four-play-3":"Four Play - Quadra 3"},' +
  '"isFieldInactive",0,function(e){return!!e&&n.has(e.trim().toLowerCase())}],85630);';

const PAGE =
  '<html><script src="/_next/static/chunks/a.js"></script>' +
  '<script src="/_next/static/chunks/b.js"></script></html>';

describe("parseFieldsFromBundle", () => {
  test("parses quoted and unquoted keys", () => {
    expect(parseFieldsFromBundle(BUNDLE)?.labels).toEqual({
      olaria: "Olaria",
      "luiza-futsal": "Guabisoccer Futsal",
      "four-play-3": "Four Play - Quadra 3",
    });
  });

  test("reads the inactive set", () => {
    expect(parseFieldsFromBundle(BUNDLE)?.inactive).toEqual([
      "s-e-sao-paulo",
      "golacos-society-2",
    ]);
  });

  test("returns null when the export is missing", () => {
    expect(parseFieldsFromBundle("var a=1")).toBeNull();
  });
});

describe("buildFieldList", () => {
  test("drops inactive, sorts by label in pt-BR, applies SWAP_BY_DEFAULT", () => {
    const fields = buildFieldList(
      { "four-play-3": "Four Play - Quadra 3", olaria: "Olaria", "golacos-society-2": "Golaços" },
      ["golacos-society-2"],
    );

    expect(fields).toEqual([
      { slug: "four-play-3", label: "Four Play - Quadra 3", defaultSwap: true },
      { slug: "olaria", label: "Olaria", defaultSwap: false },
    ]);
  });
});

describe("loadFields", () => {
  test("falls back to FIELDS when no chunk has the mapping", async () => {
    const fetchText = async (url: string) => (url.endsWith(".js") ? "var a=1" : PAGE);

    expect(await loadFields(fetchText)).toEqual({ fields: FIELDS, fromSite: false });
  });

  test("falls back when fetch throws", async () => {
    const fetchText = async () => {
      throw new Error("403");
    };

    expect(await loadFields(fetchText)).toEqual({ fields: FIELDS, fromSite: false });
  });

  test("uses the site list when found", async () => {
    const requested: string[] = [];
    const fetchText = async (url: string) => {
      requested.push(url);
      if (url.endsWith("/b.js")) return BUNDLE;
      return url.endsWith(".js") ? "var a=1" : PAGE;
    };

    const result = await loadFields(fetchText);

    expect(result.fromSite).toBe(true);
    expect(result.fields.map((f) => f.slug)).toContain("four-play-3");
    // Chunk paths resolve against the site, not the extension's origin.
    expect(requested).toContain("https://www.replaybr.com.br/_next/static/chunks/b.js");
  });
});
