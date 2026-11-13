export interface SelectOption {
  value: string;
  label: string;
}

/** Lowercase, without accents: "Furacão" and "furacao" compare equal. */
const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Keeps the options whose label contains every word of the query. */
export function filterOptions<T extends SelectOption>(options: T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return options.filter((option) => {
    const label = fold(option.label);
    return words.every((word) => label.includes(word));
  });
}
