# Extraction Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repeatable `bun` script that scores the extraction provider against hand-reviewed answer keys built from the real reports in `docs/reports/`.

**Architecture:** Pure scoring logic (`score.ts`, unit-tested on synthetic data) separated from I/O. `buildFixtures.ts` turns PDFs into `OcrResult` JSON via `pdftotext`; `run.ts` loads fixtures + answer keys, calls the configured `ExtractionProvider`, scores, prints a table and saves JSON. No DB, no server.

**Tech Stack:** Bun, TypeScript, zod (already a dependency), `pdftotext` (poppler), `@prelude/shared` (`matchMarker`, types).

**Spec:** `docs/superpowers/specs/2026-10-10-extraction-eval-harness-design.md`

## Global Constraints

- Measure only: do not change extraction prompts, schema, or `matchMarker`.
- Real reports contain PHI: `docs/reports/`, `apps/api/eval/fixtures/` and `apps/api/eval/results/` are gitignored (already done). Never `git add` them; never put real values in committed tests (tests use synthetic data).
- Use Bun (`bun test`, `bun run`, `bunx`), no Node/jest/dotenv. Bun loads `.env` automatically.
- Fixtures use `providerName: "pdftotext"`; OCR garbling is not measured (known gap).
- Run commands from the repo root `/home/dev-var/Documents/Projects/OPD`.
- Deviation from spec, deliberate: `run.ts` uses `getExtractionProvider()` (honours `EXTRACTION_PROVIDER`) instead of hard-wiring Anthropic; `--repeat N` pools all runs into one summary rather than averaging separately.
- Spec addition: `ExpectedFact.altDates` (accepted alternative dates), because the prompt allows "report date, collection date, etc." for `asOfDate`.

## Review Focus

- Duplicate labels in one document (e.g. "Neutrophils" % and absolute) must pair one-to-one, never double-count. (Task 1 test)
- Value formatting differences (`10.0` vs `10`, `1,200`, `<0.5`) must not cause false "wrong value". (Task 1 test)
- Labelless fact types (radiology impression): a stray extracted label must not prevent a match. (Task 1 test)
- A provider failure (`failedFieldTypes`) must yield misses, not a crash. (Task 1 test)
- Zero expected or zero extracted facts must give `null` ratios, never `NaN`. (Task 2 test)

---

### Task 1: Types and fact matching/scoring

**Files:**
- Create: `apps/api/eval/types.ts`
- Create: `apps/api/eval/score.ts`
- Test: `apps/api/eval/score.test.ts`

**Interfaces:**
- Produces (`types.ts`): `ExpectedFact`, `ExpectedDoc`, `ExpectedDocSchema` (zod).
- Produces (`score.ts`): `valuesEqual(a,b)`, `unitsEqual(a,b)`, `rangesEqual(a,b)`, `matchFacts(expected, extracted): MatchResult`, `scoreDoc(name, expected, extracted, failedFieldTypes): DocScore`, types `FactResult`, `DocScore`, `MatchResult`.

- [ ] **Step 1: Write `types.ts`**

```ts
import { z } from "zod";

export const ExpectedFactSchema = z.object({
  fieldType: z.enum(["marker_value", "reference_range", "treatment_regimen", "radiology_impression", "disease_status_trend"]),
  // Label as printed in the document; null for fact types without a label.
  markerLabel: z.string().nullable(),
  // Expected matchMarker(markerLabel) result; null when the label is not in the controlled list.
  canonicalMarker: z.string().nullable(),
  value: z.string().nullable(),
  unit: z.string().nullable(),
  referenceRange: z.string().nullable(),
  asOfDate: z.string().nullable(),
  // Other dates also accepted as correct (e.g. report date when asOfDate is the collection date).
  altDates: z.array(z.string()).optional(),
  sourcePage: z.number().int().nullable(),
});

export const ExpectedDocSchema = z.object({
  documentType: z.enum(["prescription", "blood", "radiology"]),
  facts: z.array(ExpectedFactSchema),
});

export type ExpectedFact = z.infer<typeof ExpectedFactSchema>;
export type ExpectedDoc = z.infer<typeof ExpectedDocSchema>;
```

- [ ] **Step 2: Write the failing tests** (`score.test.ts`, synthetic data only)

