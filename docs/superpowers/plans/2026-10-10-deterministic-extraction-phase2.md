# Deterministic Extraction, Phase 2 (Metadata and Safety) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the deterministic parser (phase 1) patient-identity safety, free arithmetic/structure checks, the DB columns to store what it finds, and a feature-flagged path into the real upload flow — without changing today's default (LLM) production behaviour.

**Architecture:** Two new pure modules (`identity.ts`, `validate.ts`) sit beside the phase-1 parser files and are wired into `pipeline.ts`/`provider.ts`. A new migration adds the columns the spec calls for on `documents` and `facts`. `services/delta.ts`'s existing `LIVE_FACT_FILTER` — already the single chokepoint every snapshot/timeline/trend/visit-count query shares — gets one more clause, so "exclude held documents" is one change, not an audit of every reader. `routes/documents.ts` gains `file_sha256` + OCR reuse and, behind `EXTRACTION_MODE=deterministic` (default stays `llm`), writes header/identity metadata alongside facts. A new confirm/reject endpoint resolves a held (`mismatch`) document.

**Tech Stack:** Bun, TypeScript, Bun's built-in `SQL` client and `Bun.CryptoHasher`, existing phase-1 deterministic parser.

**Spec:** `docs/superpowers/specs/2026-10-10-deterministic-extraction-design.md` (phase 2 of 4; phase 1 — `input`/`header`/`rows`/harness adapter — is already merged).

## Global Constraints

- Use Bun (`bun test`, `bun add`, `bun run`); no Node/jest/dotenv. Run commands from the repo root `/home/dev-var/Documents/Projects/OPD`.
- New pure-logic code lives in `apps/api/src/services/extraction/deterministic/`, alongside the phase-1 files. Tests use synthetic text only — never real patient values.
- Default production behaviour must not change: `EXTRACTION_MODE` defaults to `llm`; everything that currently runs (OCR, LLM extraction, upload) must behave identically for a document when `EXTRACTION_MODE` is unset.
- A wrong value is worse than a missing one: a failed free check lowers confidence and flags the row for review; it never auto-corrects or drops the row.
- Units are never converted, only compared (`unitsEquivalent`, phase 1) — unchanged here.
- Migrations are plain numbered `.sql` files applied with `psql $DATABASE_URL -f <file>` (no migration runner exists); `infra/docker-compose.yml` mounts each one explicitly as a Postgres init script, so a fresh container picks it up and an already-initialized local DB needs the direct `psql` apply too.
- DB-backed tests need Postgres running: `docker compose -f infra/docker-compose.yml up -d` (healthcheck gates readiness), `DATABASE_URL` from `.env`.

## Review corrections (applied after a review against the merged phase 1 code)

- **Identity (Task 1):** a name with a *different surname* is evidence of a different person and is `mismatch`, not `partial`; initials only match when one side really is a single-letter initial; fuzzy matching is per token (a shared surname must not carry the score). The design spec's Identity match section was updated to match.
- **Order of writes (Task 6) and confirm (Task 9):** identity status is written *before* conflict detection and a held document opens no conflicts; confirming runs conflict detection for its now-live facts. Without this a wrong-patient document's facts opened conflicts against the real patient's facts.
- **`merged` row shape (Task 2):** phase 1 added a `merged` shape; the confidence map must include it or confidence becomes NaN.
- **Silent empty (Task 8):** in `EXTRACTION_MODE=deterministic`, zero candidates falls back to the LLM provider (and Task 7 exposes `getLlmExtractionProvider`).

## Open items needing a decision (not changed here)

- **Marker collision before production use:** `MARKER_REGISTRY` holds `Tg` (thyroglobulin) and `matchMarker` is case-insensitive, so a lipid row `TG 150 mg/dL` would canonicalise to Thyroglobulin once candidates are matched in `persistExtractedFacts`. The list comes from the partner oncologist (Decisions Log), so changing the alias needs clinical input. Until decided, keep `EXTRACTION_MODE=llm` in production.
- **Sign-off of a held document's facts:** reads exclude held facts, but a clinician can still sign off a held document's fact from the review screen. Decide whether sign-off should be blocked while `identity_status = 'mismatch'`.

## Deploy order and remaining gaps (from the phase 2 final review)

- **Migration 009 must be applied BEFORE this code is deployed, in every mode.** `LIVE_FACT_FILTER` now references `documents.identity_status`, so every snapshot, timeline, visit and conflict read fails on a database without the column; migrations are applied by hand (`psql $DATABASE_URL -f ...`) and `infra/deploy.sh` does not run them.
- **Do not enable `EXTRACTION_MODE=deterministic` in production until:** (1) a screen lists documents held for identity (`identity_status = 'mismatch'`), because today a held document is invisible except on its own review page and a legitimate document (name variants such as `Mohd` / `Mohammed`, OCR errors in the name) would silently drop out of the snapshot; (2) the `partial` identity status (close first-name variants such as `Amit` / `Amita`, a first-name-only report) is shown to staff, because nothing reads it yet; (3) the `Tg` / `TG` marker collision and sign-off-while-held decisions below are made.
- **Default (`llm`) mode changes that remain:** every upload now stores `file_sha256`, and every fact read now joins `documents.identity_status` (NULL for all existing documents, never held). OCR reuse is gated to deterministic mode only.
- **Read-side defence, not just write-side:** held documents are excluded by `LIVE_FACT_FILTER`, by the conflict join in `loadConflicts`, and by a guard inside `detectConflicts`; `routes/conflicts.ts` `factWithProvenance` was left unfiltered because no conflict can reference a held fact any more.

## Review Focus

- A document whose report has no printed patient name at all, or whose patient record has no name, must be `unknown`, never `mismatch` — a missing name is not evidence of a wrong patient. (Task 1)
- A name match that only shares a common first name (two different people named "Priya") must not be accepted as `matched` — the spec's rules require *all* of the shorter name's tokens (≥2) to appear in the longer name for `matched`; a bare first-token share is only `partial`. (Task 1)
- A document-level arithmetic check (MCHC, MCV, differential sum, …) must only run — and only flag rows — when every value it needs is actually present; a document missing RBC must not crash or wrongly flag MCV/MCH as failed. (Task 2)
- `LIVE_FACT_FILTER`'s new clause must not exclude facts from documents that were never assessed for identity (`identity_status IS NULL`, the case for every document today and every non-blood document) — only `mismatch`/`rejected` are held. (Task 5)
- OCR reuse must key on `(patient_id, file_sha256)`, never on `file_sha256` alone — two different patients uploading byte-identical form PDFs must not see each other's OCR text. (Task 8)

---

### Task 1: Patient-identity match (`identity.ts`)

**Files:**
- Create: `apps/api/src/services/extraction/deterministic/identity.ts`
- Test: `apps/api/src/services/extraction/deterministic/identity.test.ts`

**Interfaces:**
- Produces: `IdentityMatchStatus` (`"matched" | "partial" | "mismatch" | "unknown"`), `IdentityMatch { status; reason }`, `normalizeName(name): string[]`, `jaroWinkler(a, b): number`, `matchIdentity(patientName, reportName): IdentityMatch`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { matchIdentity, normalizeName, jaroWinkler } from "./identity";

test("normalizeName strips titles, relational suffixes and punctuation", () => {
  expect(normalizeName("Mr. VARUN")).toEqual(["varun"]);
  expect(normalizeName("Varun S/O Suresh Upadhyay")).toEqual(["varun"]);
  expect(normalizeName("Smt. Priya Sharma")).toEqual(["priya", "sharma"]);
});

test("jaroWinkler matches the textbook example", () => {
  expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
  expect(jaroWinkler("varun", "varun")).toBe(1);
});

test("identical and superset names are matched", () => {
  expect(matchIdentity("Varun Upadhyay", "Varun Upadhyay").status).toBe("matched");
  expect(matchIdentity("Varun Upadhyay", "Mr. Varun Kumar Upadhyay").status).toBe("matched");
});

test("a first-name-only report, or an initial for the first name, is partial (not enough evidence either way)", () => {
  expect(matchIdentity("Varun Upadhyay", "Mr. VARUN").status).toBe("partial");
  expect(matchIdentity("Varun Upadhyay", "V. Upadhyay").status).toBe("partial");
});

test("same first name but a different surname is two different people: mismatch, never accepted", () => {
  expect(matchIdentity("Priya Sharma", "Priya Patel").status).toBe("mismatch");
  expect(matchIdentity("Priya Sharma", "Priya Verma").status).toBe("mismatch");
});

test("same surname but a different first name is not a match, and a shared first letter alone is not 'initials'", () => {
  expect(matchIdentity("Sanjay Gupta", "Suresh Gupta").status).toBe("mismatch");
});

test("two unrelated names are mismatch", () => {
  expect(matchIdentity("Varun Upadhyay", "Suresh Kumar").status).toBe("mismatch");
});

test("a missing report name or missing patient name is unknown, never mismatch", () => {
  expect(matchIdentity("Varun Upadhyay", null).status).toBe("unknown");
  expect(matchIdentity(null, "Varun Upadhyay").status).toBe("unknown");
  expect(matchIdentity(null, null).status).toBe("unknown");
  expect(matchIdentity("Varun Upadhyay", "   ").status).toBe("unknown");
});

