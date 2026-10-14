import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client";
import { isHeldIdentityStatus } from "../src/services/delta";
import { slugFor } from "./buildFixtures";
import { ExpectedDocSchema, type ExpectedDoc } from "./types";

// Upload audit rows are written as JSON.stringify(...)::jsonb, which Bun stores as a jsonb *string*; the query unwraps both shapes.
// Exports fully spot-checked documents as eval answer keys (keyOrigin "spot_check").
// The key holds only rows the extractor found, so it can measure precision/accuracy but NOT recall.
// Output is PHI: it lands in the gitignored eval/fixtures/. This script prints counts only, never values.
const REPORTS = new URL("../../../docs/reports/", import.meta.url);
const OUT = new URL("./fixtures/", import.meta.url);

const iso = (d: unknown): string | null => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export async function buildExpectedDoc(documentId: string): Promise<ExpectedDoc | { skipped: string }> {
  const [doc] = await sql`
    SELECT document_type, identity_status, lab_name, collected_on, patient_name_on_report, lab_patient_ref
    FROM documents WHERE id = ${documentId}`;
  if (!doc) return { skipped: "document not found" };
  if (isHeldIdentityStatus(doc.identity_status)) return { skipped: "document is held or rejected" };

  const facts: Record<string, any>[] = await sql`
    SELECT f.id, f.field_type, f.value, f.unit, f.reference_range, f.as_of_date, f.source_page, f.check_state, f.excluded_at,
           f.raw_marker_label, tm.marker_name,
           (SELECT (CASE WHEN jsonb_typeof(a.after_value) = 'string' THEN (a.after_value #>> '{}')::jsonb ELSE a.after_value END)->>'raw_marker_label'
             FROM audit_log a
             WHERE a.entity_type = 'fact' AND a.entity_id = f.id AND a.action = 'upload'
             ORDER BY a.created_at ASC LIMIT 1) AS upload_raw_label
    FROM facts f LEFT JOIN tracked_markers tm ON tm.id = f.tracked_marker_id
    WHERE f.document_id = ${documentId}
    ORDER BY f.source_page NULLS LAST, f.id`;
  const live = facts.filter((f) => f.excluded_at === null);
  if (live.length === 0) return { skipped: "no non-excluded facts" };
  if (live.some((f) => f.check_state === "unchecked")) return { skipped: "has unchecked facts" };

  const header: NonNullable<ExpectedDoc["header"]> = {};
  if (doc.lab_name) header.labName = doc.lab_name;
  if (doc.collected_on) header.collectedOn = iso(doc.collected_on);
  if (doc.patient_name_on_report) header.patientName = doc.patient_name_on_report;
  if (doc.lab_patient_ref) header.labPatientRef = doc.lab_patient_ref;

  return ExpectedDocSchema.parse({
    documentType: doc.document_type,
    source: "real",
    keyOrigin: "spot_check",
    ...(Object.keys(header).length ? { header } : {}),
    facts: live.map((f) => ({
      fieldType: f.field_type,
      markerLabel: f.upload_raw_label ?? f.raw_marker_label ?? f.marker_name ?? null,
      canonicalMarker: f.marker_name ?? null,
      value: f.value,
      unit: f.unit,
      referenceRange: f.reference_range,
      asOfDate: iso(f.as_of_date),
      sourcePage: f.source_page,
    })),
  });
}

// Pairs a key with its OCR fixture when the stored file hash matches a file in docs/reports/.
export async function slugForDocument(documentId: string, fileSha256: string | null, reportsByHash: Map<string, string>): Promise<string> {
  const filename = fileSha256 ? reportsByHash.get(fileSha256) : undefined;
  return filename ? slugFor(filename) : `spotcheck-${documentId.slice(0, 8)}`;
}

async function hashReports(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const f of await readdir(REPORTS).catch(() => [] as string[])) {
    if (!/\.(pdf|jpe?g|png)$/i.test(f)) continue;
    const bytes = new Uint8Array(await Bun.file(fileURLToPath(new URL(f, REPORTS))).arrayBuffer());
    map.set(createHash("sha256").update(bytes).digest("hex"), f);
  }
  return map;
}

export async function main(): Promise<void> {
  const docs = await sql`SELECT id, file_sha256 FROM documents ORDER BY uploaded_at`;
  const reportsByHash = await hashReports();
  await mkdir(fileURLToPath(OUT), { recursive: true });
  let exported = 0;
  let skipped = 0;
  let facts = 0;
  for (const d of docs) {
    const built = await buildExpectedDoc(d.id);
    if ("skipped" in built) {
      skipped++;
      continue;
    }
    const slug = await slugForDocument(d.id, d.file_sha256, reportsByHash);
    await Bun.write(new URL(`${slug}.expected.json`, OUT), JSON.stringify(built, null, 2));
    exported++;
    facts += built.facts.length;
  }
  console.log(`exported ${exported} documents (${facts} facts); skipped ${skipped}`);
}

if (import.meta.main) {
  await main();
  await sql.close();
}
