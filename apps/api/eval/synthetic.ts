import type { OcrResult } from "@prelude/shared";
import type { ExpectedDoc, ExpectedFact } from "./types";

// PHI-free synthetic reports: the same tests printed under different labels,
// units and layouts per "lab style", with the answer key generated alongside so
// it is exact. Deterministic (no randomness).
export interface SynTest {
  id: string;
  value: string;
  names: readonly [string, string, string];
  units: readonly [string, string, string];
  range: readonly [string, string];
}

export const SYN_TESTS: readonly SynTest[] = [
  { id: "hb", value: "11.8", names: ["Hb", "Haemoglobin (Hb)", "Hemoglobin"], units: ["g/dL", "g/dl", "gm/dL"], range: ["13.0", "17.0"] },
  { id: "rbc", value: "4.12", names: ["RBC Count", "RED BLOOD CELLS- RBC COUNT", "Red Blood Cells"], units: ["millions/mm³", "10^6/µL", "mill/mm3"], range: ["4.5", "5.5"] },
  { id: "wbc", value: "7.40", names: ["WBC", "TOTAL LEUKOCYTE COUNT (TLC)", "Total Leucocyte Count"], units: ["10^3/µL", "thou/µL", "K/µL"], range: ["4.0", "10.0"] },
  { id: "plt", value: "182", names: ["Platelets", "PLATELET COUNT", "Platelet Count"], units: ["10^3/µL", "thou/µL", "K/µL"], range: ["150", "410"] },
  { id: "alt", value: "34", names: ["ALT", "SGPT (ALT)", "SGPT"], units: ["U/L", "U/L", "IU/L"], range: ["0", "35"] },
  { id: "ast", value: "29", names: ["AST", "SGOT (AST)", "SGOT"], units: ["U/L", "U/L", "IU/L"], range: ["0", "40"] },
  { id: "creat", value: "0.92", names: ["Creatinine", "CREATININE-SERUM", "Serum Creatinine"], units: ["mg/dL", "mg/dl", "mg/dL"], range: ["0.60", "1.30"] },
  { id: "glu", value: "98", names: ["Fasting Glucose", "BLOOD GLUCOSE FASTING", "FBS"], units: ["mg/dL", "mg/dl", "mg/dL"], range: ["70", "100"] },
  { id: "tsh", value: "2.10", names: ["TSH", "THYROID STIMULATING HORMONE (TSH)", "Thyroid Stimulating Hormone"], units: ["µIU/mL", "uIU/mL", "mIU/L"], range: ["0.35", "5.50"] },
  { id: "t3_total", value: "112", names: ["T3 Total", "TRIODOTHYRONINE TOTAL (T3)", "T3, Total"], units: ["ng/dL", "ng/dl", "ng/dL"], range: ["60", "200"] },
  { id: "ft4", value: "1.12", names: ["FT4", "FREE THYROXINE (FT4)", "Free T4"], units: ["ng/dL", "ng/dl", "ng/dL"], range: ["0.8", "1.8"] },
];

const DATE = "2026-03-14";
const rangeText = (t: SynTest, style: 0 | 1 | 2) =>
  style === 0 ? `${t.range[0]}-${t.range[1]}` : style === 1 ? `${t.range[0]} - ${t.range[1]}` : `${t.range[0]} to ${t.range[1]}`;
const dateLine = (style: 0 | 1 | 2) =>
  style === 0 ? "Collected On : 14/Mar/2026 10:00 AM" : style === 1 ? "Sample Date: 14-03-2026" : "Date: 2026-03-14";

function ocrFrom(pages: string[]): OcrResult {
  return {
    fullText: pages.join("\n"),
    pages: pages.map((text, i) => ({ pageNumber: i + 1, text })),
    providerName: "synthetic",
    providerRaw: null,
  };
}

export function buildSyntheticLab(style: 0 | 1 | 2, rowsPerPage: number): { ocr: OcrResult; expected: ExpectedDoc } {
  const facts: ExpectedFact[] = [];
  const pages: string[] = [];
  for (let start = 0; start < SYN_TESTS.length; start += rowsPerPage) {
    const lines = [`SYNTHETIC LAB ${style}`, dateLine(style), "Test | Result | Unit | Reference"];
    const pageNumber = pages.length + 1;
    for (const t of SYN_TESTS.slice(start, start + rowsPerPage)) {
      const label = style === 1 ? t.names[style].toUpperCase() : t.names[style];
      const unit = t.units[style];
      const range = rangeText(t, style);
      lines.push(
        style === 0 ? `${label.padEnd(30)}${t.value.padEnd(10)}${unit.padEnd(14)}${range}`
        : style === 1 ? `${label}   ${t.value}   ${range}   ${unit}\nMethod: automated`
        : `${label} : ${t.value} ${unit} (Ref: ${range})`,
      );
      facts.push({
        fieldType: "marker_value", markerLabel: label, canonicalMarker: null, value: t.value, unit,
        referenceRange: range, asOfDate: DATE, sourcePage: pageNumber,
      });
    }
    pages.push(lines.join("\n"));
  }
  return { ocr: ocrFrom(pages), expected: { documentType: "blood", source: "synthetic", facts } };
}

export function buildSyntheticRadiology(): { ocr: OcrResult; expected: ExpectedDoc } {
  const impression = "No focal consolidation. Mild cardiomegaly. No pleural effusion.";
  const ocr = ocrFrom([`SYNTHETIC RADIOLOGY\nDate: 14/03/2026\nCHEST X-RAY PA\nFINDINGS: Lungs clear.\nIMPRESSION: ${impression}`]);
  return {
    ocr,
    expected: {
      documentType: "radiology", source: "synthetic",
      facts: [{ fieldType: "radiology_impression", markerLabel: null, canonicalMarker: null, value: impression, unit: null, referenceRange: null, asOfDate: DATE, sourcePage: 1 }],
    },
  };
}

export function buildSyntheticPrescription(): { ocr: OcrResult; expected: ExpectedDoc } {
  const regimen = "Capecitabine 1000 mg/m2 twice daily on days 1-14 every 21 days";
  const ocr = ocrFrom([`SYNTHETIC CLINIC\nDate: 14/03/2026\nRx: ${regimen}\nReview after 3 cycles`]);
  return {
    ocr,
    expected: {
      documentType: "prescription", source: "synthetic",
      facts: [{ fieldType: "treatment_regimen", markerLabel: null, canonicalMarker: null, value: regimen, unit: null, referenceRange: null, asOfDate: DATE, sourcePage: 1 }],
    },
  };
}

if (import.meta.main) {
  const out = new URL("./fixtures/", import.meta.url);
  const docs: [string, { ocr: OcrResult; expected: ExpectedDoc }][] = [
    ["syn-lab-0", buildSyntheticLab(0, 4)], ["syn-lab-1", buildSyntheticLab(1, 4)], ["syn-lab-2", buildSyntheticLab(2, 4)],
    ["syn-radiology", buildSyntheticRadiology()], ["syn-prescription", buildSyntheticPrescription()],
  ];
  for (const [name, d] of docs) {
    await Bun.write(new URL(`${name}.ocr.json`, out), JSON.stringify(d.ocr, null, 2));
    await Bun.write(new URL(`${name}.expected.json`, out), JSON.stringify(d.expected, null, 2));
    console.log(`${name}: ${d.expected.facts.length} facts, ${d.ocr.pages.length} page(s)`);
  }
}