```ts
import { test, expect } from "bun:test";
import type { ExtractedFactCandidate } from "@prelude/shared";
import type { ExpectedFact } from "./types";
import { matchFacts, scoreDoc, valuesEqual, unitsEqual, rangesEqual } from "./score";

export const cand = (o: Partial<ExtractedFactCandidate> = {}): ExtractedFactCandidate => ({
  fieldType: "marker_value", trackedMarkerLabel: "Haemoglobin", value: "10.1", unit: "g/dL",
  referenceRange: "13.0-17.0", asOfDate: "2026-04-29", coverageStatus: "value_found",
  sourcePage: 1, sourceLocation: null, sourceSnippet: "snip", confidence: 0.9, ...o,
});
export const exp = (o: Partial<ExpectedFact> = {}): ExpectedFact => ({
  fieldType: "marker_value", markerLabel: "Haemoglobin", canonicalMarker: null, value: "10.1",
  unit: "g/dL", referenceRange: "13.0-17.0", asOfDate: "2026-04-29", sourcePage: 1, ...o,
});

test("valuesEqual tolerates numeric formatting but not different numbers", () => {
  expect(valuesEqual("10.0", "10")).toBe(true);
  expect(valuesEqual("1,200", "1200")).toBe(true);
  expect(valuesEqual("<0.5", "<0.5")).toBe(true);
  expect(valuesEqual("<0.5", "0.5")).toBe(false);
  expect(valuesEqual("10.1", "10.2")).toBe(false);
  expect(valuesEqual(null, null)).toBe(true);
  expect(valuesEqual(null, "1")).toBe(false);
  expect(valuesEqual("", "0")).toBe(false);
});

test("unitsEqual and rangesEqual ignore whitespace and case", () => {
  expect(unitsEqual("g/dL", "G/DL")).toBe(true);
  expect(rangesEqual("13.0 - 17.0", "13.0-17.0")).toBe(true);
  expect(rangesEqual(null, "13-17")).toBe(false);
});

test("matchFacts pairs by label+date, ignoring label punctuation/case", () => {
  const r = matchFacts([exp({ markerLabel: "HAEMOGLOBIN (Hb)" })], [cand({ trackedMarkerLabel: "Haemoglobin (Hb)" })]);
  expect(r.pairs).toHaveLength(1);
  expect(r.missed).toHaveLength(0);
  expect(r.spurious).toHaveLength(0);
});

test("matchFacts falls back to label-only when dates differ", () => {
  const r = matchFacts([exp()], [cand({ asOfDate: "2026-04-30" })]);
  expect(r.pairs).toHaveLength(1);
});

test("altDates counts as a date match", () => {
  const s = scoreDoc("d", [exp({ altDates: ["2026-04-30"] })], [cand({ asOfDate: "2026-04-30" })], []);
  expect(s.results[0]!.dateOk).toBe(true);
});

test("duplicate labels pair one-to-one and never double count", () => {
  const e = [exp({ value: "74" }), exp({ value: "4.2" })];
  const c = [cand({ value: "4.2" }), cand({ value: "74" })];
  const r = matchFacts(e, c);
  expect(r.pairs).toHaveLength(2);
  expect(new Set(r.pairs.map((p) => p.extracted)).size).toBe(2);
});

test("extra extracted facts are spurious; absent ones are missed", () => {
  const r = matchFacts([exp({ markerLabel: "RBC" })], [cand({ trackedMarkerLabel: "WBC" })]);
  expect(r.missed).toHaveLength(1);
  expect(r.spurious).toHaveLength(1);
});

test("labelless fact types match even when the extractor adds a label", () => {
  const e = exp({ fieldType: "radiology_impression", markerLabel: null, value: "Normal" });
  const c = cand({ fieldType: "radiology_impression", trackedMarkerLabel: "Chest", value: "Normal" });
  expect(matchFacts([e], [c]).pairs).toHaveLength(1);
});

test("scoreDoc marks a fact correct only when value, unit and date are right", () => {
  const s = scoreDoc("d", [exp(), exp({ markerLabel: "RBC", value: "3.6" })], [cand(), cand({ trackedMarkerLabel: "RBC", value: "3.7" })], []);
  expect(s.results.filter((r) => r.correct)).toHaveLength(1);
  expect(s.results.find((r) => r.expected.markerLabel === "RBC")!.valueOk).toBe(false);
});

test("provider failure yields misses, not a crash", () => {
  const s = scoreDoc("d", [exp(), exp({ markerLabel: "RBC" })], [], ["marker_value"]);
  expect(s.missed).toHaveLength(2);
  expect(s.failedFieldTypes).toEqual(["marker_value"]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test apps/api/eval/score.test.ts`
