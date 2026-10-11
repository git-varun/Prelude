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
