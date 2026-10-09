import { matchMarker } from "@prelude/shared";
import type { ExtractedFactCandidate, FieldType } from "@prelude/shared";
import type { ExpectedFact } from "./types";

const LABELLED: readonly FieldType[] = ["marker_value", "reference_range"];

function labelKey(fieldType: FieldType, label: string | null | undefined): string {
  if (!LABELLED.includes(fieldType) || !label) return "";
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const compact = (s: string) => s.toLowerCase().replace(/\s+/g, "");
const collapse = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function valuesEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.trim() !== "" && b.trim() !== "") {
    const na = Number(a.replace(/,/g, ""));
    const nb = Number(b.replace(/,/g, ""));
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return collapse(a) === collapse(b);
}

export function unitsEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return compact(a) === compact(b);
}

export const rangesEqual = unitsEqual;

function dateOk(e: ExpectedFact, c: ExtractedFactCandidate): boolean {
  return c.asOfDate === e.asOfDate || (c.asOfDate !== null && (e.altDates ?? []).includes(c.asOfDate));
}

export interface MatchResult {
  pairs: { expected: ExpectedFact; extracted: ExtractedFactCandidate }[];
  missed: ExpectedFact[];
  spurious: ExtractedFactCandidate[];
}

// One-to-one: first pass requires label+fieldType+date, second pass label+fieldType only.
export function matchFacts(expected: ExpectedFact[], extracted: ExtractedFactCandidate[]): MatchResult {
  const usedExtracted = new Set<number>();
  const pairedExpected = new Map<number, number>();
  const sameKey = (e: ExpectedFact, c: ExtractedFactCandidate) =>
    e.fieldType === c.fieldType && labelKey(e.fieldType, e.markerLabel) === labelKey(c.fieldType, c.trackedMarkerLabel);

  for (const requireDate of [true, false]) {
    expected.forEach((e, ei) => {
      if (pairedExpected.has(ei)) return;
      const ci = extracted.findIndex((c, i) => !usedExtracted.has(i) && sameKey(e, c) && (!requireDate || dateOk(e, c)));
      if (ci >= 0) {
        usedExtracted.add(ci);
        pairedExpected.set(ei, ci);
      }
    });
  }

  return {
    pairs: [...pairedExpected].map(([ei, ci]) => ({ expected: expected[ei]!, extracted: extracted[ci]! })),
    missed: expected.filter((_, i) => !pairedExpected.has(i)),
    spurious: extracted.filter((_, i) => !usedExtracted.has(i)),
  };
}

export interface FactResult {
  expected: ExpectedFact;
  extracted: ExtractedFactCandidate;
  valueOk: boolean;
  unitOk: boolean;
  rangeOk: boolean;
  dateOk: boolean;
  correct: boolean;
}

export interface DocScore {
  name: string;
  expected: ExpectedFact[];
  extracted: ExtractedFactCandidate[];
  failedFieldTypes: FieldType[];
  results: FactResult[];
  missed: ExpectedFact[];
  spurious: ExtractedFactCandidate[];
}

export function scoreDoc(
  name: string,
  expected: ExpectedFact[],
  extracted: ExtractedFactCandidate[],
  failedFieldTypes: FieldType[],
): DocScore {
  const { pairs, missed, spurious } = matchFacts(expected, extracted);
  const results = pairs.map(({ expected: e, extracted: c }): FactResult => {
    const v = valuesEqual(e.value, c.value);
    const u = unitsEqual(e.unit, c.unit);
    const r = rangesEqual(e.referenceRange, c.referenceRange);
    const d = dateOk(e, c);
    return { expected: e, extracted: c, valueOk: v, unitOk: u, rangeOk: r, dateOk: d, correct: v && u && d };
  });
  return { name, expected, extracted, failedFieldTypes, results, missed, spurious };
}