Expected: FAIL, cannot find module `./score`.

- [ ] **Step 4: Write `score.ts`**

```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test apps/api/eval/score.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/eval/types.ts apps/api/eval/score.ts apps/api/eval/score.test.ts
git commit -m "eval: fact matching and per-fact scoring"
```

---

### Task 2: Aggregate metrics and summary formatting

**Files:**
- Modify: `apps/api/eval/score.ts` (append)
- Modify: `apps/api/eval/score.test.ts` (append)

**Interfaces:**
- Consumes: `DocScore`, `FactResult` from Task 1.
- Produces: `ratio(n, d): number | null`, `summarize(docs: DocScore[]): Summary`, `formatSummary(s: Summary): string`, type `Summary`.

- [ ] **Step 1: Append failing tests**

```ts
import { summarize, formatSummary, ratio } from "./score";

test("ratio returns null for zero denominator", () => {
  expect(ratio(0, 0)).toBeNull();
  expect(ratio(1, 2)).toBe(0.5);
});

test("summarize with nothing expected or extracted gives null ratios, not NaN", () => {
  const s = summarize([scoreDoc("d", [], [], [])]);
  expect(s.recall).toBeNull();
  expect(s.precision).toBeNull();
  expect(s.factAccuracy).toBeNull();
  expect(s.snippetRate).toBeNull();
  expect(formatSummary(s)).toContain("n/a");
});

test("summarize computes recall, precision and accuracy", () => {
  const docs = [scoreDoc("d", [exp(), exp({ markerLabel: "RBC", value: "3.6" })], [cand(), cand({ trackedMarkerLabel: "WBC" })], [])];
  const s = summarize(docs);
  expect(s.expected).toBe(2);
  expect(s.matched).toBe(1);
  expect(s.recall).toBe(0.5);
  expect(s.precision).toBe(0.5);
  expect(s.factAccuracy).toBe(1);
});

test("snippet rate counts candidates with a verified snippet", () => {
  const s = summarize([scoreDoc("d", [exp()], [cand(), cand({ trackedMarkerLabel: "X", sourceSnippet: null })], [])]);
  expect(s.snippetRate).toBe(0.5);
});

test("marker match: eligible correctness and false canonical matches", () => {
  const withCanon = scoreDoc("d", [exp({ markerLabel: "Carcinoembryonic Antigen", canonicalMarker: "CEA", value: "5" })],
    [cand({ trackedMarkerLabel: "Carcinoembryonic Antigen", value: "5" })], []);
  const falseHit = scoreDoc("e", [exp({ markerLabel: "Something", canonicalMarker: null })], [cand({ trackedMarkerLabel: "CEA" })], []);
  const s = summarize([withCanon, falseHit]);
  expect(s.markerMatch.eligible).toBe(1);
  expect(s.markerMatch.correct).toBe(1);
  expect(s.markerMatch.falseCanonical).toEqual([]); // label mismatch -> spurious, not paired
});

test("calibration buckets count spurious facts as incorrect", () => {
  const s = summarize([scoreDoc("d", [exp()], [cand({ confidence: 0.9 }), cand({ trackedMarkerLabel: "Z", confidence: 0.3 })], [])]);
  const high = s.calibration.buckets.find((b) => b.label === "0.8-1")!;
  const low = s.calibration.buckets.find((b) => b.label === "0-0.5")!;
  expect(high).toMatchObject({ n: 1, correct: 1 });
  expect(low).toMatchObject({ n: 1, correct: 0 });
  expect(s.calibration.meanConfidenceCorrect).toBeCloseTo(0.9);
  expect(s.calibration.meanConfidenceIncorrect).toBeCloseTo(0.3);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/eval/score.test.ts`
Expected: FAIL, `summarize` not exported.

- [ ] **Step 3: Append to `score.ts`**

```ts
import { matchMarker } from "@prelude/shared";

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
```

Move the `import { matchMarker }` line to the top import block of `score.ts` when appending.

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/eval/score.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/eval/score.ts apps/api/eval/score.test.ts
git commit -m "eval: aggregate metrics, calibration and summary formatting"
```

---

### Task 3: Fixture builder and answer keys

**Files:**
- Create: `apps/api/eval/buildFixtures.ts`
- Create (gitignored, not committed): `apps/api/eval/fixtures/<slug>.ocr.json`, `apps/api/eval/fixtures/<slug>.expected.json`
- Modify: `package.json` (root) scripts

**Interfaces:**
- Produces: for each PDF in `docs/reports/`, `<slug>.ocr.json` shaped as `OcrResult` (`fullText`, `pages[{pageNumber,text}]`, `providerName: "pdftotext"`), where `slug` = lowercased filename without `.pdf`, non-alphanumerics replaced by `-`, trimmed of `-`. And `<slug>.expected.json` shaped as `ExpectedDoc` (Task 1).

- [ ] **Step 1: Write `buildFixtures.ts`**

```ts
import { readdir } from "node:fs/promises";
import type { OcrResult } from "@prelude/shared";

