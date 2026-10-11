# Deterministic Extraction, Phase 1 (Core Parser) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rule-based parser that turns a text-layer lab PDF into header fields and result rows with no OCR and no LLM, scored by the eval harness against the real reports.

**Architecture:** Pure functions over a `Line { page, raw, cells[] }` model. Lines come from `pdfjs-dist` word positions (real PDFs) or from splitting plain text on 2+ spaces (harness fixtures). `parseHeader` and `parseRows` run over lines; `DeterministicExtractionProvider` adapts the result to the existing `ExtractionProvider` interface so the harness can score it. Production upload is **not** touched in this phase (no `EXTRACTION_MODE` yet).

**Tech Stack:** Bun, TypeScript, `pdfjs-dist@4.10.38`, `pdf-lib` (tests only), existing eval harness (`apps/api/eval`).

**Spec:** `docs/superpowers/specs/2026-10-10-deterministic-extraction-design.md` (phase 1 of 4).

## Global Constraints

- Use Bun (`bun test`, `bun add`, `bun run`); no Node/jest/dotenv. Run commands from the repo root `/home/dev-var/Documents/Projects/OPD`.
- New code lives in `apps/api/src/services/extraction/deterministic/`. Tests use **synthetic text only**; never put real patient values in committed files. Real fixtures/keys stay gitignored (`apps/api/eval/fixtures/`, `docs/reports/`).
- Do not change production behaviour: no edits to `routes/documents.ts`, `services/facts.ts`, or the existing LLM providers.
- A wrong value is worse than a missing one: lines that look numeric but are not parsed must be counted as `unplaced_numeric`, never dropped silently.
- Phase 1 handles `blood` documents only. Radiology and prescription documents return `failedFieldTypes` (not handled) so they can never look like "nothing extractable".
- Known limit, by design: plain OCR text (Azure `prebuilt-read`) has no column structure; scans are phase 3 (Azure layout tables). Phase 1 targets text-layer PDFs.
- Gate for this phase (real, hand-keyed blood documents): recall ≥ 98%, value accuracy 100% and all-correct 100% on matched facts. If not met, report the residual misses; do not loosen the gate.

## Review Focus

- Letter-spaced text and wrapped labels (`S ample C oll. D ate`, `RDW-` + `CV)`) must still parse. (Tasks 3, 4, 5)
- Narrative and reference tables after `Comment`/`Notes`/`REFERENCE RANGES` must never become rows. (Task 5)
- Two-digit years and day-first dates (`08-May-26`, `20.07.2026`) must parse; impossible dates return null. (Task 4)
- A numeric line the parser cannot place must be counted, not lost. (Task 5)
- A page with no or little text layer must report `hasTextLayer: false` rather than parse as an empty document. (Task 3)

---

### Task 1: Promote alias and unit tables into `src`

**Files:**
- Move: `apps/api/eval/aliases.ts` → `apps/api/src/services/extraction/deterministic/aliases.ts` (use `git mv`)
- Create: `apps/api/src/services/extraction/deterministic/units.ts`
- Modify: `apps/api/eval/score.ts` (imports; remove local unit table)
- Test: `apps/api/src/services/extraction/deterministic/aliases.test.ts`

**Interfaces:**
- Produces: `squash(s): string`, `aliasKeys(label, extra?): Set<string>` (aliases.ts); `normUnit(u): string`, `unitsEquivalent(a, b): boolean` (units.ts).
- Consumes: `MARKER_REGISTRY` from `@prelude/shared`.

- [ ] **Step 1: Write the failing test** (`aliases.test.ts`)

```ts
import { test, expect } from "bun:test";
import { aliasKeys, squash } from "./aliases";
import { unitsEquivalent } from "./units";

test("registry aliases join the shared table", () => {
  expect(aliasKeys("Carcinoembryonic Antigen").has(squash("CEA"))).toBe(true);
  expect(aliasKeys("PSA").has(squash("Total PSA"))).toBe(true);
});

test("triglycerides and thyroglobulin are never conflated", () => {
  expect(aliasKeys("Triglycerides").has("thyroglobulin")).toBe(false);
  expect(aliasKeys("Tg").has("triglycerides")).toBe(false);
  expect(aliasKeys("Tg").has("thyroglobulin")).toBe(true);
});

test("free and total thyroid tests stay separate", () => {
  expect(aliasKeys("T3 Total").has(squash("Free T3"))).toBe(false);
  expect(aliasKeys("FT4").has(squash("T4 Total"))).toBe(false);
});

test("unitsEquivalent covers micro sign, case and count spellings", () => {
  expect(unitsEquivalent("µIU/mL", "uIU/ml")).toBe(true);
  expect(unitsEquivalent("10^3/µL", "10^9/L")).toBe(true);
  expect(unitsEquivalent("ng/mL", "pg/mL")).toBe(false);
  expect(unitsEquivalent(null, null)).toBe(true);
  expect(unitsEquivalent(null, "g/dL")).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/aliases.test.ts`
Expected: FAIL, cannot find module `./aliases`.

- [ ] **Step 3: Move and edit**

```bash
mkdir -p apps/api/src/services/extraction/deterministic
git mv apps/api/eval/aliases.ts apps/api/src/services/extraction/deterministic/aliases.ts
```

In `aliases.ts`: (a) delete `"TG"` from the triglycerides group (`["TRIGLYCERIDES", "Triglyceride"]`), because `TG` collides with the registry alias `Tg` (thyroglobulin); (b) add `import { MARKER_REGISTRY } from "@prelude/shared";` at the top; (c) replace the `SQUASHED` line with:

```ts
const SQUASHED = [...GROUPS, ...MARKER_REGISTRY.map((m) => [m.canonical, ...m.aliases])].map((g) => new Set(g.map(squash)));
```

Create `units.ts`:

```ts
const compact = (s: string) => s.toLowerCase().replace(/\s+/g, "");

// Equivalent spellings of the same unit, after lowercasing, removing whitespace and mapping µ/μ -> u.
const UNIT_EQUIV: Record<string, string> = {
  "thou/ul": "10^3/ul", "k/ul": "10^3/ul", "x10^3/ul": "10^3/ul", "x10³/ul": "10^3/ul", "10³/ul": "10^3/ul", "10^9/l": "10^3/ul",
  "millions/mm³": "10^6/ul", "millions/mm3": "10^6/ul", "mill/mm3": "10^6/ul", "m/ul": "10^6/ul", "x10^6/ul": "10^6/ul",
};

export function normUnit(u: string): string {
  const c = compact(u).replace(/[µμ]/g, "u");
  return UNIT_EQUIV[c] ?? c;
}

export function unitsEquivalent(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normUnit(a) === normUnit(b);
}
```

