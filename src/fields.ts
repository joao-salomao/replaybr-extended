export interface Field {
  slug: string;
  label: string;
  /** Flips the camera sides by default for this field. */
  defaultSwap: boolean;
}

/**
 * Labels copied from the official site (`humanReadableFieldNameMapping`, in
 * the `www.replaybr.com.br` bundle). The full map, with all 67 fields, is in
 * the spec's appendix — adding one here is just adding the line.
 */
export const FIELDS: Field[] = [
  { slug: "placar-society", label: "Placar Society", defaultSwap: false },
  // On the Four Play fields, the API's numbering doesn't match the cameras'
  // physical position on site, so they come out swapped unless we flip them.
  { slug: "four-play-3", label: "Four Play - Quadra 3", defaultSwap: true },
];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Resolves the slug given by the user. Fields outside the list stay
 * reachable as long as the slug has a valid format — which also keeps an
 * arbitrary path from reaching disk.
 */
export function resolveField(slug: string): Field | null {
  const known = FIELDS.find((field) => field.slug === slug);
  if (known) return known;
  if (!SLUG.test(slug)) return null;

  return { slug, label: slug, defaultSwap: false };
}