const REPORTS = new URL("../../../docs/reports/", import.meta.url);
const OUT = new URL("./fixtures/", import.meta.url);

export function slugFor(filename: string): string {
  return filename.replace(/\.pdf$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// pdftotext separates pages with form feeds.
export function toOcrResult(text: string): OcrResult {
  const pages = text.split("\f").map((t, i) => ({ pageNumber: i + 1, text: t }));
  while (pages.length > 0 && pages[pages.length - 1]!.text.trim() === "") pages.pop();
  return {
    fullText: pages.map((p) => p.text).join("\n"),
    pages,
    providerName: "pdftotext",
    providerRaw: null,
  };
}

if (import.meta.main) {
  const pdfs = (await readdir(REPORTS)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  if (pdfs.length === 0) throw new Error(`No PDFs in ${REPORTS.pathname}`);
  for (const pdf of pdfs) {
    const path = new URL(pdf, REPORTS).pathname;
    const text = await Bun.$`pdftotext -layout ${path} -`.text();
    const ocr = toOcrResult(text);
    await Bun.write(new URL(`${slugFor(pdf)}.ocr.json`, OUT), JSON.stringify(ocr, null, 2));
    console.log(`${pdf} -> ${slugFor(pdf)}.ocr.json (${ocr.pages.length} pages)`);
  }
}
```

- [ ] **Step 2: Add a test for the pure helpers** (append to `score.test.ts`, synthetic text)

```ts
import { slugFor, toOcrResult } from "./buildFixtures";

test("slugFor and toOcrResult", () => {
  expect(slugFor("AJAY UPADHYAY .pdf")).toBe("ajay-upadhyay");
  const r = toOcrResult("page one\fpage two\f");
  expect(r.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
  expect(r.pages[1]!.text).toBe("page two");
});
```

Run: `bun test apps/api/eval/score.test.ts` — Expected: PASS (importing `buildFixtures` must not run the PDF loop; `import.meta.main` guards it).

- [ ] **Step 3: Add root script and build fixtures**

Add to root `package.json` scripts: `"eval:fixtures": "bun apps/api/eval/buildFixtures.ts"` and `"eval:extraction": "bun apps/api/eval/run.ts"`.

Run: `bun run eval:fixtures`
Expected: 6 lines, one per PDF, each with its page count (14242c5f… 11, 71e9031e… 12, AJAY UPADHYAY 1, AJAY-UPADHYAY_report 2, eb02f641… 8, NOI26051887 3).

- [ ] **Step 4: Draft the answer keys**

For each `fixtures/<slug>.ocr.json`, read the page text and write `fixtures/<slug>.expected.json` as an `ExpectedDoc`. Conventions:
- `documentType`: `radiology` for the chest X-ray, `blood` for all lab reports (CBC/HbA1c panels, APTT, peripheral smear).
- One `marker_value` fact per labelled result: `markerLabel` exactly as printed, `value`, `unit`, `referenceRange` (as printed), `sourcePage`.
- `asOfDate`: the collection date (`Collected On` / `Sample Date`) as ISO; put the report date in `altDates`.
- `canonicalMarker`: `null` unless `matchMarker` (see `packages/shared/src/markers.ts`) would map the label; the controlled list is tumour markers only, so expect `null` for all of these reports.
- Chest X-ray: one `radiology_impression` fact, `markerLabel: null`, `value` the impression text, `asOfDate` the report date.
- Peripheral smear: differential counts as `marker_value` with unit `%`; include a qualitative morphology line only where it is a labelled result.
- Page numbers come from the `pageNumber` of the page the row appears on. Skip repeated page headers and method lines.

- [ ] **Step 5: Validate the answer keys parse**

Run: `bun -e 'import {ExpectedDocSchema} from "./apps/api/eval/types"; import {readdirSync} from "node:fs"; for (const f of readdirSync("apps/api/eval/fixtures").filter(f=>f.endsWith(".expected.json"))) { const d = ExpectedDocSchema.parse(await Bun.file("apps/api/eval/fixtures/"+f).json()); console.log(f, d.facts.length) }'`
Expected: six files listed with fact counts, no zod error.

- [ ] **Step 6: USER CHECKPOINT: answer-key review**

Stop. Ask the user to review and correct `apps/api/eval/fixtures/*.expected.json`. Do not run the scorer against unreviewed keys.

- [ ] **Step 7: Commit (code only)**

```bash
git add apps/api/eval/buildFixtures.ts apps/api/eval/score.test.ts package.json
git status --short   # confirm no fixtures/ or docs/reports/ files are staged
git commit -m "eval: pdftotext fixture builder"
```

---

### Task 4: Runner and baseline

**Files:**
- Create: `apps/api/eval/run.ts`

**Interfaces:**
- Consumes: `ExpectedDocSchema`, `scoreDoc`, `summarize`, `formatSummary`, `getExtractionProvider()` from `../src/services/providerFactory`.
- Produces: console summary plus `apps/api/eval/results/<ISO timestamp>.json` with `{ provider, model, date, repeat, summary, docs }`.

- [ ] **Step 1: Write `run.ts`**

```ts
import { readdir } from "node:fs/promises";
import type { OcrResult } from "@prelude/shared";
import { getExtractionProvider } from "../src/services/providerFactory";
import { ExpectedDocSchema } from "./types";
import { formatSummary, scoreDoc, summarize, type DocScore } from "./score";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const RESULTS = new URL("./results/", import.meta.url);

const repeatArg = process.argv.indexOf("--repeat");
const repeat = repeatArg >= 0 ? Number(process.argv[repeatArg + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat expects a positive integer");

const names = (await readdir(FIXTURES).catch(() => [] as string[]))
  .filter((f) => f.endsWith(".expected.json"))
  .map((f) => f.replace(".expected.json", ""))
  .sort();
if (names.length === 0) {
  throw new Error(`No fixtures in ${FIXTURES.pathname}. Run \`bun run eval:fixtures\` and write the .expected.json answer keys first.`);
}

const provider = getExtractionProvider();
const docs: DocScore[] = [];

for (let run = 1; run <= repeat; run++) {
  for (const name of names) {
    const ocr = (await Bun.file(new URL(`${name}.ocr.json`, FIXTURES)).json()) as OcrResult;
    const expected = ExpectedDocSchema.parse(await Bun.file(new URL(`${name}.expected.json`, FIXTURES)).json());
    const { candidates, failedFieldTypes } = await provider.extractFacts(ocr, expected.documentType);
    const score = scoreDoc(repeat > 1 ? `${name}#${run}` : name, expected.facts, candidates, failedFieldTypes);
    docs.push(score);
    console.log(
      `${score.name}: expected ${score.expected.length}, extracted ${score.extracted.length}, ` +
        `matched ${score.results.length}, wrong ${score.results.filter((r) => !r.correct).length}, ` +
        `missed ${score.missed.length}, spurious ${score.spurious.length}` +
        (failedFieldTypes.length ? ` | FAILED field types: ${failedFieldTypes.join(",")}` : ""),
    );
  }
}

const summary = summarize(docs);
console.log("\n" + formatSummary(summary));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await Bun.write(
  new URL(`${stamp}.json`, RESULTS),
  JSON.stringify({ provider: provider.name, model: process.env.EXTRACTION_MODEL ?? null, date: new Date().toISOString(), repeat, summary, docs }, null, 2),
);
console.log(`\nSaved apps/api/eval/results/${stamp}.json`);
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors in `apps/api/eval/*`.

- [ ] **Step 3: Run unit tests**

Run: `bun test apps/api/eval`
Expected: all PASS.

- [ ] **Step 4: Run the baseline against the reviewed answer keys**

Requires the user's approval of the answer keys (Task 3 Step 6) and `EXTRACTION_PROVIDER` plus its API key in `.env`. This sends the real reports to the configured LLM provider; confirm with the user before running.

Run: `bun run eval:extraction`
Expected: one line per fixture, then the summary block, then `Saved apps/api/eval/results/<stamp>.json`.

- [ ] **Step 5: Record the baseline and commit**

Report the summary to the user (recall, precision, accuracy, snippet rate, calibration, and the per-fact missed/wrong lists from the results JSON). Commit code only:

```bash
git add apps/api/eval/run.ts
git status --short   # confirm results/ and fixtures/ are not staged
git commit -m "eval: extraction eval runner"
```
