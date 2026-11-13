import { expect, test } from "bun:test";
import { localDate } from "./dates.ts";

test("uses the local calendar day, not UTC", () => {
  process.env.TZ = "America/Sao_Paulo";
  // 22:30 on the 13th in São Paulo is already the 14th in UTC.
  const evening = new Date("2026-11-14T01:30:00Z");

  expect(localDate(evening)).toBe("2026-11-13");
});
