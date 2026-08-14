export interface Field {
  slug: string;
  label: string;
  /** Inverte os lados das câmeras por padrão nessa quadra. */
  defaultSwap: boolean;
}

/**
 * Rótulos copiados do site oficial (`humanReadableFieldNameMapping`, no bundle
 * de `www.replaybr.com.br`). O mapa completo, com as 67 quadras, está no
 * apêndice da spec — acrescentar uma aqui é só adicionar a linha.
 */
export const FIELDS: Field[] = [
  { slug: "placar-society", label: "Placar Society", defaultSwap: false },
  // Nas quadras Four Play a numeração da API não corresponde à posição física
  // das câmeras em campo, então elas saem trocadas se não invertermos.
  { slug: "four-play-3", label: "Four Play - Quadra 3", defaultSwap: true },
];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Resolve o slug informado pelo usuário. Quadras fora da lista continuam
 * acessíveis, desde que o slug tenha formato válido — o que também impede que
 * um caminho arbitrário chegue ao disco.
 */
export function resolveField(slug: string): Field | null {
  const known = FIELDS.find((field) => field.slug === slug);
  if (known) return known;
  if (!SLUG.test(slug)) return null;

  return { slug, label: slug, defaultSwap: false };
}
