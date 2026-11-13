import { expect, test } from "bun:test";
import { filterOptions } from "./filter.ts";

const options = [
  { value: "arena-furacao-1", label: "Arena Furacão - Campo 1" },
  { value: "four-play-1", label: "Four Play - Quadra 1" },
  { value: "four-play-3", label: "Four Play - Quadra 3" },
  { value: "olaria", label: "Olaria" },
];

test("an empty query keeps every option", () => {
  expect(filterOptions(options, "  ")).toEqual(options);
});

test("matches any part of the label, ignoring case", () => {
  expect(filterOptions(options, "PLAY").map((o) => o.value)).toEqual(["four-play-1", "four-play-3"]);
});

test("ignores accents on either side", () => {
  expect(filterOptions(options, "furacao").map((o) => o.value)).toEqual(["arena-furacao-1"]);
  expect(filterOptions(options, "olária").map((o) => o.value)).toEqual(["olaria"]);
});

test("every word must match, in any order", () => {
  expect(filterOptions(options, "3 four").map((o) => o.value)).toEqual(["four-play-3"]);
});

test("no match gives an empty list", () => {
  expect(filterOptions(options, "zzz")).toEqual([]);
});
