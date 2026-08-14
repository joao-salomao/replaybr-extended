const API_BASE = "https://replays.replaybr.com.br";

/** Teto de espera pela listagem de replays — resposta pequena, sem motivo para demorar. */
const API_TIMEOUT_MS = 15 * 1000;

/** Um lance gravado. Nem todo campo (nem todo lance) tem a segunda câmera. */
export interface Replay {
  /** ISO local sem timezone, ex: "2026-07-29T20:02:49" */
  timestamp: string;
  camera1_url: string;
  /** Ausente quando o lance foi gravado por uma câmera só. */
  camera2_url?: string;
}

export interface HourGroup {
  /** Hora com dois dígitos, ex: "20". */
  hour: string;
  /** Rótulo exibido, ex: "20:00". */
  label: string;
  replays: Replay[];
}

/** Busca todos os replays de um campo em uma data (YYYY-MM-DD). */
export async function fetchReplaysForDate(
  fieldName: string,
  date: string,
): Promise<Replay[]> {
  const url = `${API_BASE}/available-hours?fieldName=${encodeURIComponent(
    fieldName,
  )}&date=${encodeURIComponent(date)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`API respondeu ${res.status} ${res.statusText} para ${url}`);
  }

  const body = (await res.json()) as { replays?: Replay[] };
  return Array.isArray(body?.replays) ? body.replays : [];
}

/**
 * Agrupa replays pela hora do timestamp, exatamente como o site oficial faz —
 * é o mesmo segmento que aparece na URL do vídeo (`.../2026-08-13/21/...`).
 */
export function groupReplaysByHour(replays: Replay[]): HourGroup[] {
  const sorted = [...replays].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  const byHour = new Map<string, Replay[]>();
  for (const replay of sorted) {
    // Timestamps vêm como ISO local, sem timezone. Fatiar a string evita
    // qualquer conversão de fuso.
    const hour = replay.timestamp.slice(11, 13);
    const list = byHour.get(hour);
    if (list) list.push(replay);
    else byHour.set(hour, [replay]);
  }

  return [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, list]) => ({ hour, label: `${hour}:00`, replays: list }));
}

/** Aceita "20", "20:30", "2030" ou "20h30" e devolve a hora ("20"). */
export function normalizeHour(input: string): string | null {
  const match = input.trim().match(/^(\d{1,2})(?:[:h.]?(\d{2}))?$/);
  if (!match?.[1]) return null;

  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return String(hour).padStart(2, "0");
}
