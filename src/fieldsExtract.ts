import { FIELDS, SWAP_BY_DEFAULT, type Field } from "./fields.ts";

const SITE = "https://www.replaybr.com.br";
const MAPPING_EXPORT = '"humanReadableFieldNameMapping",0,{';
// Keys come quoted ("four-play-3") or bare (olaria) from the minifier.
const PAIR = /(?:"([^"]+)"|([A-Za-z_$][\w$]*)):"([^"]*)"/g;
const CHUNK = /<script[^>]+src="(\/_next\/static\/chunks\/[^"]+\.js)"/g;
/** How long the dropdown waits for the site before using the saved list. */
const LOAD_BUDGET_MS = 8_000;

export interface BundleFields {
  labels: Record<string, string>;
  inactive: string[];
}

/**
 * Reads the field list straight out of the site's minified bundle, without
 * eval: the `humanReadableFieldNameMapping` object and the Set behind
 * `isFieldInactive`, which sits just before the module's export registration.
 */
export function parseFieldsFromBundle(js: string): BundleFields | null {
  const at = js.indexOf(MAPPING_EXPORT);
  if (at < 0) return null;

  const start = at + MAPPING_EXPORT.length - 1;
  let depth = 0;
  let end = start;
  for (; end < js.length; end++) {
    if (js[end] === "{") depth++;
    else if (js[end] === "}" && --depth === 0) break;
  }
  const object = js.slice(start, end + 1);

  const labels: Record<string, string> = {};
  for (const [, quoted, bare, label] of object.matchAll(PAIR)) {
    labels[(quoted ?? bare)!] = label!;
  }

  const registration = js.lastIndexOf("e.s([", at);
  const set = js.lastIndexOf("new Set([", registration);
  let inactive: string[] = [];
  if (set >= 0) {
    const open = set + "new Set(".length;
    try {
      inactive = JSON.parse(js.slice(open, js.indexOf("]", open) + 1)) as string[];
    } catch {
      // A malformed Set only costs the inactive filter, not the list.
    }
  }

  return { labels, inactive };
}

export function buildFieldList(labels: Record<string, string>, inactive: string[]): Field[] {
  const skip = new Set(inactive);
  return Object.entries(labels)
    .filter(([slug]) => !skip.has(slug))
    .map(([slug, label]) => ({ slug, label, defaultSwap: SWAP_BY_DEFAULT.has(slug) }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

async function fetchSiteText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`${res.status} para ${url}`);
  return res.text();
}

/**
 * The field list as the site ships it today. The chunk name changes on every
 * deploy, so every chunk the page loads is searched for the export. Anything
 * going wrong, or the site taking longer than `budgetMs`, falls back to the
 * list saved in `fields.ts`: the dropdown never waits on a hung request.
 */
export async function loadFields(
  fetchText: (url: string) => Promise<string> = fetchSiteText,
  budgetMs = LOAD_BUDGET_MS,
): Promise<{ fields: Field[]; fromSite: boolean }> {
  const fallback = { fields: FIELDS, fromSite: false };
  const timeout = new Promise<typeof fallback>((resolve) => setTimeout(resolve, budgetMs, fallback));
  return Promise.race([fromSite(fetchText), timeout]);
}

async function fromSite(
  fetchText: (url: string) => Promise<string>,
): Promise<{ fields: Field[]; fromSite: boolean }> {
  try {
    const page = await fetchText(`${SITE}/replay`);
    for (const [, path] of page.matchAll(CHUNK)) {
      const parsed = parseFieldsFromBundle(await fetchText(`${SITE}${path}`));
      if (parsed && Object.keys(parsed.labels).length > 0) {
        return { fields: buildFieldList(parsed.labels, parsed.inactive), fromSite: true };
      }
    }
  } catch {
    // Falls through to the saved list.
  }
  return { fields: FIELDS, fromSite: false };
}
