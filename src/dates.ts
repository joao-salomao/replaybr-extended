/**
 * Today as YYYY-MM-DD in the browser's own time zone. `toISOString()` would
 * give the UTC day, which in Brazil turns into tomorrow after 21:00, right
 * when evening games end.
 */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
