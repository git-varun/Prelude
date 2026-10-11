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
  const hematocritIdx = linesFromText(SAMPLE, 1).findIndex((l) => l.raw === "HEMATOCRIT");
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

test("slashless units such as mL are recognised", () => {
  const r = parse("VOLUME      30.00      mL");
  expect(r.rows[0]).toMatchObject({ label: "VOLUME", value: "30.00", unit: "mL", shape: "value_unit" });
});

test("inline 'Label : value unit (Ref: range)' rows parse from a single cell", () => {
  const r = parse("Fasting Glucose : 98 mg/dL (Ref: 70 to 100)\nTSH : 2.10 mIU/L (Ref: 0.35 to 5.50)");
  expect(r.rows).toHaveLength(2);
  expect(r.rows[0]).toMatchObject({ label: "Fasting Glucose", value: "98", unit: "mg/dL", range: "70 to 100", shape: "full" });
});

test("header-like inline lines are not rows", () => {
  const r = parse("Phone : 9999900000\nCollected On : 14/03/2026\nPatient ID : 12345");
  expect(r.rows).toHaveLength(0);
});

test("reference-range prose lines are never parsed as results", () => {
  const r = parse(
    [
      "Adults > 20 Yrs : 0.270 - 5.500",
      "1-3 Days : 5.17 - 14.6",
      "7 - 11Yrs : 0.66 - 4.14",
      "Second trimester: 0.2-3.0",
      "First trimester: less than 2.5 with a range of 0.1-2.5.",
    ].join("\n"),
  );
  expect(r.rows).toEqual([]);
});

test("inline rows still work when the unit and range are valid", () => {
  const r = parse("TSH : 2.10 mIU/L (Ref: 0.35 to 5.50)\nCreatinine : 0.92 mg/dL");
  expect(r.rows.map((x) => [x.label, x.value, x.unit])).toEqual([["TSH", "2.10", "mIU/L"], ["Creatinine", "0.92", "mg/dL"]]);
});

test("letter-spaced header lines are neither rows nor unplaced numeric lines", () => {
  const r = parse("Mr. TEST PERSON      R egistered O N:      12/D ec/2024 10:01PM\nB arcode N O:      ZZ000000      S ample C oll. D ate:      12/D ec/202410:01PM");
  expect(r.rows).toEqual([]);
  expect(r.unplacedNumeric).toEqual([]);
});

// ---- review fixes ----

test("range prose such as 'Borderline 200 - 239' is not a dash row", () => {
  expect(parse("Borderline 200 - 239\nMale 13 - 17\nGlucose Fasting 70 - 110").rows).toEqual([]);
});

test("a notes block is reset on a new page, and a result-shaped narrative line is counted not lost", () => {
  const next = [...linesFromText("Factors affecting results\nNext page", 1), ...linesFromText("Hb      10.1      g/dL      13-17", 2)];
  expect(parseRows(next).rows.map((x) => x.label)).toEqual(["Hb"]);
  const inNotes = parse("Comment\nHb      10.1      g/dL      13-17");
  expect(inNotes.rows).toEqual([]);
  expect(inNotes.unplacedNumeric).toHaveLength(1);
});

test("header variants 'Test Description / Value(s)' and 'Observed Value' end the notes block", () => {
  expect(parse("Notes\nCOMPLETE BLOOD COUNT\nTest Description   Value(s)   Unit\nHb      10.1      g/dL").rows.map((x) => x.label)).toEqual(["Hb"]);
  expect(parse("Notes\nInvestigation   Observed Value   Unit\nHb      10.1      g/dL").rows.map((x) => x.label)).toEqual(["Hb"]);
});

test("single-cell lines with a number and unit are parsed or counted, never lost", () => {
  for (const text of ["Hb : 10.1 g/dL H", "eGFR : 90 mL/min/1.73m2", "Hb 10.1 g/dL 13-17", "Total Leucocyte Count 5600 cells/cumm"]) {
    const r = parse(text);
    expect(r.rows.length + r.unplacedNumeric.length).toBe(1);
  }
});

test("a label that already contains its number is not split into label + value", () => {
  for (const text of ["CA 125      U/mL      0-35", "Vitamin B 12      pg/mL      200-900"]) {
    const r = parse(text);
    expect(r.rows).toEqual([]);
    expect(r.unplacedNumeric).toHaveLength(1);
  }
});

test("an unknown label+number merged cell is parsed with reduced confidence shape 'merged'", () => {
  const r = parse("Interleukin 6      pg/mL      <7");
  expect(r.rows[0]).toMatchObject({ label: "Interleukin", value: "6", shape: "merged" });
});

test("generic inline guide lines are not results, but inline rows need a unit or range", () => {
  expect(parse("High: 240\nOptimal : 100\nDesirable : <200\nReport Status : 2").rows).toEqual([]);
});

test("a qualitative row does not take a numeric index as its range, and the index is counted", () => {
  const r = parse("HbsAg      Reactive      1.20      S/CO");
  expect(r.rows[0]).toMatchObject({ value: "Reactive", unit: "S/CO", range: null, shape: "qualitative" });
  expect(r.unplacedNumeric).toHaveLength(1);
});

test("a wrapped label never swallows a section header or the next test name", () => {
  const a = parse("PACKED CELL VOLUME (PCV) -   31.6   %\nDIFFERENTIAL LEUCOCYTE COUNT\nNeutrophils   68   %");
  expect(a.rows.map((x) => [x.label, x.section])).toEqual([["PACKED CELL VOLUME (PCV) -", null], ["Neutrophils", "DIFFERENTIAL LEUCOCYTE COUNT"]]);
  const b = parse("Neutrophils (Absolute -   4.2   10^3/uL\nLymphocytes");
  expect(b.rows[0]!.label).toBe("Neutrophils (Absolute -");
});

test("single-spaced result lines (OCR text with no column structure) are counted as unplaced, not silently lost", () => {
  const r = parse(["Platelet 182 10^3/uL 150-410", "TLC 7.40 10^3/uL 4-10", "SGPT 34 U/L 0-35", "Creatinine 0.92 mg/dL 0.6-1.3", "CEA 3.1 ng/mL", "Hemoglobin 11.8"].join("\n"));
  expect(r.rows).toEqual([]);
  expect(r.unplacedNumeric).toHaveLength(6);
});

test("header and address lines are not counted as single-spaced results", () => {
  const r = parse(["Collected On 08/Apr/2026", "Page 1 of 2", "Mobile 9999900000", "Report Date 20-07-2026"].join("\n"));
  expect(r.unplacedNumeric).toEqual([]);
});
