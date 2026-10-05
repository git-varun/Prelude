import { sql } from "./client";
import { DISEASE_SITE_PANELS } from "@prelude/shared";

async function upsertUser(name: string, email: string, password: string, role: "staff" | "oncologist") {
  const password_hash = await Bun.password.hash(password);
  const rows = await sql`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (${name}, ${email}, ${password_hash}, ${role})
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id, name, email, role
  `;
  console.log("seeded user:", rows[0]);
  return rows[0] as { id: string; name: string; email: string; role: string };
}

const staff = await upsertUser("Dev Staff", "staff@opd.local", "staff-password", "staff");
const oncologist = await upsertUser("Dev Oncologist", "oncologist@opd.local", "onc-password", "oncologist");

// One demo patient per disease-site panel, for the walkthrough demo — realistic
// multi-visit values (an older signed-off visit establishing a delta baseline, plus
// a current visit), with a few values deliberately outside the reference range to
// demonstrate the out-of-range pill (docs/M5).
interface MarkerDemoData {
  unit: string;
  range: string;
  baseline: string;
  current: string;
}

const MARKER_DEMO_DATA: Record<string, MarkerDemoData> = {
  "CEA": { unit: "ng/mL", range: "0-5", baseline: "3.0", current: "3.2" },
  "CA 19-9": { unit: "U/mL", range: "0-37", baseline: "20", current: "25" },
  "CA-125": { unit: "U/mL", range: "0-35", baseline: "18", current: "18" },
  "CA 15-3": { unit: "U/mL", range: "0-30", baseline: "15", current: "15" },
  "AFP": { unit: "ng/mL", range: "0-10", baseline: "4", current: "4" },
  "Total PSA": { unit: "ng/mL", range: "0-4", baseline: "2.1", current: "2.3" },
  "Beta-hCG": { unit: "mIU/mL", range: "<5", baseline: "1", current: "1" },
  "LDH": { unit: "U/L", range: "140-280", baseline: "200", current: "210" },
  "HE4": { unit: "pmol/L", range: "<140", baseline: "80", current: "90" },
  "CA 72-4": { unit: "U/mL", range: "0-6.9", baseline: "3", current: "3" },
  "Thyroglobulin (Tg)": { unit: "ng/mL", range: "0-55", baseline: "20", current: "20" },
  "Anti-Tg (TgAb)": { unit: "IU/mL", range: "0-4.5", baseline: "2", current: "2" },
  "Calcitonin": { unit: "pg/mL", range: "0-10", baseline: "5", current: "5" },
};

// A few deliberately out-of-range current values, keyed by "<site>::<marker>".
const OUT_OF_RANGE_OVERRIDES: Record<string, string> = {
  "Colorectal/Lower GI::CEA": "8.5",
  "Urologic::Total PSA": "6.0",
  "Gynecologic::CA-125": "42",
};

async function seedDemoPatient(site: string, markers: readonly string[]) {
  const name = `Demo — ${site}`;
  const [existing] = await sql`SELECT id FROM patients WHERE name = ${name}`;
  if (existing) {
    console.log(`skipped (already seeded): ${name}`);
    return;
  }

  const [patient] = await sql`
    INSERT INTO patients (name, cancer_type, created_by) VALUES (${name}, ${site}, ${staff.id}) RETURNING id
  `;

  const [oldVisit] = await sql`
    INSERT INTO visits (patient_id, visit_date) VALUES (${patient.id}, '2026-01-15') RETURNING id
  `;
  const [currentVisit] = await sql`
    INSERT INTO visits (patient_id, visit_date) VALUES (${patient.id}, '2026-03-15') RETURNING id
  `;
  const [oldDoc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patient.id}, ${oldVisit.id}, 'local://seed/old.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id
  `;
  const [currentDoc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patient.id}, ${currentVisit.id}, 'local://seed/current.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id
  `;

  for (const marker of markers) {
    const data = MARKER_DEMO_DATA[marker]!;
    const [tracked] = await sql`
      INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
      VALUES (${patient.id}, ${marker}, false, ${staff.id}) RETURNING id
    `;

    await sql`
      INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit,
        reference_range, as_of_date, coverage_status, verification_state, signed_off_by, signed_off_at)
      VALUES (${patient.id}, ${oldVisit.id}, ${oldDoc.id}, ${tracked.id}, 'marker_value', ${data.baseline}, ${data.unit},
        ${data.range}, '2026-01-15', 'value_found', 'oncologist_signed_off', ${oncologist.id}, now())
    `;

    const currentValue = OUT_OF_RANGE_OVERRIDES[`${site}::${marker}`] ?? data.current;
    await sql`
      INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit,
        reference_range, as_of_date, coverage_status, verification_state)
      VALUES (${patient.id}, ${currentVisit.id}, ${currentDoc.id}, ${tracked.id}, 'marker_value', ${currentValue}, ${data.unit},
        ${data.range}, '2026-03-15', 'value_found', 'unverified')
    `;
  }

  console.log(`seeded demo patient: ${name} (${markers.length} markers)`);
}

for (const [site, markers] of Object.entries(DISEASE_SITE_PANELS)) {
  await seedDemoPatient(site, markers);
}

console.log("Seed complete.");
process.exit(0);