test("a transliteration variant of every token is partial, per-token (a shared surname must not carry the score)", () => {
  expect(matchIdentity("Shreya Gupta", "Shreyaa Gupta").status).toBe("partial");
  expect(matchIdentity("Sanjay Gupta", "Suresh Gupta").status).toBe("mismatch");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/identity.test.ts`
Expected: FAIL, cannot find module `./identity`.

- [ ] **Step 3: Write the implementation**

```ts
const TITLES = new Set(["mr", "mrs", "ms", "dr", "shri", "smt", "master", "baby"]);

// s/o, w/o, d/o introduce the father's/husband's name (common on Indian lab
// reports), never the patient's own — everything from that marker onward is dropped.
export function normalizeName(name: string): string[] {
  const stripped = name
    .toLowerCase()
    .replace(/\b(s\/o|w\/o|d\/o)\b.*$/i, "")
    .replace(/[^a-z\s]/g, " ");
  const tokens = stripped.split(/\s+/).filter(Boolean);
  const withoutTitles = tokens.filter((t) => !TITLES.has(t));
  return withoutTitles.length > 0 ? withoutTitles : tokens;
}

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

export function jaroWinkler(s1: string, s2: string): number {
  const jaroScore = jaro(s1, s2);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaroScore + prefix * 0.1 * (1 - jaroScore);
}

function isInitialOf(initial: string, full: string): boolean {
  return initial.length === 1 && full.length > 1 && full[0] === initial;
}

// Equal-length names where every token is equal or one side is just the initial of the other ("V." / "Varun").
function initialsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i] || isInitialOf(t, b[i]!) || isInitialOf(b[i]!, t));
}

const tokenSimilar = (x: string, y: string) => x === y || jaroWinkler(x, y) >= 0.9;

export type IdentityMatchStatus = "matched" | "partial" | "mismatch" | "unknown";

export interface IdentityMatch {
  status: IdentityMatchStatus;
  reason: string;
}

// Rules, in priority order, from docs/superpowers/specs/2026-10-10-deterministic-extraction-design.md "Identity match".
// Safety: a conflicting name (different surname) is evidence of a DIFFERENT person and is held; only the
// absence of evidence (no name, or a first-name-only report) is "unknown"/"partial".
export function matchIdentity(patientName: string | null, reportName: string | null): IdentityMatch {
  if (!patientName?.trim() || !reportName?.trim()) {
    return { status: "unknown", reason: "no name on the report or no patient name on file" };
  }
  const a = normalizeName(patientName);
  const b = normalizeName(reportName);
  if (a.length === 0 || b.length === 0) return { status: "unknown", reason: "no usable name tokens" };
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === setB.size && [...setA].every((t) => setB.has(t))) {
    return { status: "matched", reason: "all name tokens match" };
  }

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 2 && shorter.every((t) => longer.includes(t))) {
    return { status: "matched", reason: "all tokens of the shorter name appear in the longer name" };
  }

  // Both names carry a surname and the surnames differ: a different person, even with the same first name.
  if (a.length >= 2 && b.length >= 2) {
    const lastA = a[a.length - 1]!;
    const lastB = b[b.length - 1]!;
    if (!tokenSimilar(lastA, lastB) && !isInitialOf(lastA, lastB) && !isInitialOf(lastB, lastA)) {
      return { status: "mismatch", reason: "surnames differ" };
    }
  }

  if (initialsMatch(a, b)) return { status: "partial", reason: "matches by initials" };
  if (shorter.length === 1 && longer.some((t) => tokenSimilar(shorter[0]!, t))) {
    return { status: "partial", reason: "a single name token is present in the other name" };
  }
  if (shorter.length >= 2 && shorter.every((t) => longer.some((u) => tokenSimilar(t, u)))) {
    return { status: "partial", reason: "every name token has a close match (transliteration)" };
  }
  return { status: "mismatch", reason: "no shared name tokens or similarity" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic/identity.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/extraction/deterministic/identity.ts apps/api/src/services/extraction/deterministic/identity.test.ts
git commit -m "extraction: patient-identity match (matched/partial/mismatch/unknown)"
```

---

### Task 2: Free accuracy checks (`validate.ts`)

**Files:**
- Modify: `apps/api/src/services/extraction/deterministic/aliases.ts` (add Albumin/Globulin/A-G-ratio/indirect-bilirubin/absolute-count synonym groups)
- Create: `apps/api/src/services/extraction/deterministic/validate.ts`
- Test: `apps/api/src/services/extraction/deterministic/validate.test.ts`

**Interfaces:**
- Consumes: `ParsedRow`, `RowShape` (Task 2/`rows.ts` from phase 1), `aliasKeys`, `squash` (`aliases.ts`), `MARKER_REGISTRY`, `unitsEquivalent` (`units.ts`).
- Produces: `NamedCheck { key; rows; pass; detail }`, `valueParses(value): boolean`, `unitPlausible(label, unit): boolean | null`, `printedFlagAgrees(row): boolean | null`, `validateDocument(rows): NamedCheck[]`, `rowConfidence(shape): number`, `ValidatedRow { row; checks; confidence }`, `applyChecks(rows): ValidatedRow[]`.

- [ ] **Step 1: Add the missing alias groups**

In `apps/api/src/services/extraction/deterministic/aliases.ts`, add to the `GROUPS` array (any position; e.g. just before the closing `];`):

```ts
  ["ALBUMIN", "Serum Albumin", "S. Albumin", "ALBUMIN-SERUM"],
  ["GLOBULIN", "Serum Globulin", "S. Globulin", "GLOBULIN-SERUM"],
  ["A/G RATIO", "A/G", "AG RATIO", "Albumin/Globulin Ratio", "A/G Ratio"],
  ["BILIRUBIN (Indirect)", "Indirect Bilirubin", "Bilirubin, Indirect", "I. Bilirubin"],
  ["ABSOLUTE NEUTROPHIL COUNT", "ANC", "Absolute Neutrophil Count"],
  ["ABSOLUTE LYMPHOCYTE COUNT", "ALC", "Absolute Lymphocyte Count"],
  ["ABSOLUTE MONOCYTE COUNT", "AMC", "Absolute Monocyte Count"],
  ["ABSOLUTE EOSINOPHIL COUNT", "AEC", "Absolute Eosinophil Count"],
  ["ABSOLUTE BASOPHIL COUNT", "ABC", "Absolute Basophil Count"],
```

- [ ] **Step 2: Write the failing tests**

```ts
import { test, expect } from "bun:test";
import { linesFromText } from "./lines";
import { parseRows } from "./rows";
import {
  valueParses, unitPlausible, printedFlagAgrees, validateDocument, applyChecks, rowConfidence,
} from "./validate";

const parse = (text: string) => parseRows(linesFromText(text, 1)).rows;
const find = (rows: ReturnType<typeof parse>, label: string) =>
  rows.find((r) => r.label.toLowerCase().startsWith(label.toLowerCase()))!;

test("valueParses accepts numeric, count, duration and qualitative values; rejects nonsense", () => {
  expect(valueParses("10.1")).toBe(true);
  expect(valueParses("3-4")).toBe(true);
  expect(valueParses("2 Minute 30 Second")).toBe(true);
  expect(valueParses("YELLOW")).toBe(true);
  expect(valueParses("abc123")).toBe(false);
});

test("unitPlausible checks a known marker's unit list and is null for anything else", () => {
  expect(unitPlausible("CEA", "ng/mL")).toBe(true);
  expect(unitPlausible("CEA", "mmol/L")).toBe(false);
  expect(unitPlausible("Haemoglobin", "g/dL")).toBeNull();
  expect(unitPlausible("CEA", null)).toBeNull();
});

test("printedFlagAgrees compares the printed H/L flag against value vs. range", () => {
  const [above, within, noFlag] = parse(
    ["Neutrophils      92      %      40-80      H", "Lymphocytes      60      %      40-80      H", "Platelets      250      /uL      150-410"].join("\n"),
  );
  expect(printedFlagAgrees(above!)).toBe(true);
  expect(printedFlagAgrees(within!)).toBe(false);
  expect(printedFlagAgrees(noFlag!)).toBeNull();
});

const CBC_OK = [
  "HAEMOGLOBIN (Hb)      15.0      g/dL      13.0-17.0",
  "PACKED CELL VOLUME (PCV)      45.0      %      40.0-50.0",
  "RED BLOOD CELLS- RBC COUNT      5.0      millions/mm3      4.5-5.5",
  "MCV      90.0      fL      83-101",
  "MCH      30.0      pg      27.0-32.0",
  "MCHC      33.3      g/dL      31.5-34.5",
  "TOTAL LEUKOCYTE COUNT (TLC)      8000      /uL      4000-10000",
  "Neutrophils      60      %      40-80",
  "Lymphocytes      30      %      20-40",
  "Monocytes      5      %      2-10",
  "Eosinophils      4      %      1-6",
  "Basophils      1      %      0-2",
  "ABSOLUTE NEUTROPHIL COUNT      4800      /uL      2000-7000",
  "UREA      42      mg/dL      15-40",
  "BLOOD UREA NITROGEN (BUN)      19.6      mg/dL      7-20",
  "ALBUMIN      4.0      g/dL      3.5-5.0",
  "GLOBULIN      2.5      g/dL      2.0-3.5",
  "A/G RATIO      1.6      ratio      1.0-2.0",
  "BILIRUBIN TOTAL      1.0      mg/dL      0.2-1.2",
  "BILIRUBIN (Direct)      0.3      mg/dL      0.0-0.3",
  "BILIRUBIN (Indirect)      0.7      mg/dL      0.2-1.0",
].join("\n");

test("every document-level check passes on an internally-consistent CBC/LFT/RFT panel", () => {
  const rows = parse(CBC_OK);
  const checks = validateDocument(rows);
  expect(checks.length).toBeGreaterThanOrEqual(8);
  expect(checks.every((c) => c.pass)).toBe(true);
});

test("a wrong MCHC fails only the MCHC check, and only flags the MCHC row", () => {
  const rows = parse(CBC_OK.replace("MCHC      33.3", "MCHC      50.0"));
  const checks = validateDocument(rows);
  const mchc = checks.find((c) => c.key === "mchc")!;
  expect(mchc.pass).toBe(false);
  expect(mchc.rows.map((r) => r.label)).toEqual([find(rows, "MCHC").label]);
  expect(checks.filter((c) => c.key !== "mchc").every((c) => c.pass)).toBe(true);
});