In `apps/api/eval/score.ts`: change the aliases import to `import { aliasKeys, squash } from "../src/services/extraction/deterministic/aliases";`, add `import { unitsEquivalent } from "../src/services/extraction/deterministic/units";`, delete the `UNIT_EQUIV` constant and `normUnit` function, and replace the `unitsEqual` function with `export const unitsEqual = unitsEquivalent;` (keep the local `compact`, still used by `rangesEqual`).

- [ ] **Step 4: Run all tests**

Run: `bun test apps/api/src/services/extraction/deterministic apps/api/eval`
Expected: all PASS (the previous 32 eval tests plus the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/extraction/deterministic apps/api/eval/score.ts apps/api/eval/aliases.ts
git commit -m "extraction: promote alias and unit tables into src, merge marker registry"
```

---

### Task 2: Line model and text splitting

**Files:**
- Create: `apps/api/src/services/extraction/deterministic/types.ts`
- Create: `apps/api/src/services/extraction/deterministic/lines.ts`
- Test: `apps/api/src/services/extraction/deterministic/lines.test.ts`

**Interfaces:**
- Produces: `Cell { text; x0?; x1? }`, `Line { page; raw; cells }` (types.ts); `CELL_SEPARATOR`, `splitCells(raw)`, `linesFromText(pageText, page)`, `renderLines(lines)` (lines.ts).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/lines.test.ts`
Expected: FAIL, cannot find module `./lines`.

- [ ] **Step 3: Write the implementation**

`types.ts`:

```ts
export interface Cell {
  text: string;
  // Present only for geometry-derived cells (PDF text layer).
  x0?: number;
  x1?: number;
}

export interface Line {
  page: number;
  // The line exactly as it appears in the stored page text (cells joined by CELL_SEPARATOR); used as the verbatim snippet.
  raw: string;
  cells: Cell[];
}
```

`lines.ts`:

```ts
import type { Cell, Line } from "./types";

export const CELL_SEPARATOR = "   ";

export function splitCells(raw: string): Cell[] {
  return raw.trim().split(/\s{2,}/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
}

export function linesFromText(pageText: string, page: number): Line[] {
  const out: Line[] = [];
  for (const rawLine of pageText.split("\n")) {
    const raw = rawLine.trim();
    if (!raw) continue;
    out.push({ page, raw, cells: splitCells(raw) });
  }
  return out;
}

export function renderLines(lines: Line[]): string {
  return lines.map((l) => l.cells.map((c) => c.text).join(CELL_SEPARATOR)).join("\n");
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic/lines.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/extraction/deterministic/types.ts apps/api/src/services/extraction/deterministic/lines.ts apps/api/src/services/extraction/deterministic/lines.test.ts
git commit -m "extraction: line/cell model and text splitting"
```

---

### Task 3: Text-layer extraction with `pdfjs-dist`

**Files:**
- Modify: `apps/api/package.json` (dependency)
- Create: `apps/api/src/services/extraction/deterministic/textLayer.ts`
- Test: `apps/api/src/services/extraction/deterministic/textLayer.test.ts`

**Interfaces:**
- Consumes: `Line`, `Cell` (Task 2), `CELL_SEPARATOR`.
- Produces: `TEXT_LAYER_MIN_CHARS`, `TextLayerPage { pageNumber; lines; charCount; hasTextLayer }`, `groupItemsIntoLines(items, page)`, `extractTextLayer(data: Uint8Array): Promise<TextLayerPage[]>`.

Background (from the 2026-10-10 spike): `pdfjs-dist/legacy/build/pdf.mjs` runs under Bun and is fast. Some PDFs store text one character per item (letter-spaced), and some range cells sit 2-3 points off the row baseline, so grouping must cluster by baseline tolerance and merge characters by horizontal gap.

- [ ] **Step 1: Add the dependency**

Run: `cd apps/api && bun add pdfjs-dist@4.10.38 && cd ../..`
Expected: `pdfjs-dist` added to `apps/api/package.json`.

- [ ] **Step 2: Write the failing tests** (synthetic PDFs via `pdf-lib`)

```ts
import { test, expect } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractTextLayer, groupItemsIntoLines } from "./textLayer";

async function makePdf(draw: (page: import("pdf-lib").PDFPage, font: import("pdf-lib").PDFFont) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  draw(doc.addPage([595, 842]), font);
  return await doc.save();
}

test("columns become cells and a slightly offset cell stays on its row", async () => {
  const pdf = await makePdf((p, f) => {
    const t = (text: string, x: number, y: number) => p.drawText(text, { x, y, size: 9, font: f });
    t("Haemoglobin", 40, 700); t("10.1", 300, 700); t("g/dL", 380, 700); t("13.0-17.0", 460, 700);
    t("Total Leukocyte Count", 40, 680); t("7.4", 300, 680); t("10^3/uL", 380, 680); t("4.0-10.0", 460, 682.5);
  });
  const [page] = await extractTextLayer(pdf);
  const rows = page!.lines.map((l) => l.cells.map((c) => c.text));
  expect(rows).toEqual([
    ["Haemoglobin", "10.1", "g/dL", "13.0-17.0"],
    ["Total Leukocyte Count", "7.4", "10^3/uL", "4.0-10.0"],
  ]);
});

test("per-character (letter-spaced) text merges into words", async () => {
  const pdf = await makePdf((p, f) => {
    let x = 40;
    for (const ch of "Sample Collected") {
      const w = f.widthOfTextAtSize(ch, 9);
      if (ch !== " ") p.drawText(ch, { x, y: 700, size: 9, font: f });
      x += ch === " " ? 3.5 : w + 1.0;
    }
    p.drawText("12/Dec/2024", { x: 300, y: 700, size: 9, font: f });
  });
  const [page] = await extractTextLayer(pdf);
  expect(page!.lines).toHaveLength(1);
  expect(page!.lines[0]!.cells.map((c) => c.text)).toEqual(["Sample Collected", "12/Dec/2024"]);
});

test("a page with no text reports no text layer; a short page is also below the threshold", async () => {
  const blank = await makePdf(() => {});
  const short = await makePdf((p, f) => p.drawText("Hb 10.1", { x: 40, y: 700, size: 9, font: f }));
  const [b] = await extractTextLayer(blank);
  const [s] = await extractTextLayer(short);
  expect(b).toMatchObject({ charCount: 0, hasTextLayer: false, lines: [] });
  expect(s!.charCount).toBeGreaterThan(0);
  expect(s!.hasTextLayer).toBe(false);
});

test("groupItemsIntoLines orders rows top to bottom and cells left to right", () => {
  const lines = groupItemsIntoLines(
    [
      { str: "b", x: 200, y: 100, w: 5, h: 9 },
      { str: "a", x: 20, y: 100, w: 5, h: 9 },
      { str: "top", x: 20, y: 300, w: 15, h: 9 },
    ],
    2,
  );
  expect(lines.map((l) => l.cells.map((c) => c.text))).toEqual([["top"], ["a", "b"]]);
  expect(lines[0]!.page).toBe(2);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/textLayer.test.ts`
Expected: FAIL, cannot find module `./textLayer`.

- [ ] **Step 4: Write the implementation**

```ts
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Cell, Line } from "./types";
import { CELL_SEPARATOR } from "./lines";

// A page counts as "text layer" at or above this many extracted characters; below it the page goes to OCR.
export const TEXT_LAYER_MIN_CHARS = Number(process.env.TEXT_LAYER_MIN_CHARS ?? 200);

// Gaps are relative to the item height h: within a word, same cell with a space, new cell (column).
const JOIN_GAP = 0.25;
const COL_GAP = 2.2;

export interface TextLayerPage {
  pageNumber: number;
  lines: Line[];
  charCount: number;
  hasTextLayer: boolean;
}

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function toLine(row: PdfTextItem[], page: number): Line {
  const cells: Cell[] = [];
  let cur: Cell | null = null;
  let prevEnd = 0;
  for (const it of row) {
    const h = it.h || 9;
    const gap = it.x - prevEnd;
    if (cur && gap <= COL_GAP * h) {
      const needsSpace = gap > JOIN_GAP * h && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
      cur.text += (needsSpace ? " " : "") + it.str;
      cur.x1 = it.x + it.w;
    } else {
      cur = { text: it.str, x0: it.x, x1: it.x + it.w };
      cells.push(cur);
    }
    prevEnd = it.x + it.w;
  }
  for (const c of cells) c.text = c.text.replace(/\s+/g, " ").trim();
  const kept = cells.filter((c) => c.text);
  return { page, raw: kept.map((c) => c.text).join(CELL_SEPARATOR), cells: kept };
}

// Items within ~half a line height of each other's baseline are the same row.
export function groupItemsIntoLines(items: PdfTextItem[], page: number): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfTextItem[][] = [];
  let refY = 0;
  let tol = 0;
  for (const it of sorted) {
    const cur = rows[rows.length - 1];
    if (cur && Math.abs(it.y - refY) <= tol) {
      cur.push(it);
    } else {
      rows.push([it]);
      refY = it.y;
      tol = Math.max(2, 0.45 * (it.h || 9));
    }
  }
  return rows.map((row) => toLine(row.sort((a, b) => a.x - b.x), page)).filter((l) => l.cells.length > 0);
}

export async function extractTextLayer(data: Uint8Array): Promise<TextLayerPage[]> {
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: TextLayerPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items as { str?: string; transform: number[]; width: number; height: number }[]) {
        if (typeof raw.str !== "string" || !raw.str.trim()) continue;
        items.push({ str: raw.str, x: raw.transform[4]!, y: raw.transform[5]!, w: raw.width, h: raw.height || Math.abs(raw.transform[3]!) || 9 });
      }
      const lines = groupItemsIntoLines(items, n);
      const charCount = lines.reduce((sum, l) => sum + l.raw.length, 0);
      pages.push({ pageNumber: n, lines, charCount, hasTextLayer: charCount >= TEXT_LAYER_MIN_CHARS });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic/textLayer.test.ts`
Expected: 4 PASS. If a geometry test fails, print the extracted items (`console.log(items)`) and adjust `JOIN_GAP` / `COL_GAP` / the tolerance constant, keeping all four tests green.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit 2>&1 | grep -E "deterministic|apps/api/eval"`
Expected: no output. If TypeScript cannot find types for `pdfjs-dist/legacy/build/pdf.mjs`, add `apps/api/src/services/extraction/deterministic/pdfjs.d.ts` containing `declare module "pdfjs-dist/legacy/build/pdf.mjs";` and re-run.

- [ ] **Step 7: Smoke-check against the real PDFs** (read-only; prints only counts)

Run: `bun -e 'import {extractTextLayer} from "./apps/api/src/services/extraction/deterministic/textLayer"; import {readdirSync} from "node:fs"; for (const f of readdirSync("docs/reports").filter(f=>f.endsWith(".pdf"))) { const p = await extractTextLayer(new Uint8Array(await Bun.file("docs/reports/"+f).arrayBuffer())); console.log(f.slice(0,24).padEnd(26), p.length, "pages", p.filter(x=>x.hasTextLayer).length, "with text layer", p.reduce((n,x)=>n+x.lines.length,0), "lines") }'`
Expected: every PDF lists all pages with a text layer except any page genuinely short of text.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json bun.lock apps/api/src/services/extraction/deterministic
git commit -m "extraction: text-layer extraction with pdfjs-dist (baseline clustering, letter-spaced merge)"
```

---

### Task 4: Header parser

**Files:**
- Create: `apps/api/src/services/extraction/deterministic/header.ts`
- Test: `apps/api/src/services/extraction/deterministic/header.test.ts`

**Interfaces:**
- Consumes: `Line` (Task 2), `squash` (Task 1).
- Produces: `HeaderFields { labName; collectedOn; receivedOn; reportedOn; patientName; labPatientRef; age; sex; referringDoctor }` (all `string | null`), `parseDate(s): string | null` (ISO), `parseHeader(lines: Line[]): HeaderFields`.

- [ ] **Step 1: Write the failing tests** (synthetic text)

```ts
import { test, expect } from "bun:test";
import { linesFromText } from "./lines";
import { parseDate, parseHeader } from "./header";

const header = (text: string) => parseHeader(linesFromText(text, 1));

test("parseDate handles the formats seen on real labs and rejects impossible dates", () => {
  expect(parseDate("29/Apr/2026 10:00 AM")).toBe("2026-04-29");
  expect(parseDate("08-May-26 15:54")).toBe("2026-05-08");
  expect(parseDate("20.07.2026")).toBe("2026-07-20");
  expect(parseDate("20-07-2026 01:03:PM")).toBe("2026-07-20");
  expect(parseDate("12/D ec/202410:01PM")).toBe("2024-12-12");
  expect(parseDate("2026-03-14")).toBe("2026-03-14");
  expect(parseDate("31/13/2026")).toBeNull();
  expect(parseDate("nonsense")).toBeNull();
});

test("key : value pairs across cells", () => {
  const h = header(
    [
      "SYNTHETIC DIAGNOSTIC LABS",
      "Patient Name : Mr. TEST PERSON      PateintID : LAB/123",
      "Age/Gender : 28 Y/Male      Collected On : 08/Apr/2026 10:00 AM",
      "Refered By : Dr. SELF      Reported Date : 09/Apr/2026 05:29 AM",
    ].join("\n"),
  );
  expect(h).toMatchObject({
    labName: "SYNTHETIC DIAGNOSTIC LABS", patientName: "Mr. TEST PERSON", labPatientRef: "LAB/123",
    age: "28", sex: "M", collectedOn: "2026-04-08", reportedOn: "2026-04-09", referringDoctor: "Dr. SELF",
  });
});

test("a colon in its own cell and a label ending in a colon both bind to the value", () => {
  const h = header("Reported Date      : 30/Apr/2026 07:58 AM\nNAME:      TEST PERSON      AGE/SEX:      58 YRS /M\nDATE:      20.07.2026");
  expect(h).toMatchObject({ reportedOn: "2026-04-30", patientName: "TEST PERSON", age: "58", sex: "M", collectedOn: "2026-07-20" });
});

test("letter-spaced label and value still parse", () => {
  const h = header("S ample C oll. D ate:      12/D ec/202410:01PM");
  expect(h.collectedOn).toBe("2024-12-12");
});

test("a specific collection key beats a generic Date", () => {
  const h = header("Date : 01/01/2020      Collection Date : 05/03/2026");
  expect(h.collectedOn).toBe("2026-03-05");
});

test("age/sex variants: M/58 Y, and the last standalone sex token wins", () => {
  expect(header("Age/Gender : M/58 Y")).toMatchObject({ age: "58", sex: "M" });
  expect(header("Age/Gender : 28 Y 0 M 0 D /F")).toMatchObject({ age: "28", sex: "F" });
});

test("a report title is not taken as the lab name", () => {
  expect(header("Laboratory Investigation Report\nPatient Name : X Y").labName).toBeNull();
});

test("missing fields are null", () => {
  expect(header("nothing useful here")).toEqual({
    labName: null, collectedOn: null, receivedOn: null, reportedOn: null, patientName: null,
    labPatientRef: null, age: null, sex: null, referringDoctor: null,
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/header.test.ts`
Expected: FAIL, cannot find module `./header`.

- [ ] **Step 3: Write the implementation**

```ts
import { squash } from "./aliases";
import type { Line } from "./types";

export interface HeaderFields {
  labName: string | null;
  collectedOn: string | null;
  receivedOn: string | null;
  reportedOn: string | null;
  patientName: string | null;
  labPatientRef: string | null;
  age: string | null;
  sex: string | null;
  referringDoctor: string | null;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: string, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Day-first (Indian labs). Spaces inside the value are removed first because some PDFs are letter-spaced ("12/D ec/2024").
export function parseDate(input: string): string | null {
  const c = input.replace(/\s+/g, "");
  let m = c.match(/(\d{1,2})[\/\-]([A-Za-z]{3})[A-Za-z]*[\/\-]((?:19|20)\d{2})/);
  if (m && MON[m[2]!.toLowerCase()]) return iso(m[3]!, MON[m[2]!.toLowerCase()]!, Number(m[1]));
  m = c.match(/((?:19|20)\d{2})-(\d{2})-(\d{2})/);
  if (m) return iso(m[1]!, Number(m[2]), Number(m[3]));
  m = c.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:19|20)\d{2})/);
  if (m) return iso(m[3]!, Number(m[2]), Number(m[1]));
  m = input.match(/(\d{1,2})[\/\- ]([A-Za-z]{3})[\/\- ](\d{2})(?!\d)/);
  if (m && MON[m[2]!.toLowerCase()]) return iso(`20${m[3]}`, MON[m[2]!.toLowerCase()]!, Number(m[1]));
  return null;
}

const COLLECTED_KEYS = ["collectedon", "collectiondate", "collectiondatetime", "samplecolldate", "samplecollecteddate", "sampledrawn", "sampledatetime", "sampledate", "collecteddate"];
const RECEIVED_KEYS = ["receivedon", "receivingon", "samplereceived"];
const REPORTED_KEYS = ["reporteddate", "reportedon", "reportdatetime", "reportingdatetime", "reportdate"];
const NAME_KEYS = ["patientname", "customername", "name"];
const REF_KEYS = ["patientid", "pateintid", "patientregno", "maxidlabid", "uhid", "barcodeno"];
const AGE_KEYS = ["agegender", "agesex", "age"];
const DOCTOR_KEYS = ["referredby", "referedby", "refby", "refdoctor", "referdoctor", "doctorname"];
const LAB_PAIR_KEYS = ["testingdoneby", "testperformedat"];

interface Pair {
  key: string;
  value: string;
}

function pairsOf(line: Line): Pair[] {
  const merged: string[] = [];
  for (const c of line.cells) {
    if (c.text.startsWith(":") && merged.length > 0) merged[merged.length - 1] += ` ${c.text}`;
    else merged.push(c.text);
  }
  const out: Pair[] = [];
  for (let i = 0; i < merged.length; i++) {
    const cell = merged[i]!;
    const at = cell.indexOf(":");
    if (at <= 0 || at > 40) continue;
    let value = cell.slice(at + 1).trim();
    if (!value && i + 1 < merged.length) value = merged[++i]!.replace(/^:\s*/, "").trim();
    out.push({ key: squash(cell.slice(0, at)), value });
  }
  return out;
}

function sexAndAge(value: string): { age: string | null; sex: string | null } {
  const age = value.match(/(\d{1,3})/)?.[1] ?? null;
  const words = [...value.matchAll(/\b(male|female)\b/gi)];
  if (words.length > 0) return { age, sex: words[words.length - 1]![1]![0]!.toUpperCase() };
  const letters = [...value.matchAll(/\b([MF])\b/gi)];
  return { age, sex: letters.length > 0 ? letters[letters.length - 1]![1]!.toUpperCase() : null };
}

const LAB_WORDS = /(laborator|diagnos|patholog|hospital|healthcare|clinic|\blabs?\b)/i;
const TITLE_WORDS = /\b(report|investigation)\b/i;

function findLabName(lines: Line[], pairs: Pair[]): string | null {
  for (const line of lines.slice(0, 12)) {
    const text = line.cells.map((c) => c.text).join(" ");
    if (LAB_WORDS.test(text) && !text.includes(":") && !TITLE_WORDS.test(text) && text.length <= 80) {
      return text.replace(/^testing done by\s+/i, "").trim();
    }
  }
  const fromPair = pairs.find((p) => LAB_PAIR_KEYS.includes(p.key) && p.value);
  return fromPair ? fromPair.value : null;
}

export function parseHeader(lines: Line[]): HeaderFields {
  const pairs = lines.flatMap(pairsOf);
  const first = (keys: string[]): string | null => pairs.find((p) => keys.includes(p.key) && p.value)?.value ?? null;
  const dateOf = (keys: string[]): string | null => {
    for (const p of pairs) if (keys.includes(p.key)) { const d = parseDate(p.value); if (d) return d; }
    return null;
  };
  const ageGender = first(AGE_KEYS);
  const { age, sex } = ageGender ? sexAndAge(ageGender) : { age: null, sex: null };
  return {
    labName: findLabName(lines, pairs),
    collectedOn: dateOf(COLLECTED_KEYS) ?? dateOf(["date"]),
    receivedOn: dateOf(RECEIVED_KEYS),
    reportedOn: dateOf(REPORTED_KEYS),
    patientName: first(NAME_KEYS),
    labPatientRef: first(REF_KEYS),
    age,
    sex,
    referringDoctor: first(DOCTOR_KEYS),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic/header.test.ts`
Expected: all PASS. If "patientName" picks a wrong cell for a case, fix the key list or pairing, never the test data.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/extraction/deterministic/header.ts apps/api/src/services/extraction/deterministic/header.test.ts
git commit -m "extraction: header parser (lab, dates, patient, ids) with robust date parsing"
```

---

### Task 5: Row parser and line accounting

**Files:**
- Create: `apps/api/src/services/extraction/deterministic/rows.ts`
- Test: `apps/api/src/services/extraction/deterministic/rows.test.ts`

**Interfaces:**
- Consumes: `Line` (Task 2).
- Produces: `RowShape`, `ParsedRow { label; value; unit; range; flag; section; page; lineIndex; snippet; shape }`, `LineClass`, `ParseRowsResult { rows; classes; unplacedNumeric }`, `parseRows(lines: Line[]): ParseRowsResult`.

- [ ] **Step 1: Write the failing tests** (synthetic text)

```ts
import { test, expect } from "bun:test";
import { linesFromText } from "./lines";
import { parseRows } from "./rows";

const parse = (text: string) => parseRows(linesFromText(text, 1));
const find = (r: ReturnType<typeof parse>, label: string) => r.rows.find((x) => x.label.toLowerCase().startsWith(label.toLowerCase()));

const SAMPLE = [
  "Test Name   Result   Unit   Bio. Ref. Interval",
  "COMPLETE BLOOD COUNT (CBC)",
  "HAEMOGLOBIN (Hb)      10.1      g/dL      13.0-17.0",
  "Colorimetric method",
  "PACKED CELL VOLUME (PCV) -      31.6      %      40.0-50.0",
  "HEMATOCRIT",
  "RED CELL DISTRIBUTION WIDTH (RDW-      15.1      %      11.6-14.0",
  "CV)",
  "MENTZER INDEX      24.02",
  "DIFFERENTIAL LEUCOCYTE COUNT",
  "Neutrophils      68.8      %      40 - 80      H",
  "Neutrophils - 74%",
  "URINE",
  "PUS CELLS      3-4      /hpf      0-1/hpf",
  "COLOUR      YELLOW      PALE YELLOW",
  "Bleeding Time      2 Minute 30 Second      2-7",
  "Free Triiodothyronine (FT3) 2.68      pg/mL      2.6 - 4.2",
  "Weird Test      4.5 gm      note",
  "Comment",
  "Parameter      Unit      (28 - 36 weeks)",
  "FT3      Pg/mL      0.15 - 3.91",
  "Page 1 of 2",
].join("\n");

test("rows, units, ranges, flags and sections", () => {
  const r = parse(SAMPLE);
  expect(find(r, "HAEMOGLOBIN")).toMatchObject({ value: "10.1", unit: "g/dL", range: "13.0-17.0", shape: "full", section: "COMPLETE BLOOD COUNT (CBC)" });
  expect(find(r, "Neutrophils")).toMatchObject({ value: "68.8", unit: "%", range: "40 - 80", flag: "H", section: "DIFFERENTIAL LEUCOCYTE COUNT" });
  expect(find(r, "MENTZER")).toMatchObject({ value: "24.02", unit: null, shape: "value_only" });
});

test("wrapped labels are joined and the continuation line is not a row or a section", () => {
  const r = parse(SAMPLE);
  expect(find(r, "PACKED CELL VOLUME")!.label).toBe("PACKED CELL VOLUME (PCV) - HEMATOCRIT");
  expect(find(r, "RED CELL DISTRIBUTION")!.label).toBe("RED CELL DISTRIBUTION WIDTH (RDW-CV)");
  const hematocritIdx = r.classes.findIndex((_, i) => linesFromText(SAMPLE, 1)[i]!.raw === "HEMATOCRIT");
  expect(r.classes[hematocritIdx]).toBe("label_continuation");
});

test("dash form, counts, qualitative, duration and merged label+value rows", () => {
  const r = parse(SAMPLE);
  const dash = r.rows.find((x) => x.shape === "dash")!;
  expect(dash).toMatchObject({ label: "Neutrophils", value: "74", unit: "%" });
  expect(find(r, "PUS CELLS")).toMatchObject({ value: "3-4", unit: "/hpf", range: "0-1/hpf" });
  expect(find(r, "COLOUR")).toMatchObject({ value: "YELLOW", shape: "qualitative", range: "PALE YELLOW" });
  expect(find(r, "Bleeding Time")).toMatchObject({ value: "2 Minute 30 Second", range: "2-7", shape: "qualitative" });
  expect(find(r, "Free Triiodothyronine")).toMatchObject({ label: "Free Triiodothyronine (FT3)", value: "2.68", unit: "pg/mL", range: "2.6 - 4.2" });
});

test("nothing after Comment becomes a row, and header-zone lines are excluded", () => {
  const r = parse(SAMPLE);
  expect(r.rows.some((x) => x.label === "FT3")).toBe(false);
  expect(r.rows.some((x) => /^page/i.test(x.label))).toBe(false);
  expect(r.rows.some((x) => /^parameter/i.test(x.label))).toBe(false);
});

test("a numeric line that cannot be placed is counted, never dropped", () => {
  const r = parse(SAMPLE);
  expect(r.unplacedNumeric.map((l) => l.raw)).toEqual(["Weird Test      4.5 gm      note"]);
});

test("a table header resets the notes state on the next page", () => {
  const text = "Comment\nSome narrative 12\nTest Name   Result   Unit\nHb      10.1      g/dL      13.0-17.0";
  const r = parse(text);
  expect(r.rows.map((x) => x.label)).toEqual(["Hb"]);
});

test("a long address-like line ending in a number is not a dash row", () => {
  const r = parse("House Of Synthetic Diagnostics Pvt Ltd. 14, 15 & 16 Example Road Delhi - 110000");
  expect(r.rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/rows.test.ts`
Expected: FAIL, cannot find module `./rows`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Line } from "./types";

export type RowShape = "full" | "value_unit" | "value_only" | "dash" | "qualitative";

export interface ParsedRow {
  label: string;
  value: string;
  unit: string | null;
  range: string | null;
  flag: string | null;
  section: string | null;
  page: number;
  lineIndex: number;
  // The source line, verbatim as stored in the page text.
  snippet: string;
  shape: RowShape;
}

export type LineClass = "row" | "label_continuation" | "section" | "header" | "narrative" | "unplaced_numeric" | "other";

export interface ParseRowsResult {
  rows: ParsedRow[];
  classes: LineClass[];
  unplacedNumeric: Line[];
}

const NUM = /^[<>]?\s?\d[\d,]*(\.\d+)?$/;
const COUNT = /^\d+\s?-\s?\d+$/;
const DURATION = /^\d+\s*minutes?(\s*\d+\s*seconds?)?$/i;
const QUAL = /^(negative|positive|nil|absent|present|clear|yellow|pale yellow|not increased|trace|normal|reactive|non[- ]reactive|detected|not detected)$/i;
const UNIT = /^(%|[A-Za-zµμ0-9³^.]*\/[A-Za-zµμ0-9³^.]+|secs?|seconds?|ratio|inr|fl|pg|minutes?)$/i;
const RANGE = /^([<>]\s?\d|\d[\d.]*\s?(-|to)\s?\d|\d[\d.]*\s?-$|normal\b|nil\b|deficiency|desirable|optimal)/i;
const FLAG = /^(H|L|HH|LL|High|Low|\*|Abnormal)$/i;
const MERGED = /^(.*\S)\s+([<>]?\d[\d,]*(?:\.\d+)?)$/;
const DASH = /^(.*[A-Za-z].*?)\s+-\s+(\d[\d.]*)\s*(%)?$/;
const EXCLUDE_LABEL = /^(page|age|patient|pateint|ref|visit|lab\b|booking|mobile|sample|reg|collected|collection|received|receiving|reported|reporting|date|print|name|doctor|centre|center|address|barcode|accession|approved|dob|sex|gender|maxid|op\/ip|nationality|panel|test performed)/i;
const NOTES_START = /^(clinical notes?|notes?\b|comment|interpretation|remarks?|possible causes|conditions of reporting|clinical significance|reference ranges?|factors|about |indications|disclaimer)/i;
const TABLE_HEADER = /^(test name|test|investigation|observation|parameter)$/i;
const SECTION_WORDS = /(profile|panel|count|haematology|hematology|biochemistry|immunology|pathology|endocrinology|serology|examination|function test)/i;
const CONTINUATION = /^[A-Za-z][A-Za-z0-9() \-\/]{0,40}$/;

const clean = (s: string) => s.replace(/[\s:.,]+$/, "").trim();
const plausibleLabel = (s: string) => s.length <= 40 && s.split(/\s+/).length <= 6 && !s.includes(",");

function isSection(text: string): boolean {
  if (/\d/.test(text) || text.length > 80) return false;
  return SECTION_WORDS.test(text) || (/^[^a-z]+$/.test(text) && /[A-Z]{4}/.test(text));
}

function unbalanced(label: string): boolean {
  const open = (label.match(/\(/g) ?? []).length;
  const close = (label.match(/\)/g) ?? []).length;
  return open > close || /[-(]\s*$/.test(label);
}

function isValueCell(cells: string[]): boolean {
  const c = cells[1]!;
  if (NUM.test(c) || QUAL.test(c) || DURATION.test(c)) return true;
  return COUNT.test(c) && (cells[2] ?? "").startsWith("/");
}

function parseRowLine(cells: string[], line: Line, index: number, section: string | null): ParsedRow | null {
  const first = cells[0]!;
  if (EXCLUDE_LABEL.test(first)) return null;
  const base = { page: line.page, lineIndex: index, snippet: line.raw, section };

  if (cells.length === 1) {
    const m = first.match(DASH);
    if (m && plausibleLabel(m[1]!)) {
      return { ...base, label: clean(m[1]!), value: m[2]!, unit: m[3] ?? null, range: null, flag: null, shape: "dash" };
    }
    return null;
  }

  let label = first;
  let value: string;
  let rest: string[];
  if (isValueCell(cells)) {
    value = cells[1]!;
    rest = cells.slice(2);
  } else {
    const m = first.match(MERGED);
    if (!m || !plausibleLabel(m[1]!)) return null;
    label = m[1]!;
    value = m[2]!;
    rest = cells.slice(1);
  }

  let unit: string | null = null;
  let range: string | null = null;
  let flag: string | null = null;
  for (const c of rest) {
    if (flag === null && FLAG.test(c)) flag = c;
    else if (unit === null && UNIT.test(c)) unit = c;
    else if (range === null && RANGE.test(c)) range = c;
  }
  const qualitative = QUAL.test(value) || DURATION.test(value);
  if (qualitative && range === null && rest[0]) range = rest[0];
  const shape: RowShape = qualitative ? "qualitative" : unit && range ? "full" : unit ? "value_unit" : "value_only";
  return { ...base, label: clean(label), value, unit, range, flag, shape };
}

export function parseRows(lines: Line[]): ParseRowsResult {
  const classes: LineClass[] = lines.map(() => "other");
  const rows: ParsedRow[] = [];
  const unplacedNumeric: Line[] = [];
  let section: string | null = null;
  let inNotes = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cells = line.cells.map((c) => c.text);
    if (cells.length === 0) continue;

    if (cells.length >= 2 && TABLE_HEADER.test(cells[0]!)) {
      classes[i] = "header";
      inNotes = false;
      continue;
    }
    if (NOTES_START.test(cells[0]!)) {
      classes[i] = "narrative";
      inNotes = true;
      continue;
    }
    if (inNotes) {
      classes[i] = "narrative";
      continue;
    }

    const prev = rows[rows.length - 1];
    if (prev && prev.lineIndex === i - 1 && prev.page === line.page && unbalanced(prev.label) && cells.length === 1 && CONTINUATION.test(cells[0]!)) {
      prev.label = /\(\S*-$/.test(prev.label) ? prev.label + cells[0]! : `${prev.label} ${cells[0]!}`;
      classes[i] = "label_continuation";
      continue;
    }

    const row = parseRowLine(cells, line, i, section);
    if (row) {
      rows.push(row);
      classes[i] = "row";
      continue;
    }
    if (cells.length === 1 && isSection(cells[0]!)) {
      section = cells[0]!;
      classes[i] = "section";
      continue;
    }
    const startsLikeNumber = (c: string) => /^[<>]?\d/.test(c);
    if (cells.length >= 2 && !EXCLUDE_LABEL.test(cells[0]!) && cells.slice(1).some(startsLikeNumber)) {
      classes[i] = "unplaced_numeric";
      unplacedNumeric.push(line);
    }
  }
  return { rows, classes, unplacedNumeric };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic/rows.test.ts`
Expected: all PASS. When a case fails, fix the regexes/ordering; do not weaken the test text.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/extraction/deterministic/rows.ts apps/api/src/services/extraction/deterministic/rows.test.ts
git commit -m "extraction: row parser with sections, wrapped labels, notes exclusion and unplaced-line accounting"
```

---

### Task 6: Provider adapter, harness integration and baseline

**Files:**
- Modify: `packages/shared/src/providers/extraction.ts` (optional `stats` on `ExtractionResult`)
- Create: `apps/api/src/services/extraction/deterministic/pipeline.ts`
- Create: `apps/api/src/services/extraction/deterministic/provider.ts`
- Modify: `apps/api/eval/types.ts` (optional `header`, `keyOrigin`)
- Modify: `apps/api/eval/score.ts` (`scoreHeader`, `evaluateGates`; `DocScore.source` becomes `string`)
- Modify: `apps/api/eval/run.ts` (`EVAL_PROVIDER=deterministic`, header + gates output)
- Test: `apps/api/src/services/extraction/deterministic/pipeline.test.ts`, additions to `apps/api/eval/score.test.ts`

**Interfaces:**
- Consumes: `linesFromText`, `parseHeader`, `parseRows`, `FIELD_TYPES_BY_DOCUMENT_TYPE` (existing, exported from `anthropicExtraction.ts`).
- Produces: `ParsedDocument { header; rows; unplacedNumeric; lineCount }`, `parseDocument(ocr)`, `rowConfidence(shape)`, `toCandidates(parsed)`, `DeterministicExtractionProvider`; `scoreHeader(expected, actual)`, `evaluateGates(summary)`.

- [ ] **Step 1: Write the failing tests**

`pipeline.test.ts`:

```ts
import { test, expect } from "bun:test";
import type { OcrResult } from "@prelude/shared";
import { parseDocument, toCandidates, rowConfidence } from "./pipeline";
import { DeterministicExtractionProvider } from "./provider";

const ocr = (text: string): OcrResult => ({ fullText: text, pages: [{ pageNumber: 1, text }], providerName: "test", providerRaw: null });
const TEXT = [
  "SYNTHETIC DIAGNOSTIC LABS",
  "Patient Name : Mr. TEST PERSON      Collected On : 08/Apr/2026 10:00 AM",
  "Reported Date : 09/Apr/2026 05:29 AM",
  "Test Name   Result   Unit   Bio. Ref. Interval",
  "HAEMOGLOBIN (Hb)      10.1      g/dL      13.0-17.0",
  "Weird Test      4.5 gm      note",
].join("\n");

test("candidates carry the collection date, verbatim snippets and structure-based confidence", () => {
  const c = toCandidates(parseDocument(ocr(TEXT)));
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ fieldType: "marker_value", trackedMarkerLabel: "HAEMOGLOBIN (Hb)", value: "10.1", unit: "g/dL", referenceRange: "13.0-17.0", asOfDate: "2026-04-08", sourcePage: 1 });
  expect(TEXT).toContain(c[0]!.sourceSnippet!);
  expect(c[0]!.confidence).toBe(rowConfidence("full"));
});

test("report date is the fallback date", () => {
  const c = toCandidates(parseDocument(ocr("Reported Date : 09/Apr/2026\nHb      10.1      g/dL      13-17")));
  expect(c[0]!.asOfDate).toBe("2026-04-09");
});

test("provider reports stats including unplaced lines, and never says 'nothing extractable' for unplaced content", async () => {
  const r = await new DeterministicExtractionProvider().extractFacts(ocr(TEXT), "blood");
  expect(r.candidates).toHaveLength(1);
  expect(r.failedFieldTypes).toEqual([]);
  expect(r.stats).toMatchObject({ rows: 1, unplacedNumericLines: 1 });
});

test("non-blood documents are reported as not handled, not as empty", async () => {
  const r = await new DeterministicExtractionProvider().extractFacts(ocr("IMPRESSION: normal"), "radiology");
  expect(r.candidates).toEqual([]);
  expect(r.failedFieldTypes).toEqual(["radiology_impression", "disease_status_trend"]);
});
```

Append to `apps/api/eval/score.test.ts`:

```ts
import { scoreHeader, evaluateGates } from "./score";

test("scoreHeader compares dates exactly and names/labs loosely", () => {
  const r = scoreHeader(
    { labName: "Acme Diagnostic", collectedOn: "2024-12-12", patientName: "Mr. TESTER", labPatientRef: "LDPL/1" },
    { labName: "Acme Diagnostic Pvt. Ltd", collectedOn: "2024-12-13", patientName: "MR. TESTER", labPatientRef: null },
  );
  expect(r.checked).toBe(4);
  expect(r.correct).toBe(2);
  expect(r.wrong).toEqual(["collectedOn", "labPatientRef"]);
});

test("evaluateGates passes only at 98% recall and 100% accuracy on real hand-keyed documents", () => {
  const good = summarize([scoreDoc("d", [exp()], [cand()], [], "real")]);
  expect(evaluateGates(good).every((g) => g.pass)).toBe(true);
  const bad = summarize([scoreDoc("d", [exp(), exp({ markerLabel: "RBC" })], [cand()], [], "real")]);
  expect(evaluateGates(bad).some((g) => !g.pass)).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/services/extraction/deterministic/pipeline.test.ts apps/api/eval`
Expected: FAIL (missing modules and exports).

- [ ] **Step 3: Implement**

`packages/shared/src/providers/extraction.ts`: add to `ExtractionResult`:

```ts
  // Optional diagnostics from rule-based parsers.
  stats?: { rows: number; unplacedNumericLines: number; lines: number };
```

`pipeline.ts`:

```ts
import type { ExtractedFactCandidate, OcrResult } from "@prelude/shared";
import { parseHeader, type HeaderFields } from "./header";
import { linesFromText } from "./lines";
import { parseRows, type ParsedRow, type RowShape } from "./rows";
import type { Line } from "./types";

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

// Confidence comes from how completely the row parsed (structure), never from a model.
export function rowConfidence(shape: RowShape): number {
  return { full: 0.95, value_unit: 0.85, dash: 0.85, qualitative: 0.8, value_only: 0.7 }[shape];
}

export function toCandidates(parsed: ParsedDocument): ExtractedFactCandidate[] {
  const asOfDate = parsed.header.collectedOn ?? parsed.header.reportedOn ?? null;
  return parsed.rows.map((row) => ({
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
    confidence: rowConfidence(row.shape),
  }));
}
```

`provider.ts`:

```ts
import type { DocumentType, ExtractionProvider, ExtractionResult, OcrResult } from "@prelude/shared";
import { FIELD_TYPES_BY_DOCUMENT_TYPE } from "../anthropicExtraction";
import { parseDocument, toCandidates } from "./pipeline";

// Phase 1: blood documents only. Radiology/prescription narrative is phase 3 (LLM narrative tier) and is
// reported as not handled so it can never look like "nothing extractable".
export class DeterministicExtractionProvider implements ExtractionProvider {
  readonly name = "deterministic";

  async extractFacts(ocr: OcrResult, documentType: DocumentType): Promise<ExtractionResult> {
    if (documentType !== "blood") {
      const failedFieldTypes = FIELD_TYPES_BY_DOCUMENT_TYPE[documentType];
      const failureMessages = Object.fromEntries(failedFieldTypes.map((f) => [f, "not handled by the deterministic parser (phase 3)"]));
      return { candidates: [], failedFieldTypes, failureMessages };
    }
    const parsed = parseDocument(ocr);
    return {
      candidates: toCandidates(parsed),
      failedFieldTypes: [],
      stats: { rows: parsed.rows.length, unplacedNumericLines: parsed.unplacedNumeric.length, lines: parsed.lineCount },
    };
  }
}
```

`apps/api/eval/types.ts`: in `ExpectedDocSchema` add

```ts
  // Optional header expectations (compared loosely for names, exactly for dates).
  header: z
    .object({
      labName: z.string().nullable().optional(),
      collectedOn: z.string().nullable().optional(),
      patientName: z.string().nullable().optional(),
      labPatientRef: z.string().nullable().optional(),
    })
    .optional(),
  // "scripted" keys were generated from the document text by a script (not read by hand), so scoring a parser against them is circular.
  keyOrigin: z.enum(["hand", "scripted"]).default("hand"),
```

`apps/api/eval/score.ts`: change `DocScore.source` and the `scoreDoc` `source` parameter type from `"real" | "synthetic"` to `string`; add:

```ts
export interface HeaderExpect {
  labName?: string | null;
  collectedOn?: string | null;
  patientName?: string | null;
  labPatientRef?: string | null;
}

const looseEqual = (a: string, b: string) => {
  const x = squash(a), y = squash(b);
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
};

export function scoreHeader(expected: HeaderExpect, actual: Partial<Record<keyof HeaderExpect, string | null>>): { checked: number; correct: number; wrong: string[] } {
  let checked = 0, correct = 0;
  const wrong: string[] = [];
  for (const key of ["labName", "collectedOn", "patientName", "labPatientRef"] as const) {
    const want = expected[key];
    if (want === undefined) continue;
    checked++;
    const got = actual[key] ?? null;
    const ok = want === null ? got === null : got !== null && (key === "collectedOn" ? got === want : looseEqual(got, want));
    if (ok) correct++; else wrong.push(key);
  }
  return { checked, correct, wrong };
}

export function evaluateGates(s: Summary): { name: string; pass: boolean; detail: string }[] {
  const real = s.bySource.real;
  const pct = (n: number | null | undefined) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
  return [
    { name: "real recall >= 98%", pass: (real?.recall ?? 0) >= 0.98, detail: pct(real?.recall) },
    { name: "value accuracy 100% on matched", pass: s.valueAccuracy === 1, detail: pct(s.valueAccuracy) },
    { name: "all-correct 100% on matched", pass: s.factAccuracy === 1, detail: pct(s.factAccuracy) },
  ];
}
```

`apps/api/eval/run.ts` (the LLM path stays unchanged):

```ts
// imports
import { DeterministicExtractionProvider } from "../src/services/extraction/deterministic/provider";
import { parseDocument } from "../src/services/extraction/deterministic/pipeline";
import { evaluateGates, formatSummary, scoreDoc, scoreHeader, summarize, type DocScore } from "./score";

// replace `const provider = getExtractionProvider();`
const deterministic = process.env.EVAL_PROVIDER === "deterministic";
const provider = deterministic ? new DeterministicExtractionProvider() : getExtractionProvider();
let headerChecked = 0;
let headerCorrect = 0;

// inside the document loop, right after `expected` is parsed:
if (deterministic && expected.documentType !== "blood") {
  console.log(`${name}: skipped (phase 1: blood only)`);
  continue;
}

// replace the existing scoreDoc call and the console.log that follows it:
const source = expected.keyOrigin === "scripted" ? "real_scripted" : expected.source;
const score = scoreDoc(repeat > 1 ? `${name}#${run}` : name, expected.facts, candidates, failedFieldTypes, source);
docs.push(score);
let extra = "";
if (deterministic) {
  extra = ` | unplaced ${result.stats?.unplacedNumericLines ?? 0}`;
  if (expected.header) {
    const h = scoreHeader(expected.header, parseDocument(ocr).header);
    headerChecked += h.checked;
    headerCorrect += h.correct;
    extra += ` | header ${h.correct}/${h.checked}${h.wrong.length ? ` wrong: ${h.wrong.join(",")}` : ""}`;
  }
}
console.log(
  `${score.name}: expected ${score.expected.length}, extracted ${score.extracted.length}, ` +
    `matched ${score.results.length}, wrong ${score.results.filter((r) => !r.correct).length}, ` +
    `missed ${score.missed.length}, spurious ${score.spurious.length}` +
    (failedFieldTypes.length ? ` | FAILED field types: ${failedFieldTypes.join(",")}` : "") +
    extra,
);

// after `console.log("\n" + formatSummary(summary));`
if (deterministic && headerChecked > 0) console.log(`header fields correct: ${headerCorrect}/${headerChecked}`);
for (const g of evaluateGates(summary)) console.log(`${g.pass ? "PASS" : "FAIL"} ${g.name} (${g.detail})`);
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test apps/api/src/services/extraction/deterministic apps/api/eval && bunx tsc --noEmit 2>&1 | grep -E "deterministic|apps/api/eval"`
Expected: all tests PASS; no typecheck output.

- [ ] **Step 5: Add header blocks to the answer keys (data step, gitignored)**

For each real blood key in `apps/api/eval/fixtures/*.expected.json`, add a `header` block by **reading the document text** (not by running the parser): `labName`, `collectedOn` (same date as the facts' `asOfDate`), `patientName` (as printed), `labPatientRef`. Set `"keyOrigin": "scripted"` in the two script-generated blood keys (their facts were generated by script). Validate: `bun -e 'import {ExpectedDocSchema} from "./apps/api/eval/types"; import {readdirSync} from "node:fs"; for (const f of readdirSync("apps/api/eval/fixtures").filter(f=>f.endsWith(".expected.json"))) ExpectedDocSchema.parse(await Bun.file("apps/api/eval/fixtures/"+f).json()); console.log("keys valid")'`. Ask the user to review the header blocks.

- [ ] **Step 6: Run the deterministic baseline (local, no network)**

Run: `EVAL_PROVIDER=deterministic bun run eval:extraction`
Expected: per-document lines, the summary, header totals and three gate lines. Record recall, wrong values, unplaced-line counts and the gate result. This run needs no API keys and sends nothing off the machine.

- [ ] **Step 7: Diagnose misses and iterate (if any gate fails)**

Open the latest `apps/api/eval/results/*.json`, list each `missed` and `wrong` fact with its source line, and fix the parser by adding a failing synthetic test that reproduces the line shape first, then the rule. Re-run Step 6. Stop when the gates pass or when the remaining misses are listed with a one-line cause each. Do not loosen a gate.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/providers/extraction.ts apps/api/src/services/extraction/deterministic apps/api/eval/types.ts apps/api/eval/score.ts apps/api/eval/score.test.ts apps/api/eval/run.ts
git status --short | grep -E "fixtures|results|reports"   # must print nothing
git commit -m "extraction: deterministic provider, header/gate scoring and harness integration (phase 1)"
```
