import { test, expect } from "bun:test";
import { linesFromText, renderLines, splitCells } from "./lines";

test("splitCells splits on 2+ spaces and keeps single-space words together", () => {
  expect(splitCells("  HAEMOGLOBIN (Hb)     10.1   g/dL  ").map((c) => c.text)).toEqual(["HAEMOGLOBIN (Hb)", "10.1", "g/dL"]);
});

test("linesFromText skips blank lines and numbers pages", () => {
  const lines = linesFromText("A   1\n\n   \nB   2", 3);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ page: 3, raw: "A   1" });
});

test("renderLines then linesFromText round-trips cells, and raw is a substring of the page text", () => {
  const lines = linesFromText("Test Name   Result\nHb   10.1   g/dL", 1);
  const text = renderLines(lines);
  const again = linesFromText(text, 1);
  expect(again.map((l) => l.cells.map((c) => c.text))).toEqual(lines.map((l) => l.cells.map((c) => c.text)));
  for (const l of again) expect(text).toContain(l.raw);
});
