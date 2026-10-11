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
