import { mkdir } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// One-off eval tooling (see scripts/evalIngestion.ts): builds a small set of
// synthetic, single-page PDFs to run the ingestion pipeline against. AWS
// Textract's DetectDocumentText only supports single-page PDFs/images
// (apps/api/src/services/ocr/awsTextract.ts), so every sample here is one
// page. Nothing here is or is derived from real patient data.
const OUT_DIR = new URL("../../.eval-samples/", import.meta.url);

interface Sample {
  filename: string;
  documentType: "blood" | "prescription" | "radiology";
  lines: string[];
}

const SAMPLES: Sample[] = [
  {
    filename: "blood_01_clean_match.pdf",
    documentType: "blood",
    lines: [
      "ONCOLOGY DIAGNOSTIC LABS",
      "Patient: Synthetic Patient A     Report Date: 2026-08-01",
      "",
      "Test                Result       Unit       Reference Range",
      "CEA                 4.2          ng/mL      0-5 ng/mL",
      "CA-125               18          U/mL       0-35 U/mL",
    ],
  },
  {
    filename: "blood_02_unmapped_marker.pdf",
    documentType: "blood",
    lines: [
      "ONCOLOGY DIAGNOSTIC LABS",
      "Patient: Synthetic Patient A     Report Date: 2026-08-05",
      "",
      "Test                Result       Unit       Reference Range",
      "Vitamin D Level      22          ng/mL      30-100 ng/mL",
    ],
  },
  {
    filename: "blood_03_no_date.pdf",
    documentType: "blood",
    lines: [
      "ONCOLOGY DIAGNOSTIC LABS",
      "Patient: Synthetic Patient A",
      "",
      "Test                Result       Unit       Reference Range",
      "CEA                 5.9          ng/mL      0-5 ng/mL",
    ],
  },
  {
    filename: "blood_04_multiple_markers.pdf",
    documentType: "blood",
    lines: [
      "ONCOLOGY DIAGNOSTIC LABS",
      "Patient: Synthetic Patient A     Report Date: 2026-08-15",
      "",
      "Test                Result       Unit       Reference Range",
      "CEA                 3.8          ng/mL      0-5 ng/mL",
      "PSA                  1.1          ng/mL      0-4 ng/mL",
    ],
  },
  {
    filename: "prescription_01_clean.pdf",
    documentType: "prescription",
    lines: [
      "MEDICAL ONCOLOGY - TREATMENT NOTE",
      "Patient: Synthetic Patient A     Date: 2026-07-20",
      "",
      "Regimen: Paclitaxel 175 mg/m2 IV, Cycle 3 of 6, every 21 days.",
    ],
  },
  {
    filename: "prescription_02_no_date.pdf",
    documentType: "prescription",
    lines: [
      "MEDICAL ONCOLOGY - TREATMENT NOTE",
      "Patient: Synthetic Patient A",
      "",
      "Regimen: Continue Tamoxifen 20mg daily, oral, ongoing.",
    ],
  },
  {
    filename: "prescription_03_alt_format.pdf",
    documentType: "prescription",
    lines: [
      "MEDICAL ONCOLOGY - TREATMENT NOTE",
      "Patient: Synthetic Patient A     Date: 2026-09-01",
      "",
      "Plan: FOLFOX regimen (Oxaliplatin, Leucovorin, 5-FU), cycle 5 of 8, biweekly.",
    ],
  },
  {
    filename: "radiology_01_clean.pdf",
    documentType: "radiology",
    lines: [
      "RADIOLOGY REPORT - CT CHEST/ABDOMEN/PELVIS",
      "Patient: Synthetic Patient A     Study Date: 2026-08-10",
      "",
      "Findings: No new pulmonary nodules. Previously noted hepatic lesion unchanged.",
      "",
      "Impression: Stable disease, no new lesions.",
      "Disease status: Stable disease.",
    ],
  },
  {
    filename: "radiology_02_ambiguous.pdf",
    documentType: "radiology",
    lines: [
      "RADIOLOGY REPORT - CT CHEST/ABDOMEN/PELVIS",
      "Patient: Synthetic Patient A     Study Date: 2026-08-20",
      "",
      "Findings: Indeterminate small nodularity, correlate clinically, cannot exclude progression.",
      "",
      "Impression: Findings of uncertain significance; follow-up recommended.",
    ],
  },
];

async function buildPdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter, matches a scanned single-page report
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  let y = 740;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: fontSize, font, color: rgb(0, 0, 0) });
    y -= fontSize + 8;
  }
  return doc.save();
}

await mkdir(OUT_DIR, { recursive: true });

for (const sample of SAMPLES) {
  const bytes = await buildPdf(sample.lines);
  await Bun.write(new URL(sample.filename, OUT_DIR), bytes);
  console.log(`wrote ${sample.filename} (${sample.documentType})`);
}

console.log(`\n${SAMPLES.length} synthetic sample document(s) written to ${OUT_DIR.pathname}`);
process.exit(0);