test("a differential that does not sum to 100 fails, within a document missing RBC still runs the other checks safely", () => {
  const rows = parse(CBC_OK.replace("Basophils      1", "Basophils      11").replace(/RED BLOOD CELLS- RBC COUNT.*\n/, ""));
  const checks = validateDocument(rows);
  expect(checks.find((c) => c.key === "differentialSum")!.pass).toBe(false);
  expect(checks.some((c) => c.key === "mcv" || c.key === "mch")).toBe(false);
});

test("applyChecks lowers confidence by 0.2 per failed check and leaves a clean row's confidence untouched", () => {
  const rows = parse(CBC_OK.replace("MCHC      33.3", "MCHC      50.0"));
  const validated = applyChecks(rows);
  const mchc = validated.find((v) => v.row.label === find(rows, "MCHC").label)!;
  const hb = validated.find((v) => v.row.label === find(rows, "HAEMOGLOBIN").label)!;
  expect(mchc.confidence).toBeCloseTo(rowConfidence(mchc.row.shape) - 0.2, 5);
  expect(hb.confidence).toBe(rowConfidence(hb.row.shape));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/validate.test.ts`
Expected: FAIL, cannot find module `./validate`.

- [ ] **Step 4: Write the implementation**

```ts
import { MARKER_REGISTRY } from "@prelude/shared";
import { aliasKeys, squash } from "./aliases";
import { unitsEquivalent } from "./units";
import type { ParsedRow, RowShape } from "./rows";

const NUMERIC = /^[<>]?\s?\d[\d,]*(\.\d+)?$/;
const COUNT = /^\d+\s?-\s?\d+$/;
const DURATION = /^\d+\s*minutes?(\s*\d+\s*seconds?)?$/i;
const QUALITATIVE_WORDS =
  /^(negative|positive|nil|absent|present|clear|yellow|pale yellow|not increased|trace|normal|reactive|non[- ]reactive|detected|not detected)$/i;

// Deliberately independent of rows.ts's own classification: a future parser bug that
// mis-shapes a row should still be caught here, not silently trusted.
export function valueParses(value: string): boolean {
  return NUMERIC.test(value) || COUNT.test(value) || DURATION.test(value) || QUALITATIVE_WORDS.test(value);
}

export function unitPlausible(label: string, unit: string | null): boolean | null {
  if (unit === null) return null;
  const marker = MARKER_REGISTRY.find((m) => aliasKeys(label).has(squash(m.canonical)));
  if (!marker) return null;
  return marker.units.some((u) => unitsEquivalent(u, unit));
}

function parseRangeBounds(range: string): { lo: number; hi: number } | null {
  const m = range.match(/^\s*(\d[\d.]*)\s*(-|to)\s*(\d[\d.]*)\s*$/i);
  if (!m) return null;
  return { lo: Number(m[1]), hi: Number(m[3]) };
}

export function printedFlagAgrees(row: ParsedRow): boolean | null {
  if (!row.flag || !row.range) return null;
  const bounds = parseRangeBounds(row.range);
  const value = Number(row.value);
  if (!bounds || !Number.isFinite(value)) return null;
  const flag = row.flag.toUpperCase();
  if (flag === "H" || flag === "HH" || flag === "HIGH") return value > bounds.hi;
  if (flag === "L" || flag === "LL" || flag === "LOW") return value < bounds.lo;
  return null;
}

function num(rows: ParsedRow[], canonical: string): number | null {
  const row = rows.find((r) => aliasKeys(r.label).has(squash(canonical)));
  if (!row) return null;
  const v = Number(row.value);
  return Number.isFinite(v) ? v : null;
}

function rowFor(rows: ParsedRow[], canonical: string): ParsedRow | null {
  return rows.find((r) => aliasKeys(r.label).has(squash(canonical))) ?? null;
}

export interface NamedCheck {
  key: string;
  rows: ParsedRow[];
  pass: boolean;
  detail: string;
}

const DIFFERENTIAL = ["Neutrophils", "Lymphocytes", "Monocytes", "Eosinophils", "Basophils"];
const DIFF_TO_ABSOLUTE: [string, string, string][] = [
  ["Neutrophils", "ABSOLUTE NEUTROPHIL COUNT", "absoluteNeutrophil"],
  ["Lymphocytes", "ABSOLUTE LYMPHOCYTE COUNT", "absoluteLymphocyte"],
  ["Monocytes", "ABSOLUTE MONOCYTE COUNT", "absoluteMonocyte"],
  ["Eosinophils", "ABSOLUTE EOSINOPHIL COUNT", "absoluteEosinophil"],
  ["Basophils", "ABSOLUTE BASOPHIL COUNT", "absoluteBasophil"],
];

// Each check runs only when every value it needs is present and numeric; a
// document missing an input yields no check for it (never a false failure).
export function validateDocument(rows: ParsedRow[]): NamedCheck[] {
  const out: NamedCheck[] = [];

  const diffValues = DIFFERENTIAL.map((name) => ({ name, row: rowFor(rows, name), value: num(rows, name) }));
  if (diffValues.every((d) => d.value !== null)) {
    const sum = diffValues.reduce((s, d) => s + d.value!, 0);
    out.push({
      key: "differentialSum",
      rows: diffValues.map((d) => d.row!),
      pass: Math.abs(sum - 100) <= 2,
      detail: `differential sums to ${sum.toFixed(1)}%`,
    });
  }

  const hb = num(rows, "Haemoglobin");
  const pcv = num(rows, "PCV");
  const rbc = num(rows, "RBC");

  const mchcRow = rowFor(rows, "MCHC");
  if (hb !== null && pcv !== null && pcv !== 0 && mchcRow) {
    const mchc = Number(mchcRow.value);
    if (Number.isFinite(mchc)) {
      const expected = (hb / pcv) * 100;
      out.push({ key: "mchc", rows: [mchcRow], pass: Math.abs(mchc - expected) <= 1.5, detail: `MCHC ${mchc} vs expected ${expected.toFixed(1)}` });
    }
  }

  const mcvRow = rowFor(rows, "MCV");
  if (pcv !== null && rbc !== null && rbc !== 0 && mcvRow) {
    const mcv = Number(mcvRow.value);
    if (Number.isFinite(mcv)) {
      const expected = (pcv / rbc) * 10;
      out.push({ key: "mcv", rows: [mcvRow], pass: Math.abs(mcv - expected) <= 3, detail: `MCV ${mcv} vs expected ${expected.toFixed(1)}` });
    }
  }

  const mchRow = rowFor(rows, "MCH");
  if (hb !== null && rbc !== null && rbc !== 0 && mchRow) {
    const mch = Number(mchRow.value);
    if (Number.isFinite(mch)) {
      const expected = (hb / rbc) * 10;
      out.push({ key: "mch", rows: [mchRow], pass: Math.abs(mch - expected) <= 1, detail: `MCH ${mch} vs expected ${expected.toFixed(1)}` });
    }
  }

  const tlc = num(rows, "WBC");
  if (tlc !== null) {
    for (const [pctName, absName, key] of DIFF_TO_ABSOLUTE) {
      const pct = num(rows, pctName);
      const absRow = rowFor(rows, absName);
      if (pct === null || !absRow) continue;
      const abs = Number(absRow.value);
      if (!Number.isFinite(abs)) continue;
      const expected = (tlc * pct) / 100;
      out.push({ key, rows: [absRow], pass: Math.abs(abs - expected) <= expected * 0.05, detail: `${key} ${abs} vs expected ${expected.toFixed(2)}` });
    }
  }

  const urea = num(rows, "UREA");
  const bunRow = rowFor(rows, "BLOOD UREA NITROGEN (BUN)");
  if (urea !== null && bunRow) {
    const bun = Number(bunRow.value);
    if (Number.isFinite(bun)) {
      const expected = urea * 0.467;
      out.push({ key: "bun", rows: [bunRow], pass: Math.abs(bun - expected) <= expected * 0.03, detail: `BUN ${bun} vs expected ${expected.toFixed(2)}` });
    }
  }

  const albumin = num(rows, "ALBUMIN");
  const globulin = num(rows, "GLOBULIN");
  const agRow = rowFor(rows, "A/G RATIO");
  if (albumin !== null && globulin !== null && globulin !== 0 && agRow) {
    const ratio = Number(agRow.value);
    if (Number.isFinite(ratio)) {
      const expected = albumin / globulin;
      out.push({ key: "agRatio", rows: [agRow], pass: Math.abs(ratio - expected) <= 0.05, detail: `A/G ${ratio} vs expected ${expected.toFixed(2)}` });
    }
  }

  const total = num(rows, "BILIRUBIN TOTAL");
  const direct = num(rows, "BILIRUBIN (Direct)");
  const indirectRow = rowFor(rows, "BILIRUBIN (Indirect)");
  if (total !== null && direct !== null && indirectRow) {
    const indirect = Number(indirectRow.value);
    if (Number.isFinite(indirect)) {
      const expected = total - direct;
      out.push({
        key: "indirectBilirubin",
        rows: [indirectRow],
        pass: Math.abs(indirect - expected) <= 0.05,
        detail: `indirect bilirubin ${indirect} vs expected ${expected.toFixed(2)}`,
      });
    }
  }

  return out;
}

// Confidence comes from how completely the row parsed (structure), never from a model.
export function rowConfidence(shape: RowShape): number {
  return { full: 0.95, value_unit: 0.85, dash: 0.85, qualitative: 0.8, value_only: 0.7, merged: 0.65 }[shape];
}

export interface ValidatedRow {
  row: ParsedRow;
  checks: Record<string, boolean | null>;
  confidence: number;
}

export function applyChecks(rows: ParsedRow[]): ValidatedRow[] {
  const checksByRow = new Map<ParsedRow, Record<string, boolean | null>>();
  for (const row of rows) {
    checksByRow.set(row, {
      valueParses: valueParses(row.value),
      unitPlausible: unitPlausible(row.label, row.unit),
      printedFlagAgrees: printedFlagAgrees(row),
    });
  }
  for (const check of validateDocument(rows)) {
    for (const row of check.rows) {
      const checks = checksByRow.get(row);
      if (checks) checks[check.key] = check.pass;
    }
  }
  return rows.map((row) => {
    const checks = checksByRow.get(row)!;
    const failed = Object.values(checks).filter((v) => v === false).length;
    return { row, checks, confidence: Math.max(0, rowConfidence(row.shape) - 0.2 * failed) };
  });
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic/validate.test.ts apps/api/src/services/extraction/deterministic/aliases.test.ts`
Expected: all PASS. If a document-level check's test is flaky on the exact tolerance, adjust the synthetic fixture's numbers, not the tolerance (it's copied verbatim from the spec).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/extraction/deterministic/aliases.ts apps/api/src/services/extraction/deterministic/validate.ts apps/api/src/services/extraction/deterministic/validate.test.ts
git commit -m "extraction: free accuracy checks (per-row and per-document arithmetic)"
```

---

### Task 3: Wire checks into the pipeline and provider

**Files:**
- Modify: `packages/shared/src/providers/extraction.ts` (new optional fields)
- Modify: `apps/api/src/services/extraction/deterministic/pipeline.ts`
- Modify: `apps/api/src/services/extraction/deterministic/provider.ts`
- Modify: `apps/api/src/services/extraction/deterministic/pipeline.test.ts`

**Interfaces:**
- Consumes: `applyChecks`, `rowConfidence`, `ValidatedRow` (Task 2).
- Produces: `toCandidates` now returns candidates carrying `printedFlag`/`parseChecks`; `DeterministicExtractionProvider.extractFacts` now returns `header` on its `ExtractionResult` for blood documents.

- [ ] **Step 1: Write the failing test**

Append to `pipeline.test.ts` (keep the existing tests; `rowConfidence` is now re-exported from `./validate` via `pipeline.ts`, so its existing import `import { parseDocument, toCandidates, rowConfidence } from "./pipeline";` keeps working unchanged):

```ts
test("a candidate carries the printed flag and per-row parse checks, with confidence reduced for a failed check", () => {
  const text = [
    "SYNTHETIC DIAGNOSTIC LABS",
    "Patient Name : Mr. TEST PERSON      Collected On : 08/Apr/2026 10:00 AM",
    "Test Name   Result   Unit   Bio. Ref. Interval",
    "Neutrophils      92      %      40-80      H",
  ].join("\n");
  const c = toCandidates(parseDocument(ocr(text)));
  expect(c[0]).toMatchObject({ printedFlag: "H" });
  expect(c[0]!.parseChecks).toMatchObject({ valueParses: true, printedFlagAgrees: true });
});

test("DeterministicExtractionProvider reports parsed header fields on the result for blood documents", async () => {
  const r = await new DeterministicExtractionProvider().extractFacts(ocr(TEXT), "blood");
  expect(r.header).toMatchObject({ labName: "SYNTHETIC DIAGNOSTIC LABS", collectedOn: "2026-04-08" });
});

test("non-blood documents carry no header", async () => {
  const r = await new DeterministicExtractionProvider().extractFacts(ocr("IMPRESSION: normal"), "radiology");
  expect(r.header).toBeUndefined();
});
```

Also add (phase 1 gained a `merged` row shape in its review fixes, for a label+number merged cell like `Interleukin 6`; without a confidence entry the map returns `undefined` and `Math.max(0, NaN)` yields NaN):

```ts
test("every row shape has a finite confidence, including 'merged'", () => {
  for (const shape of ["full", "value_unit", "value_only", "dash", "qualitative", "merged"] as const) {
    expect(Number.isFinite(rowConfidence(shape))).toBe(true);
  }
  expect(rowConfidence("merged")).toBeLessThan(rowConfidence("value_unit"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/pipeline.test.ts`
Expected: FAIL (`printedFlag`/`parseChecks`/`header` are `undefined`/missing).

- [ ] **Step 3: Implement**

`packages/shared/src/providers/extraction.ts`: add to `ExtractedFactCandidate`:

```ts
  // Printed H/L/HH/LL flag as it appears on the report, independent of parseChecks.printedFlagAgrees. Null when the parser is an LLM or no flag was printed.
  printedFlag?: string | null;
  // Free-check results from validate.ts, keyed by check name; null/undefined for an LLM pass.
  parseChecks?: Record<string, boolean | null> | null;
```

and to `ExtractionResult`:

```ts
  // Structured header fields from a rule-based parser (lab, dates, patient as printed). Undefined for an LLM pass or a document type it doesn't handle.
  header?: { labName: string | null; collectedOn: string | null; receivedOn: string | null; reportedOn: string | null; patientName: string | null; labPatientRef: string | null };
```

`pipeline.ts` (full new contents):

```ts
import type { ExtractedFactCandidate, OcrResult } from "@prelude/shared";
import { parseHeader, type HeaderFields } from "./header";
import { linesFromText } from "./lines";
import { parseRows, type ParsedRow } from "./rows";
import type { Line } from "./types";
import { applyChecks, rowConfidence } from "./validate";

export { rowConfidence };

export interface ParsedDocument {
  header: HeaderFields;
  rows: ParsedRow[];
  unplacedNumeric: Line[];
  lineCount: number;
}

export function parseDocument(ocr: OcrResult): ParsedDocument {
  const lines = ocr.pages.flatMap((p) => linesFromText(p.text, p.pageNumber));
  const header = parseHeader(lines);
  const { rows, unplacedNumeric } = parseRows(lines);
  return { header, rows, unplacedNumeric, lineCount: lines.length };
}

export function toCandidates(parsed: ParsedDocument): ExtractedFactCandidate[] {
  const asOfDate = parsed.header.collectedOn ?? parsed.header.reportedOn ?? null;
  return applyChecks(parsed.rows).map(({ row, checks, confidence }) => ({
    fieldType: "marker_value",
    trackedMarkerLabel: row.label,
    value: row.value,
    unit: row.unit,
    referenceRange: row.range,
    asOfDate,
    coverageStatus: "value_found",
    sourcePage: row.page,
    sourceLocation: null,
    sourceSnippet: row.snippet,
    confidence,
    printedFlag: row.flag,
    parseChecks: checks,
  }));
}
```

`provider.ts`: add `header: parsed.header` to the blood-path return:

```ts
    const parsed = parseDocument(ocr);
    return {
      candidates: toCandidates(parsed),
      failedFieldTypes: [],
      stats: { rows: parsed.rows.length, unplacedNumericLines: parsed.unplacedNumeric.length, lines: parsed.lineCount },
      header: parsed.header,
    };
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic apps/api/eval && bunx tsc --noEmit 2>&1 | grep -E "deterministic|apps/api/eval"`
Expected: all PASS; no typecheck output.

- [ ] **Step 5: Re-run the phase-1 baseline (no gate should move)**

Run: `EVAL_PROVIDER=deterministic bun run eval:extraction`
Expected: the same three `PASS` gate lines as at the end of phase 1 — this task only adds fields, it must not change which candidates are produced.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/providers/extraction.ts apps/api/src/services/extraction/deterministic/pipeline.ts apps/api/src/services/extraction/deterministic/provider.ts apps/api/src/services/extraction/deterministic/pipeline.test.ts
git commit -m "extraction: wire free checks into candidates; surface parsed header on the provider result"
```

---

### Task 4: Migration — identity, header and parse-check columns

**Files:**
- Create: `apps/api/src/db/migrations/009_document_identity_and_parse_metadata.sql`
- Modify: `infra/docker-compose.yml`

**Interfaces:**
- Produces: `documents.lab_name/collected_on/received_on/reported_on/patient_name_on_report/lab_patient_ref/identity_status/file_sha256`; `facts.printed_flag/parse_checks`; `CREATE TYPE identity_status`.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 2 (identity/safety): structured header fields parsed by the
-- deterministic pipeline (header.ts), the patient-identity match result
-- (identity.ts), and a content hash for OCR reuse across re-uploads of the
-- same file. 'confirmed'/'rejected' are staff's resolution of a 'mismatch'
-- hold; LIVE_FACT_FILTER (services/delta.ts) excludes 'mismatch' and
-- 'rejected' from every snapshot/timeline/trend read. NULL means "not
-- assessed" (every document before this migration, and every non-blood
-- document today) -- never held.
CREATE TYPE identity_status AS ENUM ('matched', 'partial', 'mismatch', 'unknown', 'confirmed', 'rejected');

ALTER TABLE documents
  ADD COLUMN lab_name TEXT,
  ADD COLUMN collected_on DATE,
  ADD COLUMN received_on DATE,
  ADD COLUMN reported_on DATE,
  ADD COLUMN patient_name_on_report TEXT,
  ADD COLUMN lab_patient_ref TEXT,
  ADD COLUMN identity_status identity_status,
  ADD COLUMN file_sha256 TEXT;

-- OCR reuse lookup (routes/documents.ts runOcr): same patient, same file content.
CREATE INDEX documents_patient_file_sha256_idx ON documents (patient_id, file_sha256);

-- Per-row free-check diagnostics from validate.ts; NULL for a fact from an LLM pass.
ALTER TABLE facts
  ADD COLUMN printed_flag TEXT,
  ADD COLUMN parse_checks JSONB;
```

- [ ] **Step 2: Apply it to the local dev database**

Run: `docker compose -f infra/docker-compose.yml up -d` (starts Postgres if it isn't running; no-op if it already is), then:
Run: `psql "$DATABASE_URL" -f apps/api/src/db/migrations/009_document_identity_and_parse_metadata.sql`
Expected: `CREATE TYPE` / `ALTER TABLE` / `CREATE INDEX` / `ALTER TABLE` — no errors. (The local Postgres container's data volume already exists, so the new `docker-entrypoint-initdb.d` mount added in Step 3 only takes effect for a fresh volume; this direct `psql` apply is what makes it effective right now.)

- [ ] **Step 3: Mount it for fresh environments**

In `infra/docker-compose.yml`, add after the `008_imaging_modality.sql` mount line:

```yaml
      - ../apps/api/src/db/migrations/009_document_identity_and_parse_metadata.sql:/docker-entrypoint-initdb.d/10-document-identity-and-parse-metadata.sql:ro
```

- [ ] **Step 4: Verify the columns exist**

Run: `psql "$DATABASE_URL" -c "\d documents" | grep -E "identity_status|file_sha256|lab_name"`
Expected: three matching rows.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/migrations/009_document_identity_and_parse_metadata.sql infra/docker-compose.yml
git commit -m "db: add identity_status/header/file_sha256 to documents, printed_flag/parse_checks to facts"
```

---

### Task 5: Hold mismatched/rejected documents out of every snapshot read

**Files:**
- Modify: `apps/api/src/services/delta.ts`
- Modify: `apps/api/src/services/delta.test.ts`

**Interfaces:**
- Consumes: `documents.identity_status` (Task 4).
- Produces: `LIVE_FACT_FILTER` now also excludes a fact whose document is `mismatch` or `rejected`. No signature changes — every existing caller (`rules.ts`, `routes/visits.ts`, `routes/patients.ts`) picks this up automatically.

- [ ] **Step 1: Write the failing test**

Add to `delta.test.ts` (reuses the file's existing `newDocument`/`newFact` helpers; extend `newDocument` to take an optional identity status):

```ts
// Replace the existing newDocument with this version (adds the optional 4th parameter; every existing call site omits it and keeps getting NULL, i.e. "not assessed").
async function newDocument(visitId: string, identityStatus: string | null = null): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', ${identityStatus}::identity_status)
    RETURNING id`;
  return doc.id;
}

test("loadDeltaBaselines excludes a fact whose document is held for identity mismatch or was rejected, but keeps one that was confirmed", async () => {
  const [{ id: mHeld }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'Identity-Held', false, ${staff.id}) RETURNING id`;
  const [{ id: mRejected }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'Identity-Rejected', false, ${staff.id}) RETURNING id`;
  const [{ id: mConfirmed }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'Identity-Confirmed', false, ${staff.id}) RETURNING id`;

  async function newFactOnDoc(documentId: string, markerId: string): Promise<void> {
    await sql`
      INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date, coverage_status, verification_state, signed_off_by)
      VALUES (${patientId}, ${v1}, ${documentId}, ${markerId}, 'marker_value', '4.2', 'ng/mL', '2026-01-01', 'value_found', 'oncologist_signed_off', ${oncologist.id})`;
  }

  await newFactOnDoc(await newDocument(v1, "mismatch"), mHeld);
  await newFactOnDoc(await newDocument(v1, "rejected"), mRejected);
  await newFactOnDoc(await newDocument(v1, "confirmed"), mConfirmed);

  const baselines = await loadDeltaBaselines(patientId, "2026-03-01");
  expect(baselines.get(deltaKey("marker_value", mHeld))).toBeUndefined();
  expect(baselines.get(deltaKey("marker_value", mRejected))).toBeUndefined();
  expect(baselines.get(deltaKey("marker_value", mConfirmed))).toEqual({ value: "4.2", unit: "ng/mL" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/delta.test.ts`
Expected: FAIL — the `mismatch`/`rejected` baselines are currently included (`LIVE_FACT_FILTER` doesn't know about `identity_status` yet).

- [ ] **Step 3: Implement**

In `delta.ts`, replace `LIVE_FACT_FILTER`:

```ts
// Excludes a fact that lost an authoritative-pick conflict resolution (docs/03 §3),
// and a fact whose document is held for a patient-identity mismatch (or was
// rejected after review) -- docs/superpowers/specs/2026-10-10-deterministic-extraction-design.md
// "Identity match". NULL/'matched'/'partial'/'unknown'/'confirmed' are never held.
// Shared with every other fact-reading query, which aliases facts as `f` too.
export const LIVE_FACT_FILTER = sql`
  NOT EXISTS (
    SELECT 1 FROM conflicts c
    WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id)
      AND c.status = 'resolved' AND c.authoritative_fact_id IS NOT NULL AND c.authoritative_fact_id != f.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.id = f.document_id AND d.identity_status IN ('mismatch', 'rejected')
  )
`;
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/delta.test.ts apps/api/src/services/rules.test.ts apps/api/src/routes/patients.test.ts apps/api/src/routes/visits.test.ts`
Expected: all PASS (this confirms the shared-filter change doesn't regress any of its other callers).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/delta.ts apps/api/src/services/delta.test.ts
git commit -m "safety: exclude mismatch/rejected documents' facts from every snapshot read via LIVE_FACT_FILTER"
```

---

### Task 6: Persist header/identity metadata and per-fact parse checks

**Files:**
- Modify: `apps/api/src/services/facts.ts`
- Modify: `apps/api/src/services/facts.test.ts`

**Interfaces:**
- Consumes: `ExtractionResult["header"]` (the 6-field header shape in `@prelude/shared`, Task 3 — deliberately *not* `header.ts`'s full 9-field `HeaderFields`: `facts.ts` must not import from `apps/api`'s deterministic parser, only from the shared package its candidates already come from), `IdentityMatchStatus` (`identity.ts`), `ExtractedFactCandidate.printedFlag/parseChecks` (Task 3).
- Produces: `persistExtractedFacts` gains a 5th, optional `documentMetadata` parameter; writes `facts.printed_flag`/`facts.parse_checks` from each candidate.

- [ ] **Step 1: Write the failing tests**

```ts
import type { ExtractionResult } from "@prelude/shared";

type HeaderMetadata = NonNullable<ExtractionResult["header"]>;

test("persists printed_flag and parse_checks from the candidate", async () => {
  const result = await persistExtractedFacts(docContext(), [
    candidate({ printedFlag: "H", parseChecks: { valueParses: true, printedFlagAgrees: false } }),
  ], staff.id);
  const [fact] = await sql`SELECT printed_flag, parse_checks FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.printed_flag).toBe("H");
  expect(JSON.parse(fact.parse_checks)).toEqual({ valueParses: true, printedFlagAgrees: false });
});

test("a candidate with no printedFlag/parseChecks persists both as null", async () => {
  const result = await persistExtractedFacts(docContext(), [candidate()], staff.id);
  const [fact] = await sql`SELECT printed_flag, parse_checks FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.printed_flag).toBeNull();
  expect(fact.parse_checks).toBeNull();
});

test("documentMetadata writes header fields and identity_status onto the document, atomically with the facts", async () => {
  const header: HeaderMetadata = {
    labName: "Synthetic Labs", collectedOn: "2026-04-08", receivedOn: null, reportedOn: "2026-04-09",
    patientName: "Mr. TEST PERSON", labPatientRef: "LAB/1",
  };
  await persistExtractedFacts(docContext(), [candidate()], staff.id, { status: "done", error: null }, { header, identityStatus: "matched" });
  const [doc] = await sql`SELECT lab_name, to_char(collected_on, 'YYYY-MM-DD') AS collected_on, patient_name_on_report, lab_patient_ref, identity_status FROM documents WHERE id = ${documentId}`;
  expect(doc).toMatchObject({
    lab_name: "Synthetic Labs", collected_on: "2026-04-08", patient_name_on_report: "Mr. TEST PERSON",
    lab_patient_ref: "LAB/1", identity_status: "matched",
  });
});

test("documentMetadata is also applied when there are zero candidates", async () => {
  const header: HeaderMetadata = {
    labName: null, collectedOn: null, receivedOn: null, reportedOn: null,
    patientName: "Unmatched Name", labPatientRef: null,
  };
  await persistExtractedFacts(docContext(), [], staff.id, { status: "done", error: null }, { header, identityStatus: "mismatch" });
  const [doc] = await sql`SELECT identity_status, patient_name_on_report FROM documents WHERE id = ${documentId}`;
  expect(doc).toMatchObject({ identity_status: "mismatch", patient_name_on_report: "Unmatched Name" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/facts.test.ts`
Expected: FAIL — `printed_flag`/`parse_checks`/the 5th parameter don't exist yet.

- [ ] **Step 3: Implement**

In `facts.ts`, add the import and the helper, extend the signature, and apply the metadata clause in both UPDATE statements:

```ts
import type { ExtractionResult } from "@prelude/shared";
import type { IdentityMatchStatus } from "./extraction/deterministic/identity";

export interface DocumentMetadataUpdate {
  header: NonNullable<ExtractionResult["header"]>;
  identityStatus: IdentityMatchStatus;
}

function metadataSetClause(m: DocumentMetadataUpdate | null) {
  if (!m) return sql``;
  return sql`,
    lab_name = ${m.header.labName}, collected_on = ${m.header.collectedOn}, received_on = ${m.header.receivedOn},
    reported_on = ${m.header.reportedOn}, patient_name_on_report = ${m.header.patientName}, lab_patient_ref = ${m.header.labPatientRef},
    identity_status = ${m.identityStatus}::identity_status`;
}
```

Change the signature:

```ts
export async function persistExtractedFacts(
  document: DocumentContext,
  candidates: ExtractedFactCandidate[],
  actorId: string,
  extractionStatus: { status: "done" | "partial" | "failed"; error: string | null } = { status: "done", error: null },
  documentMetadata: DocumentMetadataUpdate | null = null,
): Promise<PersistExtractionResult> {
  if (candidates.length === 0) {
    await sql`
      UPDATE documents SET extraction_status = ${extractionStatus.status}, extraction_error = ${extractionStatus.error}
        ${metadataSetClause(documentMetadata)}
      WHERE id = ${document.id}
    `;
    return { createdFactIds: [], needsManualDate: false };
  }
  // ... unchanged down to the facts INSERT ...
```

**Order matters (safety).** Write the identity metadata at the *start* of the transaction, and do not run conflict detection for a held document. As first planned, the status was written last, so each fact's `detectConflicts` ran while the document still looked "not held": a wrong-patient document's facts would open conflicts against the real patient's live facts (visible in the conflicts UI, resolvable by staff). Immediately inside `return sql.begin(async (tx) => {`, before the tracked-marker lookup, add:

```ts
    if (documentMetadata) {
      await tx`
        UPDATE documents SET lab_name = ${documentMetadata.header.labName}, collected_on = ${documentMetadata.header.collectedOn},
          received_on = ${documentMetadata.header.receivedOn}, reported_on = ${documentMetadata.header.reportedOn},
          patient_name_on_report = ${documentMetadata.header.patientName}, lab_patient_ref = ${documentMetadata.header.labPatientRef},
          identity_status = ${documentMetadata.identityStatus}::identity_status
        WHERE id = ${document.id}`;
    }
```

and replace the existing `await detectConflicts(tx, fact);` in the loop with:

```ts
      // A document held for an identity mismatch must not open conflicts against the patient's real facts;
      // setDocumentIdentityStatus runs detection when staff confirm it (Task 9).
      if (documentMetadata?.identityStatus !== "mismatch") await detectConflicts(tx, fact);
```

(The `metadataSetClause` in the final status UPDATE and in the zero-candidates UPDATE can stay; re-writing the same values is harmless.) Add this test to `facts.test.ts` (uses the file's existing `newDocument()` helper; the `CEA` tracked marker is seeded by the file's first test):

```ts
test("a mismatch-held document's facts are persisted but never open a conflict", async () => {
  const doc = await newDocument();
  const header: HeaderMetadata = { labName: null, collectedOn: null, receivedOn: null, reportedOn: null, patientName: "Someone Else", labPatientRef: null };
  const result = await persistExtractedFacts(
    doc,
    [candidate({ asOfDate: "2026-05-01", value: "4.2" }), candidate({ asOfDate: "2026-05-01", value: "9.0" })],
    staff.id,
    { status: "done", error: null },
    { header, identityStatus: "mismatch" },
  );
  expect(result.createdFactIds).toHaveLength(2);
  const conflicts = await sql`SELECT id FROM conflicts WHERE fact_id_a IN ${sql(result.createdFactIds)} OR fact_id_b IN ${sql(result.createdFactIds)}`;
  expect(conflicts).toHaveLength(0);
  const facts = await sql`SELECT coverage_status FROM facts WHERE id IN ${sql(result.createdFactIds)}`;
  expect(facts.every((f: any) => f.coverage_status !== "conflicting_sources")).toBe(true);
});
```

In the per-candidate `INSERT INTO facts` (inside the `for` loop), add the two columns:

```ts
      const [fact] = await tx`
        INSERT INTO facts (
          patient_id, visit_id, document_id, tracked_marker_id, raw_marker_label,
          field_type, value, unit, reference_range, as_of_date, needs_manual_date,
          coverage_status, verification_state,
          source_page, source_location, source_snippet, printed_flag, parse_checks
        )
        VALUES (
          ${document.patient_id}, ${document.visit_id}, ${document.id}, ${trackedMarkerId}, ${rawMarkerLabel},
          ${candidate.fieldType}, ${candidate.value}, ${candidate.unit}, ${candidate.referenceRange}, ${candidate.asOfDate}, ${undated},
          ${coverageStatus}, 'unverified',
          ${candidate.sourcePage}, ${candidate.sourceLocation}, ${candidate.sourceSnippet},
          ${candidate.printedFlag ?? null}, ${candidate.parseChecks ? JSON.stringify(candidate.parseChecks) : null}
        )
        RETURNING *
      `;
```

And the end-of-transaction status UPDATE:

```ts
    await tx`
      UPDATE documents SET extraction_status = ${extractionStatus.status}, extraction_error = ${extractionStatus.error}
        ${metadataSetClause(documentMetadata)}
      WHERE id = ${document.id}
    `;
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/facts.test.ts && bunx tsc --noEmit 2>&1 | grep -E "services/facts"`
Expected: all PASS; no typecheck output.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/facts.ts apps/api/src/services/facts.test.ts
git commit -m "extraction: persist printed_flag/parse_checks per fact and header/identity metadata per document"
```

---

### Task 7: `EXTRACTION_MODE` feature flag

**Files:**
- Modify: `apps/api/src/services/providerFactory.ts`
- Create: `apps/api/src/services/providerFactory.test.ts`

**Interfaces:**
- Consumes: `DeterministicExtractionProvider` (phase 1, `./extraction/deterministic/provider`).
- Produces: `getExtractionProvider()` returns a `DeterministicExtractionProvider` when `EXTRACTION_MODE=deterministic`, else today's LLM provider (default, unset-safe).

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, afterEach } from "bun:test";

afterEach(() => {
  delete process.env.EXTRACTION_MODE;
  delete process.env.EXTRACTION_PROVIDER;
});

test("getExtractionProvider returns the deterministic provider when EXTRACTION_MODE=deterministic, without needing EXTRACTION_PROVIDER", async () => {
  process.env.EXTRACTION_MODE = "deterministic";
  delete process.env.EXTRACTION_PROVIDER;
  const { getExtractionProvider } = await import(`./providerFactory?det-${Date.now()}`);
  expect(getExtractionProvider().name).toBe("deterministic");
});

test("getExtractionProvider falls back to the LLM provider when EXTRACTION_MODE is unset (default, unchanged behaviour)", async () => {
  delete process.env.EXTRACTION_MODE;
  delete process.env.EXTRACTION_PROVIDER;
  const { getExtractionProvider } = await import(`./providerFactory?llm-${Date.now()}`);
  expect(() => getExtractionProvider()).toThrow(/EXTRACTION_PROVIDER is not set/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/providerFactory.test.ts`
Expected: FAIL on the first test — today's `getExtractionProvider()` ignores `EXTRACTION_MODE` and throws the "not set" error regardless.

- [ ] **Step 3: Implement**

In `providerFactory.ts`, add the import and a second cache slot, and change `getExtractionProvider`:

```ts
import { DeterministicExtractionProvider } from "./extraction/deterministic/provider";

let cachedDeterministicProvider: ExtractionProvider | undefined;

// The configured LLM provider regardless of EXTRACTION_MODE; the deterministic path falls back to it (Task 8).
export function getLlmExtractionProvider(): ExtractionProvider {
  if (!cachedExtractionProvider) {
    cachedExtractionProvider = buildExtractionProvider();
  }
  return cachedExtractionProvider;
}

export function getExtractionProvider(): ExtractionProvider {
  if (process.env.EXTRACTION_MODE === "deterministic") {
    if (!cachedDeterministicProvider) {
      cachedDeterministicProvider = new DeterministicExtractionProvider();
    }
    return cachedDeterministicProvider;
  }
  if (!cachedExtractionProvider) {
    cachedExtractionProvider = buildExtractionProvider();
  }
  return cachedExtractionProvider;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/providerFactory.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/providerFactory.ts apps/api/src/services/providerFactory.test.ts
git commit -m "extraction: add EXTRACTION_MODE=llm|deterministic flag (default llm, unchanged)"
```

---

### Task 8: Upload integration — `file_sha256`, OCR reuse, header/identity wiring

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

**Interfaces:**
- Consumes: `matchIdentity` (Task 1), `parseDocument`'s `header` via `ExtractionResult.header` (Task 3), `persistExtractedFacts`'s `documentMetadata` param (Task 6), `getExtractionProvider` (Task 7).
- Produces: `uploadDocument` computes and stores `file_sha256`; `runOcr` reuses a same-patient, same-hash document's OCR result instead of calling the OCR provider; `runExtraction` gains a required `patientName: string | null` parameter (threaded from `uploadDocument`) and, when the provider returns a `header`, computes identity and passes `documentMetadata` through to `persistExtractedFacts`.

- [ ] **Step 1: Write the failing tests**

```ts
test("uploadDocument stores a file_sha256 and two uploads of the same bytes for the same patient get the same hash", async () => {
  const bytes = "identical-content";
  const formA = new FormData();
  formA.set("visit_id", visitId);
  formA.set("document_type", "blood");
  formA.set("source_origin", "own_hospital");
  formA.set("file", new File([bytes], "a.pdf", { type: "application/pdf" }));
  const resA = await uploadDocument(uploadRequest(formA), asAuthedUser(staff));
  const docA = (await resA.json()) as any;
  expect(docA.file_sha256).toMatch(/^[0-9a-f]{64}$/);

  const formB = new FormData();
  formB.set("visit_id", visitId);
  formB.set("document_type", "blood");
  formB.set("source_origin", "own_hospital");
  formB.set("file", new File([bytes], "b.pdf", { type: "application/pdf" }));
  const resB = await uploadDocument(uploadRequest(formB), asAuthedUser(staff));
  const docB = (await resB.json()) as any;
  expect(docB.file_sha256).toBe(docA.file_sha256);
});

test("runOcr reuses a same-patient, same-hash document's OCR result instead of calling the OCR provider again", async () => {
  const sha = "a".repeat(64);
  const existing = await newDocumentRow({ file_sha256: sha, ocr_status: "done" });
  await sql`UPDATE documents SET ocr_text_ref = ${`local://${patientId}/ocr/${existing.id}.json`} WHERE id = ${existing.id}`;
  const { saveOcrResult } = await import("../services/storage");
  await saveOcrResult(patientId, existing.id, { fullText: "reused text", pages: [{ pageNumber: 1, text: "reused text" }], providerName: "test", providerRaw: null });

  const fresh = await newDocumentRow({ file_sha256: sha, ocr_status: "pending" });
  const savedProvider = process.env.OCR_PROVIDER;
  delete process.env.OCR_PROVIDER; // if reuse works, the (unconfigured) OCR provider is never called
  try {
    const { runOcrForTest } = await import("./documents");
    const updated = await runOcrForTest(fresh, new File(["anything"], "x.pdf", { type: "application/pdf" }), "blood", staff.id, null);
    expect(updated.ocr_status).toBe("done");
    const [{ ocr_text_ref }] = await sql`SELECT ocr_text_ref FROM documents WHERE id = ${updated.id}`;
    const { readOcrResult } = await import("../services/storage");
    expect((await readOcrResult(ocr_text_ref)).fullText).toBe("reused text");
  } finally {
    if (savedProvider !== undefined) process.env.OCR_PROVIDER = savedProvider;
  }
});

test("runExtraction computes identity_status against the patient's name and writes header fields onto the document", async () => {
  const doc = await newDocumentRow();
  const ocrWithHeader: typeof ocrResult = { ...ocrResult, fullText: ocrResult.fullText };
  const providerWithHeader: ExtractionProvider = {
    name: "fake-deterministic",
    extractFacts: async () => ({
      candidates: [datedCandidate()],
      failedFieldTypes: [],
      header: { labName: "Synthetic Labs", collectedOn: "2026-04-08", receivedOn: null, reportedOn: null, patientName: "Test Patient", labPatientRef: "L1" },
    }),
  };
  await runExtraction(doc, "blood", ocrWithHeader, staff.id, "Test Patient", providerWithHeader);
  const [row] = await sql`SELECT identity_status, lab_name FROM documents WHERE id = ${doc.id}`;
  expect(row).toMatchObject({ identity_status: "matched", lab_name: "Synthetic Labs" });
});

test("runExtraction holds a document (identity_status = 'mismatch') when the report's printed name doesn't match the patient", async () => {
  const doc = await newDocumentRow();
  const providerWithHeader: ExtractionProvider = {
    name: "fake-deterministic",
    extractFacts: async () => ({
      candidates: [],
      failedFieldTypes: [],
      header: { labName: null, collectedOn: null, receivedOn: null, reportedOn: null, patientName: "Someone Else Entirely", labPatientRef: null },
    }),
  };
  await runExtraction(doc, "blood", ocrResult, staff.id, "Test Patient", providerWithHeader);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${doc.id}`;
  expect(row.identity_status).toBe("mismatch");
});
```

Every pre-existing `runExtraction(...)` call in this file gains `null` as its 5th argument (patientName), before any provider argument. These are the exact 9 existing call sites and their replacements:

```ts
// "runExtraction marks the document 'done' and persists facts on success"
await runExtraction(doc, "blood", ocrResult, staff.id, providerReturning([datedCandidate()]));
```
→
```ts
await runExtraction(doc, "blood", ocrResult, staff.id, null, providerReturning([datedCandidate()]));
```

```ts
// "runExtraction marks the document 'done' when the pass legitimately finds nothing"
await runExtraction(doc, "blood", ocrResult, staff.id, providerReturning([]));
```
→
```ts
await runExtraction(doc, "blood", ocrResult, staff.id, null, providerReturning([]));
```

```ts
// "runExtraction marks the document 'partial' (not 'done') when a field type failed but others survived"
await runExtraction(
  doc,
  "blood",
  ocrResult,
  staff.id,
  providerReturning([datedCandidate()], ["reference_range"], { reference_range: "LLM timeout" }),
);
```
→
```ts
await runExtraction(
  doc,
  "blood",
  ocrResult,
  staff.id,
  null,
  providerReturning([datedCandidate()], ["reference_range"], { reference_range: "LLM timeout" }),
);
```

```ts
// "runExtraction marks the document 'failed' with an error when every field type failed and nothing survived"
await runExtraction(
  doc,
  "blood",
  ocrResult,
  staff.id,
  providerReturning([], ["marker_value", "reference_range"], { marker_value: "LLM API down" }),
);
```
→
```ts
await runExtraction(
  doc,
  "blood",
  ocrResult,
  staff.id,
  null,
  providerReturning([], ["marker_value", "reference_range"], { marker_value: "LLM API down" }),
);
```

```ts
// "runExtraction leaves extraction_error null on a clean 'done'"
await runExtraction(doc, "blood", ocrResult, staff.id, providerReturning([datedCandidate()]));
```
→
```ts
await runExtraction(doc, "blood", ocrResult, staff.id, null, providerReturning([datedCandidate()]));
```

```ts
// "runExtraction records the thrown error message when the provider throws"
await runExtraction(doc, "blood", ocrResult, staff.id, failing);
```
→
```ts
await runExtraction(doc, "blood", ocrResult, staff.id, null, failing);
```

```ts
// "runExtraction marks the document 'failed' when the extraction provider throws"
await runExtraction(doc, "blood", ocrResult, staff.id, failing);
```
→
```ts
await runExtraction(doc, "blood", ocrResult, staff.id, null, failing);
```

```ts
// "runExtraction marks the document 'failed', with no partial facts, when persistence fails"
await runExtraction(
  doc,
  "blood",
  ocrResult,
  staff.id,
  providerReturning([datedCandidate(), datedCandidate({ asOfDate: "2026-13-45" })]),
);
```
→
```ts
await runExtraction(
  doc,
  "blood",
  ocrResult,
  staff.id,
  null,
  providerReturning([datedCandidate(), datedCandidate({ asOfDate: "2026-13-45" })]),
);
```

```ts
// "runExtraction marks the document 'failed' when no extraction provider is configured"
await runExtraction(doc, "blood", ocrResult, staff.id);
```
→
```ts
await runExtraction(doc, "blood", ocrResult, staff.id, null);
```

Also change this file's import line from `import { uploadDocument, runExtraction } from "./documents";` to `import { uploadDocument, runExtraction, runOcrForTest } from "./documents";`.

The existing `newDocumentRow` helper (currently):

```ts
async function newDocumentRow(): Promise<{ id: string; patient_id: string; visit_id: string }> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://test/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done')
    RETURNING id, patient_id, visit_id
  `;
  return doc;
}
```

becomes:

```ts
async function newDocumentRow(
  overrides: Partial<{ file_sha256: string | null; ocr_status: string; identity_status: string }> = {},
): Promise<{ id: string; patient_id: string; visit_id: string }> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, file_sha256, identity_status)
    VALUES (
      ${patientId}, ${visitId}, 'local://test/x.pdf', 'blood', 'own_hospital', ${staff.id},
      ${overrides.ocr_status ?? "done"}, ${overrides.file_sha256 ?? null}, ${overrides.identity_status ?? null}::identity_status
    )
    RETURNING id, patient_id, visit_id
  `;
  return doc;
}
```

Every existing no-argument call site (`await newDocumentRow();`) is unaffected — the new parameter is optional and defaults to today's values.

Also add `getLlmExtractionProvider` to the existing `providerFactory` import in `documents.ts`, and this test (it injects nothing, so it exercises the real fallback branch; stub the two providers via `mock.module` as the file's other provider tests do):

```ts
test("EXTRACTION_MODE=deterministic: a rule-based pass with zero candidates falls back to the LLM provider instead of recording 'done, nothing found'", async () => {
  // deterministic provider returns { candidates: [], failedFieldTypes: [], stats: { rows: 0, unplacedNumericLines: 0, lines: 5 } };
  // the LLM stub returns one candidate. Expect the LLM stub to be called once and one fact persisted.
});
```

(Write the body against the file's existing provider-stub pattern; the assertion is: LLM stub called exactly once, `facts` count for the document is 1, `extraction_status` is `done`. With `EXTRACTION_MODE` unset the LLM provider is the only one called and behaviour is unchanged.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/routes/documents.test.ts`
Expected: FAIL — no `file_sha256` on the response, `runExtraction` signature mismatch, no `runOcrForTest` export.

- [ ] **Step 3: Implement**

In `documents.ts`, add imports:

```ts
import { matchIdentity } from "../services/extraction/deterministic/identity";
```

Change the patient lookup in `uploadDocument` to include `name`:

```ts
  const [patient] = await sql`SELECT id, name FROM patients WHERE id = ${patientId}`;
```

Compute the hash right after the file-type/size checks (before `saveDocumentFile`):

```ts
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const fileSha256 = new Bun.CryptoHasher("sha256").update(fileBuffer).digest("hex");
```

Add `file_sha256` to the INSERT:

```ts
      const [doc] = await tx`
        INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, imaging_modality, uploaded_by, ocr_status, file_sha256)
        VALUES (${patientId}, ${visitId}, ${file_ref}, ${documentType}, ${sourceOrigin}, ${documentType === "radiology" ? (imagingModality as string) : null}, ${user.id}, 'pending', ${fileSha256})
        RETURNING *
      `;
```

Thread `patient.name` through to `runOcr`:

```ts
  document = await runOcr(document, file, documentType as (typeof DOCUMENT_TYPES)[number], user.id, patient.name ?? null);
```

Change `runOcr` to accept `patientName`, reuse OCR by hash, and export a test-only alias:

```ts
async function runOcr(
  document: any,
  file: File,
  documentType: (typeof DOCUMENT_TYPES)[number],
  actorId: string,
  patientName: string | null,
): Promise<any> {
  try {
    let result: OcrResult;
    const [reusable] = document.file_sha256
      ? await sql`
          SELECT ocr_text_ref FROM documents
          WHERE patient_id = ${document.patient_id} AND file_sha256 = ${document.file_sha256}
            AND id != ${document.id} AND ocr_status = 'done' AND ocr_text_ref IS NOT NULL
          ORDER BY uploaded_at ASC LIMIT 1
        `
      : [];
    if (reusable) {
      result = await readOcrResult(reusable.ocr_text_ref);
    } else {
      const provider = getOcrProvider();
      const buffer = Buffer.from(await file.arrayBuffer());
      result = await provider.extractText(buffer, file.type);
    }
    const { file_ref: ocrTextRef } = await saveOcrResult(document.patient_id, document.id, result);

    const [updated] = await sql`
      UPDATE documents SET ocr_status = 'done', ocr_text_ref = ${ocrTextRef}
      WHERE id = ${document.id}
      RETURNING *
    `;

    await runExtraction(updated, documentType, result, actorId, patientName);

    const [final] = await sql`
      SELECT *
      FROM documents WHERE id = ${document.id}
    `;
    return final;
  } catch (err) {
    console.error(`OCR failed for document ${document.id}:`, err);
    const [updated] = await sql`
      UPDATE documents SET ocr_status = 'failed'
      WHERE id = ${document.id}
      RETURNING *
    `;
    return updated;
  }
}

// Test-only: documents.test.ts exercises OCR reuse directly, since uploadDocument's
// multipart path can't inject a pre-existing same-hash document deterministically.
export const runOcrForTest = runOcr;
```

Change `runExtraction` to accept and use `patientName`:

```ts
export async function runExtraction(
  document: any,
  documentType: (typeof DOCUMENT_TYPES)[number],
  ocr: OcrResult,
  actorId: string,
  patientName: string | null,
  provider?: ExtractionProvider,
): Promise<void> {
  try {
    let extraction = await (provider ?? getExtractionProvider()).extractFacts(ocr, documentType);
    // Safety: the rule-based parser needs column structure, and plain OCR text (every upload is OCR'd today) often has
    // none. A deterministic pass that found nothing (or a document type it does not handle) must never be recorded as
    // "done, nothing extractable" -- the silent empty result this design forbids. It falls back to the LLM provider
    // (tier T4 of the spec). Skipped when a provider is injected (tests) and when EXTRACTION_MODE is not deterministic.
    if (!provider && process.env.EXTRACTION_MODE === "deterministic" && extraction.candidates.length === 0) {
      extraction = await getLlmExtractionProvider().extractFacts(ocr, documentType);
    }
    const { candidates, failedFieldTypes, failureMessages, header } = extraction;
    const status =
      failedFieldTypes.length === 0 ? "done" : candidates.length > 0 ? "partial" : "failed";
    const error =
      status === "done"
        ? null
        : `Field type(s) failed: ${failedFieldTypes
            .map((f) => (failureMessages?.[f] ? `${f} (${failureMessages[f]})` : f))
            .join("; ")}`.slice(0, 1000);
    const documentMetadata = header ? { header, identityStatus: matchIdentity(patientName, header.patientName).status } : null;
    const result = await persistExtractedFacts(document, candidates, actorId, { status, error }, documentMetadata);
    console.log(
      `Document ${document.id}: extraction ${status}, persisted ${result.createdFactIds.length} fact(s)` +
        (result.needsManualDate ? " (some need a manual as_of_date)." : "."),
    );
  } catch (err) {
    console.error(`Extraction failed for document ${document.id}:`, err);
    try {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      await sql`UPDATE documents SET extraction_status = 'failed', extraction_error = ${message} WHERE id = ${document.id}`;
    } catch (statusErr) {
      console.error(`Could not record extraction_status='failed' for document ${document.id}:`, statusErr);
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/routes/documents.test.ts && bunx tsc --noEmit 2>&1 | grep -E "routes/documents"`
Expected: all PASS; no typecheck output.

- [ ] **Step 5: Smoke-check the default path is unchanged**

Run: `bun test apps/api/src/routes/documents.test.ts apps/api/src/services/facts.test.ts apps/api/src/routes/patients.test.ts`
Expected: all PASS — `EXTRACTION_MODE` is unset in these tests (deleted in `beforeAll` alongside `EXTRACTION_PROVIDER`), so every existing assertion about today's LLM-mode behaviour still holds.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/documents.ts apps/api/src/routes/documents.test.ts
git commit -m "extraction: file_sha256 + OCR reuse on upload; wire header/identity into runExtraction"
```

---

### Task 9: Confirm/reject a held document

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

**Interfaces:**
- Consumes: `detectConflicts` from `apps/api/src/services/rules.ts` (add `import { detectConflicts } from "../services/rules";` to `routes/documents.ts`).
- Produces: `setDocumentIdentityStatus(req, user)` — `POST /documents/:id/identity` with body `{ action: "confirm" | "reject" }`; transitions `identity_status` from `mismatch` to `confirmed`/`rejected`; writes an `audit_log` row (`action`: `confirm_identity`/`reject_identity`, `entity_type`: `document`).

- [ ] **Step 1: Write the failing tests**

```ts
test("setDocumentIdentityStatus 404s for an unknown document", async () => {
  const req = new Request("http://localhost/documents/x/identity", { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: "00000000-0000-0000-0000-000000000000" };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(404);
});

test("setDocumentIdentityStatus rejects an action other than confirm/reject", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "ignore" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("setDocumentIdentityStatus 409s when the document isn't currently held (identity_status != 'mismatch')", async () => {
  const doc = await newDocumentRow({ identity_status: "matched" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(409);
});

test("confirm moves a held document to 'confirmed' and logs an audit_log row", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(200);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${doc.id}`;
  expect(row.identity_status).toBe("confirmed");
  const [audit] = await sql`SELECT action FROM audit_log WHERE entity_type = 'document' AND entity_id = ${doc.id} AND action = 'confirm_identity'`;
  expect(audit).toBeTruthy();
});

test("reject moves a held document to 'rejected'", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "reject" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(200);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${doc.id}`;
  expect(row.identity_status).toBe("rejected");
});
```

Add `setDocumentIdentityStatus` to this file's `import { uploadDocument, runExtraction, runOcrForTest } from "./documents";` line.

Add this test (conflict detection on confirm); it builds the document and two disagreeing facts with raw SQL so it does not depend on other helpers:

```ts
test("confirming a held document detects conflicts for its now-live facts; the held persist created none", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const [d] = await sql`SELECT patient_id, visit_id FROM documents WHERE id = ${doc.id}`;
  const [marker] = await sql`INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${d.patient_id}, 'CEA', false, ${staff.id}) RETURNING id`;
  const [liveDoc] = await sql`INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status) VALUES (${d.patient_id}, ${d.visit_id}, 'local://t/live.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  const ins = (documentId: string, value: string) => sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date, coverage_status, verification_state)
    VALUES (${d.patient_id}, ${d.visit_id}, ${documentId}, ${marker.id}, 'marker_value', ${value}, 'ng/mL', '2026-05-01', 'value_found', 'unverified') RETURNING id`;
  const [live] = await ins(liveDoc.id, "4.2");
  const [held] = await ins(doc.id, "9.0");
  const before = await sql`SELECT id FROM conflicts WHERE fact_id_a IN (${live.id}, ${held.id}) OR fact_id_b IN (${live.id}, ${held.id})`;
  expect(before).toHaveLength(0);

  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  expect((await setDocumentIdentityStatus(req, asAuthedUser(staff))).status).toBe(200);
  const after = await sql`SELECT id FROM conflicts WHERE fact_id_a IN (${live.id}, ${held.id}) OR fact_id_b IN (${live.id}, ${held.id})`;
  expect(after.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/routes/documents.test.ts`
Expected: FAIL, `setDocumentIdentityStatus` is not exported.

- [ ] **Step 3: Implement**

Append to `documents.ts`:

```ts
const IDENTITY_ACTIONS = ["confirm", "reject"] as const;

// Resolves a document held for a patient-identity mismatch (identity.ts). Only a
// document currently 'mismatch' can be acted on -- matches conflicts.ts's
// "must be open" precedent. 'confirmed' lifts the LIVE_FACT_FILTER hold;
// 'rejected' keeps it held permanently (staff confirmed it's the wrong patient).
export async function setDocumentIdentityStatus(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const documentId = req.params.id;
  if (!isUuid(documentId)) return jsonError(404, "not_found", "Document not found.");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  const { action } = body;
  if (!(IDENTITY_ACTIONS as readonly string[]).includes(action as string)) {
    return jsonError(400, "bad_request", `action must be one of: ${IDENTITY_ACTIONS.join(", ")}.`);
  }
  const nextStatus = action === "confirm" ? "confirmed" : "rejected";

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM documents WHERE id = ${documentId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.identity_status !== "mismatch") return "not_held" as const;

    const [updated] = await tx`
      UPDATE documents SET identity_status = ${nextStatus}::identity_status WHERE id = ${documentId} RETURNING *
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, ${action === "confirm" ? "confirm_identity" : "reject_identity"}, 'document', ${documentId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;
    // Conflict detection was skipped while the document was held (Task 6); a confirmed document's facts are now live,
    // so detect conflicts for them now. A rejected document stays out of every read and never opens conflicts.
    if (action === "confirm") {
      const facts = await tx`SELECT * FROM facts WHERE document_id = ${documentId}`;
      for (const fact of facts) await detectConflicts(tx, fact as any);
    }
    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Document not found.");
  if (outcome === "not_held") return jsonError(409, "conflict", "Only a document held for identity mismatch can be confirmed or rejected.");

  const [document] = await sql`SELECT * FROM documents WHERE id = ${documentId}`;
  return Response.json(document);
}
```

In `index.ts`, add to the import and register the route:

```ts
import { uploadDocument, getDocument, getDocumentFile, setDocumentIdentityStatus } from "./routes/documents";
```

```ts
    "/documents/:id/identity": cors({
      POST: requireRole(["staff", "oncologist"], setDocumentIdentityStatus),
    }),
```

(placed next to the other `/documents/:id/...` routes, e.g. right after `/documents/:id/facts`).

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/routes/documents.test.ts && bunx tsc --noEmit 2>&1 | grep -E "routes/documents|src/index"`
Expected: all PASS; no typecheck output.

- [ ] **Step 5: Run the full phase-1 + phase-2 test suite and baseline**

Run: `bun test apps/api/src/services/extraction/deterministic apps/api/eval apps/api/src/services apps/api/src/routes && EVAL_PROVIDER=deterministic bun run eval:extraction`
Expected: all PASS; the three gate lines (`real recall >= 98%`, `value accuracy 100%`, `all-correct 100%`) still `PASS`, unchanged from phase 1.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/documents.ts apps/api/src/index.ts apps/api/src/routes/documents.test.ts
git commit -m "extraction: confirm/reject endpoint for a document held on patient-identity mismatch"
```
