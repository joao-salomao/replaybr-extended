import { describe, expect, test } from "bun:test";
import { groupReplaysByHour, normalizeHour, type Replay } from "./api.ts";

/**
 * Lances reais de `four-play-3` em 2026-08-13, conferidos no site oficial em
 * 2026-08-14: a hora 20 mostra 6 lances e a hora 21 mostra 2.
 */
const TIMESTAMPS = [
  "2026-08-13T20:34:25",
  "2026-08-13T20:35:39",
  "2026-08-13T20:36:55",
  "2026-08-13T20:48:28",
  "2026-08-13T20:49:47",
  "2026-08-13T20:54:02",
  "2026-08-13T21:11:56",
  "2026-08-13T21:32:51",
];

const replay = (timestamp: string): Replay => ({
  timestamp,
  camera1_url: `https://exemplo/${timestamp}/camera1.mp4`,
  camera2_url: `https://exemplo/${timestamp}/camera2.mp4`,
});

const FIXTURE = TIMESTAMPS.map(replay);

describe("groupReplaysByHour", () => {
  test("agrupa pela hora do timestamp, como o site oficial", () => {
    const groups = groupReplaysByHour(FIXTURE);

    expect(groups.map((g) => g.hour)).toEqual(["20", "21"]);
    expect(groups[0]?.replays).toHaveLength(6);
    expect(groups[1]?.replays).toHaveLength(2);
  });

  test("21:11:56 fica na hora 21, não na anterior", () => {
    // Regressão: a lógica antiga de slots de 30min colocava esse lance no
    // balde "20:30", divergindo do site.
    const groups = groupReplaysByHour(FIXTURE);
    const hour21 = groups.find((g) => g.hour === "21");

    expect(hour21?.replays.map((r) => r.timestamp)).toEqual([
      "2026-08-13T21:11:56",
      "2026-08-13T21:32:51",
    ]);
  });

  test("rotula a hora no formato exibido", () => {
    expect(groupReplaysByHour(FIXTURE)[0]?.label).toBe("20:00");
  });

  test("ordena por timestamp mesmo com entrada fora de ordem", () => {
    const groups = groupReplaysByHour([...FIXTURE].reverse());

    expect(groups.map((g) => g.hour)).toEqual(["20", "21"]);
    expect(groups[0]?.replays[0]?.timestamp).toBe("2026-08-13T20:34:25");
  });

  test("lista vazia devolve nenhum grupo", () => {
    expect(groupReplaysByHour([])).toEqual([]);
  });
});

describe("normalizeHour", () => {
  test.each([
    ["20", "20"],
    ["20:00", "20"],
    ["20:30", "20"],
    ["2030", "20"],
    ["20h30", "20"],
    ["20.30", "20"],
    ["9", "09"],
    ["00:15", "00"],
    // Três dígitos são lidos como H + MM: "203" é 2:03.
    ["203", "02"],
    [" 20 ", "20"],
  ])("normaliza %p para %p", (input, expected) => {
    expect(normalizeHour(input)).toBe(expected);
  });

  test.each([["24"], ["20:60"], ["abc"], [""], ["-1"], ["20:1"]])(
    "rejeita %p",
    (input) => {
      expect(normalizeHour(input)).toBeNull();
    },
  );
});
