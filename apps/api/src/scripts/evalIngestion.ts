import { readdir } from "node:fs/promises";
import { sql } from "../db/client";
import { getExtractionProvider, getOcrProvider } from "../services/providerFactory";
import { persistExtractedFacts } from "../services/facts";
import { createTestUser, createTestPatient, deleteTestPatients, deleteTestUsers } from "../test-helpers";

// One-off eval: runs the real ingestion pipeline (OCR -> LLM extraction ->
// rules engine -> FACT persistence, via the same persistExtractedFacts used
// by the upload route) against the synthetic samples from
// scripts/generateSampleDocs.ts, for whichever OCR_PROVIDER/EXTRACTION_PROVIDER
// are set in the environment. Never touches real patient data: creates its
// own ephemeral patient/visit/documents and deletes them afterward.
const SAMPLES_DIR = new URL("../../.eval-samples/", import.meta.url);

const DOCUMENT_TYPE_BY_PREFIX: Record<string, "blood" | "prescription" | "radiology"> = {
  blood: "blood",
  prescription: "prescription",
  radiology: "radiology",
};

function documentTypeFromFilename(filename: string): "blood" | "prescription" | "radiology" {
  const prefix = filename.split("_")[0] ?? "";
  const documentType = DOCUMENT_TYPE_BY_PREFIX[prefix];
  if (!documentType) {
    throw new Error(`Can't infer document_type from sample filename: ${filename}`);
  }
  return documentType;
}

interface DocResult {
  filename: string;
  documentType: string;
  provider: string;
  ocrStatus: "done" | "failed";
  extractionStatus: "pending" | "done" | "partial" | "failed";
  factCount: number;
  extractionUncertainCount: number;
  needsManualDateCount: number;
  error?: string;
}

async function run(): Promise<void> {
  const ocrProvider = getOcrProvider();
  const extractionProvider = getExtractionProvider();

  const files = (await readdir(SAMPLES_DIR)).filter((f) => f.endsWith(".pdf")).sort();
  if (files.length === 0) {
    throw new Error(`No .pdf samples found in ${SAMPLES_DIR.pathname}. Run scripts/generateSampleDocs.ts first.`);
  }

  const staff = await createTestUser("staff", "eval-ingestion");
  const patient = await createTestPatient(staff.id);
  const [visit] = await sql`INSERT INTO visits (patient_id) VALUES (${patient.id}) RETURNING id`;

  // Seed two controlled markers so the "clean" blood samples get a confident
  // tracked_marker_id match, giving the eval a real value_found case to
  // contrast against the deliberately unmapped-marker sample.
  for (const markerName of ["CEA", "PSA"]) {
    await sql`
      INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
      VALUES (${patient.id}, ${markerName}, false, ${staff.id})
    `;
  }

  const results: DocResult[] = [];

  try {
    for (const filename of files) {
      const documentType = documentTypeFromFilename(filename);
      const buffer = Buffer.from(await Bun.file(new URL(filename, SAMPLES_DIR)).arrayBuffer());

      const [document] = await sql`
        INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
        VALUES (${patient.id}, ${visit.id}, ${`eval://${filename}`}, ${documentType}, 'own_hospital', ${staff.id}, 'pending')
        RETURNING id, patient_id, visit_id
      `;

      let ocrResult;
      try {
        ocrResult = await ocrProvider.extractText(buffer, "application/pdf");
        await sql`UPDATE documents SET ocr_status = 'done' WHERE id = ${document.id}`;
      } catch (err) {
        await sql`UPDATE documents SET ocr_status = 'failed' WHERE id = ${document.id}`;
        results.push({
          filename,
          documentType,
          provider: ocrProvider.name,
          ocrStatus: "failed",
          extractionStatus: "pending",
          factCount: 0,
          extractionUncertainCount: 0,
          needsManualDateCount: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      try {
        const { candidates, failedFieldTypes } = await extractionProvider.extractFacts(ocrResult, documentType);
        const persisted = await persistExtractedFacts(document, candidates, staff.id);
        const extractionStatus =
          failedFieldTypes.length === 0 ? "done" : candidates.length > 0 ? "partial" : "failed";
        const extractionError = extractionStatus === "done" ? null : `Field type(s) failed: ${failedFieldTypes.join(", ")}`;
        await sql`UPDATE documents SET extraction_status = ${extractionStatus}, extraction_error = ${extractionError} WHERE id = ${document.id}`;

        const facts = await sql`SELECT coverage_status, needs_manual_date FROM facts WHERE document_id = ${document.id}`;
        results.push({
          filename,
          documentType,
          provider: ocrProvider.name,
          ocrStatus: "done",
          extractionStatus,
          factCount: persisted.createdFactIds.length,
          extractionUncertainCount: facts.filter((f: any) => f.coverage_status === "extraction_uncertain").length,
          needsManualDateCount: facts.filter((f: any) => f.needs_manual_date).length,
        });
      } catch (err) {
        await sql`UPDATE documents SET extraction_status = 'failed' WHERE id = ${document.id}`;
        results.push({
          filename,
          documentType,
          provider: ocrProvider.name,
          ocrStatus: "done",
          extractionStatus: "failed",
          factCount: 0,
          extractionUncertainCount: 0,
          needsManualDateCount: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    await deleteTestPatients(patient.id);
    await deleteTestUsers(staff.id);
  }

  console.log(`\nOCR_PROVIDER=${ocrProvider.name}  EXTRACTION_PROVIDER=${extractionProvider.name}\n`);
  console.log(
    [
      "filename",
      "document_type",
      "ocr_status",
      "extraction_status",
      "fact_count",
      "extraction_uncertain",
      "needs_manual_date",
    ].join("\t"),
  );
  for (const r of results) {
    console.log(
      [
        r.filename,
        r.documentType,
        r.ocrStatus,
        r.extractionStatus,
        r.factCount,
        r.extractionUncertainCount,
        r.needsManualDateCount,
      ].join("\t"),
    );
    if (r.error) console.log(`    error: ${r.error}`);
  }

  const sum = (pick: (r: DocResult) => number) => results.reduce((acc, r) => acc + pick(r), 0);
  console.log(
    `\nTotals: ${results.length} documents, ` +
      `${sum((r) => (r.ocrStatus === "done" ? 1 : 0))} ocr done / ${sum((r) => (r.ocrStatus === "failed" ? 1 : 0))} ocr failed, ` +
      `${sum((r) => (r.extractionStatus === "done" ? 1 : 0))} extraction done / ${sum((r) => (r.extractionStatus === "partial" ? 1 : 0))} partial / ${sum((r) => (r.extractionStatus === "failed" ? 1 : 0))} extraction failed, ` +
      `${sum((r) => r.factCount)} facts persisted, ${sum((r) => r.extractionUncertainCount)} extraction_uncertain, ` +
      `${sum((r) => r.needsManualDateCount)} facts needing a manual date.`,
  );
}

await run();
process.exit(0);
