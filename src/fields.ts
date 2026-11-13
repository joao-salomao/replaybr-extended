export interface Field {
  slug: string;
  label: string;
  /** Flips the camera sides by default for this field. */
  defaultSwap: boolean;
}

/**
 * Fields whose API camera numbering doesn't match the physical position on
 * site, so they come out swapped unless flipped.
 */
export const SWAP_BY_DEFAULT: ReadonlySet<string> = new Set(["four-play-3"]);

/**
 * Active fields from the official site: `humanReadableFieldNameMapping` in
 * the `www.replaybr.com.br` bundle, minus the slugs its `isFieldInactive`
 * lists. Extracted on 2026-11-13. Sorted by label for the dropdown.
 */
export const FIELDS: Field[] = [
  { slug: "7carijos", label: "7 Carijós", defaultSwap: false },
  { slug: "arena-beach-1", label: "Arena Beach - Quadra 1", defaultSwap: false },
  { slug: "arena-beach-2", label: "Arena Beach - Quadra 2", defaultSwap: false },
  { slug: "arena-beach-3", label: "Arena Beach - Quadra 3", defaultSwap: false },
  { slug: "arena-caboja", label: "Arena Caboja", defaultSwap: false },
  { slug: "arena-fagundes", label: "Arena Fagundes", defaultSwap: false },
  { slug: "arena-furacao-1", label: "Arena Furacão - Campo 1", defaultSwap: false },
  { slug: "arena-furacao-2", label: "Arena Furacão - Campo 2", defaultSwap: false },
  { slug: "arena-fut-sete", label: "Arena Fut 7", defaultSwap: false },
  { slug: "arena-givas", label: "Arena Givas", defaultSwap: false },
  { slug: "arena-gruta", label: "Arena Gruta", defaultSwap: false },
  { slug: "arena-itajai", label: "Arena Itajaí", defaultSwap: false },
  { slug: "arena-ojplay", label: "Arena OJPlay", defaultSwap: false },
  { slug: "arena-r1-1", label: "Arena R1 - Quadra 1", defaultSwap: false },
  { slug: "arena-r1-2", label: "Arena R1 - Quadra 2", defaultSwap: false },
  { slug: "arena-r1-3", label: "Arena R1 - Quadra 3", defaultSwap: false },
  { slug: "arena-rius", label: "Arena Rius", defaultSwap: false },
  { slug: "arena-sportplay-1", label: "Arena Sport Play - Quadra 1", defaultSwap: false },
  { slug: "arena-sportplay-2", label: "Arena Sport Play - Quadra 2", defaultSwap: false },
  { slug: "arena-sportplay-3", label: "Arena Sport Play - Quadra 3", defaultSwap: false },
  { slug: "arena-sportplaygo-1", label: "Arena Sport Play GO - Quadra 1", defaultSwap: false },
  { slug: "arena-sportplaygo-2", label: "Arena Sport Play GO - Quadra 2", defaultSwap: false },
  { slug: "arena-sportplaygo-3", label: "Arena Sport Play GO - Quadra 3", defaultSwap: false },
  { slug: "a-sao-leopoldo", label: "Associação São Leopoldo", defaultSwap: false },
  { slug: "baiao-society", label: "Baiao Society", defaultSwap: false },
  { slug: "bate-bola", label: "Bate Bola", defaultSwap: false },
  { slug: "bc-society", label: "BC Society", defaultSwap: false },
  { slug: "belli-society", label: "Belli Society", defaultSwap: false },
  { slug: "ipiranga-4", label: "Bocha", defaultSwap: false },
  { slug: "camisa10", label: "Camisa 10", defaultSwap: false },
  { slug: "cancha-do-calo", label: "Cancha do Calo", defaultSwap: false },
  { slug: "cancha-do-venzon-1", label: "Cancha do Venzon - Cancha 1", defaultSwap: false },
  { slug: "cancha-do-venzon-2", label: "Cancha do Venzon - Cancha 2", defaultSwap: false },
  { slug: "ct-hegon-1", label: "CT Hegon - Quadra 1", defaultSwap: false },
  { slug: "ct-hegon-2", label: "CT Hegon - Quadra 2", defaultSwap: false },
  { slug: "ct-hegon-3", label: "CT Hegon - Quadra 3", defaultSwap: false },
  { slug: "ct-hegon-4", label: "CT Hegon - Quadra 4", defaultSwap: false },
  { slug: "ct-hegon-5", label: "CT Hegon - Quadra 5", defaultSwap: false },
  { slug: "elite-society", label: "Elite Society", defaultSwap: false },
  { slug: "four-play-1", label: "Four Play - Quadra 1", defaultSwap: false },
  { slug: "four-play-2", label: "Four Play - Quadra 2", defaultSwap: false },
  // On the Four Play fields, the API's numbering doesn't match the cameras'
  // physical position on site, so they come out swapped unless we flip them.
  { slug: "four-play-3", label: "Four Play - Quadra 3", defaultSwap: true },
  { slug: "global-society", label: "Global Society", defaultSwap: false },
  { slug: "golaco-society", label: "Golaço Society", defaultSwap: false },
  { slug: "luiza-futsal", label: "Guabisoccer Futsal", defaultSwap: false },
  { slug: "guabi-soccer-society", label: "Guabisoccer Society", defaultSwap: false },
  { slug: "quadra-tenis", label: "Guarani - Quadra Tênis", defaultSwap: false },
  { slug: "hexa-society-1", label: "Hexa Society - Quadra 1", defaultSwap: false },
  { slug: "hexa-society-2", label: "Hexa Society - Quadra 2", defaultSwap: false },
  { slug: "mga-society", label: "MGA Society", defaultSwap: false },
  { slug: "mineral-society", label: "Mineral Society", defaultSwap: false },
  { slug: "new-soccer", label: "New Soccer", defaultSwap: false },
  { slug: "new-soccer-society", label: "New Soccer Society", defaultSwap: false },
  { slug: "nj-ferinos", label: "NJ Ferinos", defaultSwap: false },
  { slug: "olaria", label: "Olaria", defaultSwap: false },
  { slug: "parceria-society-2", label: "Parceria Society - Campo 1", defaultSwap: false },
  { slug: "parceria-society-1", label: "Parceria Society - Campo 2", defaultSwap: false },
  { slug: "placar-society", label: "Placar Society", defaultSwap: false },
  { slug: "ipiranga-1", label: "Quadra A", defaultSwap: false },
  { slug: "ipiranga-2", label: "Quadra B", defaultSwap: false },
  { slug: "recanto-do-guerreiro-1", label: "Recanto do Guerreiro - Quadra 1", defaultSwap: false },
  { slug: "recanto-do-guerreiro-2", label: "Recanto do Guerreiro - Quadra 2", defaultSwap: false },
  { slug: "resenha-society", label: "Resenha Society", defaultSwap: false },
  { slug: "ropek-1", label: "Ropek - Areia 1", defaultSwap: false },
  { slug: "ropek-2", label: "Ropek - Areia 2", defaultSwap: false },
  { slug: "ropek-3", label: "Ropek - Society", defaultSwap: false },
  { slug: "roque-e-adriano-1", label: "Roque e Adriano - Quadra 1 society (de cima)", defaultSwap: false },
  { slug: "roque-e-adriano-2", label: "Roque e Adriano - Quadra 2 society (de baixo)", defaultSwap: false },
  { slug: "roque-e-adriano-3", label: "Roque e Adriano - Quadra 3 areia", defaultSwap: false },
  { slug: "show-de-bola", label: "Show de Bola", defaultSwap: false },
  { slug: "simeoni-futebol-clube", label: "Simeoni Futebol Clube", defaultSwap: false },
  { slug: "ipiranga-3", label: "Sinuca", defaultSwap: false },
  { slug: "sitrampa", label: "Sitrampa", defaultSwap: false },
  { slug: "society-ze-ruela", label: "Society Zé Ruela", defaultSwap: false },
  { slug: "taurus-society", label: "Taurus Society", defaultSwap: false },
  { slug: "villa-society-1", label: "Vila Society - Quadra 1 (Descoberta)", defaultSwap: false },
  { slug: "villa-society-2", label: "Vila Society - Quadra 2 (Coberta)", defaultSwap: false },
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

/**
 * Turns the text of the court search box into a field: a label picked from
 * the list (case and spaces aside) or, for courts the list doesn't know, a
 * slug typed as is. Anything else is no field yet.
 */
export function fieldFromInput(text: string, fields: Field[]): Field | null {
  const typed = text.trim();
  if (!typed) return null;
  const label = typed.toLowerCase();
  return fields.find((field) => field.label.toLowerCase() === label) ?? resolveField(typed);
}
