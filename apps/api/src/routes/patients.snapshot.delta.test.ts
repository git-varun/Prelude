import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientSnapshot } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let oldVisitId: string; // 2026-01-01
let previousVisitId: string; // 2026-02-01
let currentVisitId: string; // 2026-03-01

beforeAll(async () => {
  staff = await createTestUser("staff", "delta-route-staff");
  oncologist = await createTestUser("oncologist", "delta-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: oldVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: previousVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: currentVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newMarker(name: string, isCustom = false): Promise<string> {
  const [{ id }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, ${name}, ${isCustom}, ${staff.id}) RETURNING id`;
  return id;
}

async function newDocument(visitId: string, documentType: "blood" | "prescription" | "radiology" = "blood"): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', ${documentType}, 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(visitId: string, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    fieldType: "marker_value", value: "4.2", asOf: "2026-01-01", verification: "unverified",
    markerId: null as string | null, documentType: "blood" as "blood" | "prescription" | "radiology", ...o,
  };
  const docId = await newDocument(visitId, f.documentType);
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, as_of_date,
      coverage_status, verification_state, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${docId}, ${f.markerId}, ${f.fieldType}, ${f.value},
      ${f.asOf}, 'value_found', ${f.verification}, ${f.verification === "oncologist_signed_off" ? oncologist.id : null})
    RETURNING id`;
  return row.id;
}

function snapshotReq(id: string) {
  const req = new Request(`http://localhost/patients/${id}/snapshot`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

async function markerEntry(markerId: string) {
  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  return body.tumor_markers.find((m: any) => m.tracked_marker_id === markerId);
}

test("a current-visit fact with no prior signed-off fact for that marker gets delta_status 'new' and appears in since_last_visit", async () => {
  const m = await newMarker("Marker-New");
  await newFact(currentVisitId, { markerId: m, asOf: "2026-03-01", value: "1.0" });

  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  const entry = body.tumor_markers.find((x: any) => x.tracked_marker_id === m);
  expect(entry.delta_status).toBe("new");
  expect(body.since_last_visit.some((e: any) => e.tracked_marker_id === m)).toBe(true);
});

test("a current-visit fact whose value matches the most recent prior signed-off fact gets 'unchanged' and is excluded from since_last_visit", async () => {
  const m = await newMarker("Marker-Unchanged");
  await newFact(previousVisitId, { markerId: m, asOf: "2026-02-01", value: "same", verification: "oncologist_signed_off" });
  await newFact(currentVisitId, { markerId: m, asOf: "2026-03-01", value: "same" });

  const entry = await markerEntry(m);
  expect(entry.delta_status).toBe("unchanged");
  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  expect(body.since_last_visit.some((e: any) => e.tracked_marker_id === m)).toBe(false);
});

test("a current-visit fact whose value differs from the most recent prior signed-off fact gets 'changed' and appears in since_last_visit", async () => {
  const m = await newMarker("Marker-Changed");
  await newFact(previousVisitId, { markerId: m, asOf: "2026-02-01", value: "old", verification: "oncologist_signed_off" });
  await newFact(currentVisitId, { markerId: m, asOf: "2026-03-01", value: "new" });

  const entry = await markerEntry(m);
  expect(entry.delta_status).toBe("changed");
  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  expect(body.since_last_visit.some((e: any) => e.tracked_marker_id === m)).toBe(true);
});

test("delta reaches back past a visit with no signed-off fact for that marker to an earlier one (patient history isn't visit-bounded)", async () => {
  const m = await newMarker("Marker-Reach-Back");
  await newFact(oldVisitId, { markerId: m, asOf: "2026-01-01", value: "reach-me", verification: "oncologist_signed_off" });
  // previousVisitId intentionally has no fact for this marker at all.
  await newFact(currentVisitId, { markerId: m, asOf: "2026-03-01", value: "reach-me" });

  const entry = await markerEntry(m);
  expect(entry.delta_status).toBe("unchanged");
});

test("an unverified current-visit fact still gets a delta_status computed against a signed-off baseline", async () => {
  const m = await newMarker("Marker-Unverified-Current");
  await newFact(previousVisitId, { markerId: m, asOf: "2026-02-01", value: "base", verification: "oncologist_signed_off" });
  await newFact(currentVisitId, { markerId: m, asOf: "2026-03-01", value: "base", verification: "unverified" });

  const entry = await markerEntry(m);
  expect(entry.verification_state).toBe("unverified");
  expect(entry.delta_status).toBe("unchanged");
});

test("an unsigned prior fact never serves as a delta baseline", async () => {
  const m = await newMarker("Marker-Unsigned-Baseline");
  await newFact(previousVisitId, { markerId: m, asOf: "2026-02-01", value: "unsigned", verification: "unverified" });
  await newFact(currentVisitId, { markerId: m, asOf: "2026-03-01", value: "unsigned" });

  const entry = await markerEntry(m);
  expect(entry.delta_status).toBe("new");
});

test("a tracked marker signed off previously but absent from the current visit synthesizes not_found_in_document_set with delta_status not_observed_in_current_document_set", async () => {
  const m = await newMarker("Marker-Now-Missing");
  await newFact(previousVisitId, { markerId: m, asOf: "2026-02-01", value: "was-here", verification: "oncologist_signed_off" });

  const entry = await markerEntry(m);
  expect(entry.fact_id).toBeNull();
  expect(entry.coverage_status).toBe("not_found_in_document_set");
  expect(entry.verification_state).toBeNull();
  expect(entry.delta_status).toBe("not_observed_in_current_document_set");
  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  expect(body.since_last_visit.some((e: any) => e.tracked_marker_id === m)).toBe(true);
});

test("a custom marker gets identical delta treatment to a controlled one, matched purely by tracked_marker_id", async () => {
  const controlled = await newMarker("CA-Custom-Compare", false);
  const custom = await newMarker("Totally Custom Marker", true);
  for (const m of [controlled, custom]) {
    await newFact(previousVisitId, { markerId: m, asOf: "2026-02-01", value: "base", verification: "oncologist_signed_off" });
    await newFact(currentVisitId, { markerId: m, asOf: "2026-03-01", value: "changed-value" });
  }

  const [controlledEntry, customEntry] = await Promise.all([markerEntry(controlled), markerEntry(custom)]);
  expect(customEntry.delta_status).toBe(controlledEntry.delta_status);
  expect(customEntry.delta_status).toBe("changed");
});

test("current_treatment signed off previously but absent from the current visit synthesizes a not_observed entry", async () => {
  await newFact(previousVisitId, {
    fieldType: "treatment_regimen", documentType: "prescription", asOf: "2026-02-01",
    value: "Old regimen", verification: "oncologist_signed_off",
  });

  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  expect(body.current_treatment).toHaveLength(1);
  expect(body.current_treatment[0].fact_id).toBeNull();
  expect(body.current_treatment[0].field_type).toBe("treatment_regimen");
  expect(body.current_treatment[0].coverage_status).toBe("not_found_in_document_set");
  expect(body.current_treatment[0].delta_status).toBe("not_observed_in_current_document_set");
});

test("radiology signed off previously but absent from the current visit synthesizes a not_observed entry", async () => {
  await newFact(previousVisitId, {
    fieldType: "radiology_impression", documentType: "radiology", asOf: "2026-02-01",
    value: "Old impression", verification: "oncologist_signed_off",
  });

  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  expect(body.radiology).toHaveLength(1);
  expect(body.radiology[0].fact_id).toBeNull();
  expect(body.radiology[0].field_type).toBe("radiology_impression");
  expect(body.radiology[0].delta_status).toBe("not_observed_in_current_document_set");
});

test("current_treatment stays [] when nothing was ever signed off and nothing exists in the current visit", async () => {
  const freshPatient = await createTestPatient(staff.id);
  await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${freshPatient.id}, '2026-01-01')`;
  try {
    const body = (await (await getPatientSnapshot(snapshotReq(freshPatient.id))).json()) as any;
    expect(body.current_treatment).toEqual([]);
    expect(body.radiology).toEqual([]);
  } finally {
    await deleteTestPatients(freshPatient.id);
  }
});

test("with zero prior visits, every field is 'new'", async () => {
  const freshPatient = await createTestPatient(staff.id);
  const [{ id: freshVisit }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${freshPatient.id}, '2026-01-01') RETURNING id`;
  const [{ id: freshMarker }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${freshPatient.id}, 'CEA', false, ${staff.id}) RETURNING id`;
  const docId = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${freshPatient.id}, ${freshVisit}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`.then((r) => r[0].id);
  await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, as_of_date, coverage_status, verification_state)
    VALUES (${freshPatient.id}, ${freshVisit}, ${docId}, ${freshMarker}, 'marker_value', '1.0', '2026-01-01', 'value_found', 'unverified')`;

  try {
    const body = (await (await getPatientSnapshot(snapshotReq(freshPatient.id))).json()) as any;
    const entry = body.tumor_markers.find((m: any) => m.tracked_marker_id === freshMarker);
    expect(entry.delta_status).toBe("new");
    expect(body.since_last_visit.some((e: any) => e.tracked_marker_id === freshMarker)).toBe(true);
  } finally {
    await deleteTestPatients(freshPatient.id);
  }
});

test("since_last_visit never includes an 'unchanged' or null-delta entry", async () => {
  const body = (await (await getPatientSnapshot(snapshotReq(patientId))).json()) as any;
  const all = [...body.current_treatment, ...body.tumor_markers, ...body.radiology];
  const byKey = new Map(all.map((e: any) => [`${e.field_type}:${e.tracked_marker_id ?? ""}:${e.fact_id ?? "null"}`, e]));
  for (const entry of body.since_last_visit) {
    expect(entry.delta_status).not.toBeNull();
    expect(entry.delta_status).not.toBe("unchanged");
    const key = `${entry.field_type}:${entry.tracked_marker_id ?? ""}:${entry.fact_id ?? "null"}`;
    expect(byKey.has(key)).toBe(true);
  }
});
