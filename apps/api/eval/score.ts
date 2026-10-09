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

// Containment is a last-resort fallback for printed-label suffixes ("CALCIUM" vs
// "CALCIUM , Serum"); the shorter key must be at least 4 chars to avoid "INR" in everything.
function labelsRelated(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}

// One-to-one passes: exact label+date, exact label, then containment label.
export function matchFacts(expected: ExpectedFact[], extracted: ExtractedFactCandidate[]): MatchResult {
  const usedExtracted = new Set<number>();
  const pairedExpected = new Map<number, number>();
  const sameField = (e: ExpectedFact, c: ExtractedFactCandidate) => e.fieldType === c.fieldType;
  const keys = (e: ExpectedFact, c: ExtractedFactCandidate) => [labelKey(e.fieldType, e.markerLabel), labelKey(c.fieldType, c.trackedMarkerLabel)] as const;
  const passes: ((e: ExpectedFact, c: ExtractedFactCandidate) => boolean)[] = [
    (e, c) => sameField(e, c) && keys(e, c)[0] === keys(e, c)[1] && dateOk(e, c),
    (e, c) => sameField(e, c) && keys(e, c)[0] === keys(e, c)[1],
    (e, c) => sameField(e, c) && labelsRelated(...keys(e, c)),
  ];

  for (const accepts of passes) {
    expected.forEach((e, ei) => {
      if (pairedExpected.has(ei)) return;
      const ci = extracted.findIndex((c, i) => !usedExtracted.has(i) && accepts(e, c));
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

export function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

export interface Summary {
  documents: number;
  expected: number;
  extracted: number;
  matched: number;
  recall: number | null;
  precision: number | null;
  valueAccuracy: number | null;
  unitAccuracy: number | null;
  rangeAccuracy: number | null;
  dateAccuracy: number | null;
  factAccuracy: number | null;
  byFieldType: Record<string, { expected: number; matched: number }>;
  markerMatch: { eligible: number; correct: number; falseCanonical: string[] };
  snippetRate: number | null;
  calibration: {
    buckets: { label: string; n: number; correct: number }[];
    meanConfidenceCorrect: number | null;
    meanConfidenceIncorrect: number | null;
  };
}

const BUCKETS = [
  { label: "0-0.5", lo: 0, hi: 0.5 },
  { label: "0.5-0.8", lo: 0.5, hi: 0.8 },
  { label: "0.8-1", lo: 0.8, hi: 1.0001 },
];

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarize(docs: DocScore[]): Summary {
  const results = docs.flatMap((d) => d.results);
  const extractedAll = docs.flatMap((d) => d.extracted);
  const expectedAll = docs.flatMap((d) => d.expected);
  const count = (f: (r: FactResult) => boolean) => results.filter(f).length;

  const byFieldType: Summary["byFieldType"] = {};
  for (const e of expectedAll) (byFieldType[e.fieldType] ??= { expected: 0, matched: 0 }).expected++;
  for (const r of results) byFieldType[r.expected.fieldType]!.matched++;

  const eligible = results.filter((r) => r.expected.canonicalMarker !== null);
  const falseCanonical = results
    .filter((r) => r.expected.canonicalMarker === null && matchMarker(r.extracted.trackedMarkerLabel ?? "") !== null)
    .map((r) => r.extracted.trackedMarkerLabel ?? "");

  const scored = [
    ...results.map((r) => ({ confidence: r.extracted.confidence, ok: r.correct })),
    ...docs.flatMap((d) => d.spurious).map((c) => ({ confidence: c.confidence, ok: false })),
  ];

  return {
    documents: docs.length,
    expected: expectedAll.length,
    extracted: extractedAll.length,
    matched: results.length,
    recall: ratio(results.length, expectedAll.length),
    precision: ratio(results.length, extractedAll.length),
    valueAccuracy: ratio(count((r) => r.valueOk), results.length),
    unitAccuracy: ratio(count((r) => r.unitOk), results.length),
    rangeAccuracy: ratio(count((r) => r.rangeOk), results.length),
    dateAccuracy: ratio(count((r) => r.dateOk), results.length),
    factAccuracy: ratio(count((r) => r.correct), results.length),
    byFieldType,
    markerMatch: {
      eligible: eligible.length,
      correct: eligible.filter((r) => matchMarker(r.extracted.trackedMarkerLabel ?? "") === r.expected.canonicalMarker).length,
      falseCanonical,
    },
    snippetRate: ratio(extractedAll.filter((c) => c.sourceSnippet !== null).length, extractedAll.length),
    calibration: {
      buckets: BUCKETS.map((b) => {
        const inB = scored.filter((s) => s.confidence >= b.lo && s.confidence < b.hi);
        return { label: b.label, n: inB.length, correct: inB.filter((s) => s.ok).length };
      }),
      meanConfidenceCorrect: mean(scored.filter((s) => s.ok).map((s) => s.confidence)),
      meanConfidenceIncorrect: mean(scored.filter((s) => !s.ok).map((s) => s.confidence)),
    },
  };
}

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);

export function formatSummary(s: Summary): string {
  const lines = [
    `documents ${s.documents} | expected ${s.expected} | extracted ${s.extracted} | matched ${s.matched}`,
    `recall ${pct(s.recall)} | precision ${pct(s.precision)}`,
    `of matched: value ${pct(s.valueAccuracy)} | unit ${pct(s.unitAccuracy)} | range ${pct(s.rangeAccuracy)} | date ${pct(s.dateAccuracy)} | all-correct ${pct(s.factAccuracy)}`,
    `snippet verified ${pct(s.snippetRate)}`,
    `marker match ${s.markerMatch.correct}/${s.markerMatch.eligible} eligible | false canonical matches ${s.markerMatch.falseCanonical.length}`,
    "recall by field type: " + Object.entries(s.byFieldType).map(([k, v]) => `${k} ${v.matched}/${v.expected}`).join(", "),
    "confidence (n, correct): " + s.calibration.buckets.map((b) => `${b.label} ${b.n},${b.correct}`).join(" | ") +
      ` | mean correct ${s.calibration.meanConfidenceCorrect?.toFixed(2) ?? "n/a"}, incorrect ${s.calibration.meanConfidenceIncorrect?.toFixed(2) ?? "n/a"}`,
  ];
  return lines.join("\n");
}
