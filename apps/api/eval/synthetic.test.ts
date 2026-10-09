import { test, expect } from "bun:test";
import type { ExtractedFactCandidate } from "@prelude/shared";
import { ExpectedDocSchema } from "./types";
import { scoreDoc } from "./score";
import { buildSyntheticLab, buildSyntheticRadiology, buildSyntheticPrescription, SYN_TESTS } from "./synthetic";

const asCandidate = (label: string, f: { value: string | null; unit: string | null; referenceRange: string | null; asOfDate: string | null }): ExtractedFactCandidate => ({
  fieldType: "marker_value", trackedMarkerLabel: label, value: f.value, unit: f.unit, referenceRange: f.referenceRange,
  asOfDate: f.asOfDate, coverageStatus: "value_found", sourcePage: 1, sourceLocation: null, sourceSnippet: "s", confidence: 0.9,
});

for (const style of [0, 1, 2] as const) {
  test(`synthetic lab style ${style}: key validates and every key row is printed on its cited page`, () => {
    const { ocr, expected } = buildSyntheticLab(style, 4);
    expect(ExpectedDocSchema.parse(expected).source).toBe("synthetic");
    expect(ocr.pages.length).toBeGreaterThan(1);
    for (const f of expected.facts) {
      const page = ocr.pages[f.sourcePage! - 1]!.text;
      expect(page).toContain(f.markerLabel!);
      expect(page).toContain(f.value!);
    }
  });

  test(`synthetic lab style ${style}: a perfect extractor using another lab's labels still scores 100% via aliases`, () => {
    const { expected } = buildSyntheticLab(style, 4);
    const other = buildSyntheticLab(((style + 1) % 3) as 0 | 1 | 2, 4).expected;
    const candidates = expected.facts.map((f, i) => asCandidate(other.facts[i]!.markerLabel!, f));
    const s = scoreDoc("syn", expected.facts, candidates, [], "synthetic");
    expect(s.missed).toHaveLength(0);
    expect(s.spurious).toHaveLength(0);
    expect(s.results.every((r) => r.correct)).toBe(true);
  });
}

test("synthetic catalog keeps free and total thyroid tests as separate rows", () => {
  const ids = SYN_TESTS.map((t) => t.id);
  expect(ids).toContain("t3_total");
  expect(ids).toContain("ft4");
});

test("synthetic radiology and prescription docs produce one valid fact each", () => {
  const r = buildSyntheticRadiology();
  const p = buildSyntheticPrescription();
  expect(r.expected.documentType).toBe("radiology");
  expect(r.expected.facts[0]!.fieldType).toBe("radiology_impression");
  expect(r.ocr.fullText).toContain(r.expected.facts[0]!.value!);
  expect(p.expected.documentType).toBe("prescription");
  expect(p.expected.facts[0]!.fieldType).toBe("treatment_regimen");
  expect(p.ocr.fullText).toContain(p.expected.facts[0]!.value!);
});
