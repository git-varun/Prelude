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
const UNIT = /^(%|[A-Za-zµμ0-9³^.]*\/[A-Za-zµμ0-9³^.]+|secs?|seconds?|ratio|inr|fl|pg|minutes?|ml|dl|mg|g|gm|kg|ug|µg|ng|iu|meq|mmol|mm)$/i;
const RANGE = /^([<>]\s?\d|\d[\d.]*\s?(-|to)\s?\d|\d[\d.]*\s?-$|normal\b|nil\b|deficiency|desirable|optimal)/i;
const FLAG = /^(H|L|HH|LL|High|Low|\*|Abnormal)$/i;
const INLINE = /^(.*?[A-Za-z].*?)\s*:\s*([<>]?\d[\d,]*(?:\.\d+)?)\s*([^\s(]+)?\s*(?:\((?:ref(?:erence)?\.?:?\s*)?([^)]*)\))?\s*$/i;
const MERGED = /^(.*\S)\s+([<>]?\d[\d,]*(?:\.\d+)?)$/;
const DASH = /^(.*[A-Za-z].*?)\s+-\s+(\d[\d.]*)\s*(%)?$/;
const EXCLUDE_LABEL = /^(page|age|patient|pateint|ref|visit|lab\b|booking|mobile|sample|reg|collected|collection|received|receiving|reported|reporting|date|print|name|doctor|centre|center|address|barcode|accession|approved|dob|sex|gender|maxid|op\/ip|nationality|panel|test performed|phone|tel\b|fax|email|pin\b|zip|mr\b|mrs\b|ms\b|miss\b|dr\b)/i;
const NOTES_START = /^(clinical notes?|notes?\b|comment|interpretation|remarks?|possible causes|conditions of reporting|clinical significance|reference ranges?|factors|about |indications|disclaimer)/i;
const TABLE_HEADER = /^(test name|test|investigation|observation|parameter)$/i;
const RESULT_COLUMN = /^(result|results|value|observation)$/i;
const SECTION_WORDS = /(profile|panel|count|haematology|hematology|biochemistry|immunology|pathology|endocrinology|serology|examination|function test)/i;
const CONTINUATION = /^[A-Za-z][A-Za-z0-9() \-\/]{0,40}$/;

// Letter-spaced PDFs print labels like "R egistered"; test the exclusion on the label with spaces removed too.
const isExcluded = (label: string) => EXCLUDE_LABEL.test(label) || EXCLUDE_LABEL.test(label.replace(/\s+/g, ""));

const clean = (s: string) => s.replace(/[\s:.,]+$/, "").trim();
const plausibleLabel = (s: string) => s.length <= 40 && s.split(/\s+/).length <= 6 && !s.includes(",");

// A result table header names a result column; a reference table that merely starts with "Parameter" does not.
function isTableHeader(cells: string[]): boolean {
  return cells.length >= 2 && TABLE_HEADER.test(cells[0]!) && cells.slice(1).some((c) => RESULT_COLUMN.test(c));
}

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
  if (isExcluded(first)) return null;
  const base = { page: line.page, lineIndex: index, snippet: line.raw, section };

  if (cells.length === 1) {
    const m = first.match(DASH);
    if (m && plausibleLabel(m[1]!) && !m[1]!.includes(":")) {
      return { ...base, label: clean(m[1]!), value: m[2]!, unit: m[3] ?? null, range: null, flag: null, shape: "dash" };
    }
    const inl = first.match(INLINE);
    // A unit-like token that is not a unit ("-3.0" in "0.2-3.0") means this is prose or a range, not a result.
    if (inl && inl[1]!.length <= 60 && !/^\d/.test(inl[1]!) && !(inl[3] && !UNIT.test(inl[3]))) {
      const unit = inl[3] ?? null;
      const range = inl[4]?.trim() || null;
      return { ...base, label: clean(inl[1]!), value: inl[2]!, unit, range, flag: null, shape: unit && range ? "full" : unit ? "value_unit" : "value_only" };
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

    if (isTableHeader(cells)) {
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
    if (cells.length >= 2 && !isExcluded(cells[0]!) && cells.slice(1).some(startsLikeNumber)) {
      classes[i] = "unplaced_numeric";
      unplacedNumeric.push(line);
    }
  }
  return { rows, classes, unplacedNumeric };
}
