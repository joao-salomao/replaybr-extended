const API_BASE = "https://replays.replaybr.com.br";

/** Ceiling for the replay listing request — small response, no reason to be slow. */
const API_TIMEOUT_MS = 15 * 1000;

/** A recorded play. Not every field (nor every play) has a second camera. */
export interface Replay {
  /** Local ISO without timezone, e.g. "2026-07-29T20:02:49" */
  timestamp: string;
  camera1_url: string;
  /** Absent when the play was recorded by a single camera. */
  camera2_url?: string;
}

export interface HourGroup {
  /** Two-digit hour, e.g. "20". */
  hour: string;
  /** Displayed label, e.g. "20:00". */
  label: string;
  replays: Replay[];
}

/**
 * The ReplayBR API didn't respond: down, DNS failed, timeout, or it
 * responded with an error status. A dedicated class lets whoever handles the
 * error (the HTTP route) tell this cause — by far the most likely one —
 * apart from an arbitrary bug, without having to guess from the message.
 */
export class ReplayBrUnavailableError extends Error {}

/** Fetches every replay for a field on a given date (YYYY-MM-DD). */
export async function fetchReplaysForDate(
  fieldName: string,
  date: string,
): Promise<Replay[]> {
  const url = `${API_BASE}/available-hours?fieldName=${encodeURIComponent(
    fieldName,
  )}&date=${encodeURIComponent(date)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (error) {
    throw new ReplayBrUnavailableError(
      `Falha ao falar com a API do ReplayBR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!res.ok) {
    throw new ReplayBrUnavailableError(
      `API respondeu ${res.status} ${res.statusText} para ${url}`,
    );
  }

  const body = (await res.json()) as { replays?: Replay[] };
  return Array.isArray(body?.replays) ? body.replays : [];
}

/**
 * Groups replays by the hour of their timestamp, exactly like the official
 * site does — it's the same segment that shows up in the video URL
 * (`.../2026-08-13/21/...`).
 */
export function groupReplaysByHour(replays: Replay[]): HourGroup[] {
  const sorted = [...replays].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  const byHour = new Map<string, Replay[]>();
  for (const replay of sorted) {
    // Timestamps come as local ISO, without timezone. Slicing the string
    // avoids any timezone conversion.
    const hour = replay.timestamp.slice(11, 13);
    const list = byHour.get(hour);
    if (list) list.push(replay);
    else byHour.set(hour, [replay]);
  }

  return [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, list]) => ({ hour, label: `${hour}:00`, replays: list }));
}

/** Accepts "20", "20:30", "2030", or "20h30" and returns the hour ("20"). */
export function normalizeHour(input: string): string | null {
  const match = input.trim().match(/^(\d{1,2})(?:[:h.]?(\d{2}))?$/);
  if (!match?.[1]) return null;

  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return String(hour).padStart(2, "0");
}
