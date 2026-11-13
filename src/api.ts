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
 * responded with an error status. Its message is written for the user: the
 * app shows it as is.
 */
export class ReplayBrUnavailableError extends Error {}

/**
 * Cloudflare answered with its bot check ("Just a moment...") instead of the
 * API. Retrying does not help: the user has to pass the check on the site.
 */
export class CloudflareBlockedError extends ReplayBrUnavailableError {}

/** Cloudflare answered with its "Just a moment..." check instead of the content. */
export function isCloudflareChallenge(res: Response): boolean {
  return res.status === 403 && res.headers.get("cf-mitigated") === "challenge";
}

export const CLOUDFLARE_MESSAGE =
  "O Cloudflare bloqueou o acesso. Abra www.replaybr.com.br nesta janela para liberar e tente de novo.";

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
    res = await fetch(url, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      // The browser's ReplayBR session, Cloudflare clearance included.
      credentials: "include",
    });
  } catch (error) {
    throw new ReplayBrUnavailableError(
      `Falha ao falar com a API do ReplayBR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isCloudflareChallenge(res)) throw new CloudflareBlockedError(CLOUDFLARE_MESSAGE);
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
