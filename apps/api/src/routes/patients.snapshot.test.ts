import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientSnapshot } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let previousVisitId: string;
let currentVisitId: string;
let ceaMarkerId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "snapshot-route-staff");
  oncologist = await createTestUser("oncologist", "snapshot-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: previousVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: currentVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: ceaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(visitId: string, documentType: "blood" | "prescription" | "radiology" = "blood"): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', ${documentType}, 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(documentId: string, visitId: string, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    fieldType: "marker_value", value: "4.2", asOf: "2026-02-01", coverage: "value_found", verification: "unverified",
    markerId: null as string | null, sourcePage: null as number | null, sourceLocation: null as string | null,
    sourceSnippet: null as string | null, signedOffBy: null as string | null, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value,
      as_of_date, coverage_status, verification_state, source_page, source_location, source_snippet, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${f.markerId}, ${f.fieldType}, ${f.value},
      ${f.asOf}, ${f.coverage}, ${f.verification}, ${f.sourcePage}, ${f.sourceLocation}, ${f.sourceSnippet}, ${f.signedOffBy})
    RETURNING id`;
  return row.id;
}

function snapshotReq(id: string) {
  const req = new Request(`http://localhost/patients/${id}/snapshot`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

test("404s for an unknown or malformed patient id", async () => {
  expect((await getPatientSnapshot(snapshotReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getPatientSnapshot(snapshotReq("not-a-uuid"))).status).toBe(404);
});

test("404s for a patient that exists but has no visits", async () => {
  const noVisitsPatient = await createTestPatient(staff.id);
  try {
    expect((await getPatientSnapshot(snapshotReq(noVisitsPatient.id))).status).toBe(404);
  } finally {
    await deleteTestPatients(noVisitsPatient.id);
  }
});

test("current_visit is the latest visit, previous_visit the one before it", async () => {
  const res = await getPatientSnapshot(snapshotReq(patientId));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.current_visit).toEqual({ id: currentVisitId, visit_date: "2026-02-01" });
  expect(body.previous_visit).toEqual({ id: previousVisitId, visit_date: "2026-01-01" });
  expect(body.patient.id).toBe(patientId);
});

test("a tracked marker with no fact in the current visit synthesizes a not_found_in_document_set entry, even if the previous visit had one", async () => {
  await newFact(await newDocument(previousVisitId), previousVisitId, { markerId: ceaMarkerId, asOf: "2026-01-01" });

  const res = await getPatientSnapshot(snapshotReq(patientId));
  const body = (await res.json()) as any;
  const marker = body.tumor_markers.find((m: any) => m.tracked_marker_id === ceaMarkerId);
  expect(marker).toBeDefined();
  expect(marker.fact_id).toBeNull();
  expect(marker.coverage_status).toBe("not_found_in_document_set");
  expect(marker.verification_state).toBeNull();
  expect(marker.delta_status).toBeNull();
  expect(marker.conflicts).toEqual([]);
  expect(marker.provenance).toBeNull();
  expect(marker.marker_name).toBe("CEA");
});

test("a real fact with no source_page/source_location gets provenance with fallback_level 'document'", async () => {
  const docId = await newDocument(currentVisitId);
  const factId = await newFact(docId, currentVisitId, { markerId: ceaMarkerId, asOf: "2026-02-01" });

  const res = await getPatientSnapshot(snapshotReq(patientId));
  const body = (await res.json()) as any;
  const marker = body.tumor_markers.find((m: any) => m.tracked_marker_id === ceaMarkerId);
  expect(marker.fact_id).toBe(factId);
  expect(marker.coverage_status).toBe("value_found");
  expect(marker.provenance).toEqual({
    document_id: docId,
    source_page: null,
    source_location: null,
    source_snippet: null,
    fallback_level: "document",
  });
});

test("a signed-off fact with page/location/snippet returns full provenance with fallback_level 'exact'", async () => {
  const docId = await newDocument(currentVisitId, "radiology");
  const factId = await newFact(docId, currentVisitId, {
    fieldType: "radiology_impression",
    value: "Stable disease",
    asOf: "2026-02-01",
    verification: "oncologist_signed_off",
    sourcePage: 3,
    sourceLocation: "line 12-14",
    sourceSnippet: "Impression: stable disease.",
    signedOffBy: oncologist.id,
  });

  const res = await getPatientSnapshot(snapshotReq(patientId));
  const body = (await res.json()) as any;
  const entry = body.radiology.find((r: any) => r.fact_id === factId);
  expect(entry).toBeDefined();
  expect(entry.verification_state).toBe("oncologist_signed_off");
  expect(entry.provenance).toEqual({
    document_id: docId,
    source_page: 3,
    source_location: "line 12-14",
    source_snippet: "Impression: stable disease.",
    fallback_level: "exact",
  });
});

test("current_treatment returns only the latest treatment_regimen fact by as_of_date, not a history array", async () => {
  const docId = await newDocument(currentVisitId, "prescription");
  await newFact(docId, currentVisitId, { fieldType: "treatment_regimen", value: "Older regimen", asOf: "2026-01-15" });
  const latestId = await newFact(docId, currentVisitId, { fieldType: "treatment_regimen", value: "Newer regimen", asOf: "2026-02-01" });

  const res = await getPatientSnapshot(snapshotReq(patientId));
  const body = (await res.json()) as any;
  expect(body.current_treatment).toHaveLength(1);
  expect(body.current_treatment[0].fact_id).toBe(latestId);
  expect(body.current_treatment[0].value).toBe("Newer regimen");
});

test("field object shape matches the contract exactly, for both a real and a synthesized entry", async () => {
  const expectedKeys = [
    "fact_id", "field_type", "tracked_marker_id", "marker_name", "value", "unit", "reference_range",
    "as_of_date", "coverage_status", "verification_state", "delta_status", "conflicts", "provenance",
  ].sort();

  const [{ id: unmappedMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'AFP', false, ${staff.id}) RETURNING id`;

  const res = await getPatientSnapshot(snapshotReq(patientId));
  const body = (await res.json()) as any;
  expect(Object.keys(body.tumor_markers[0]).sort()).toEqual(expectedKeys);
  const synthesized = body.tumor_markers.find((m: any) => m.tracked_marker_id === unmappedMarkerId);
  expect(synthesized).toBeDefined();
  expect(synthesized.fact_id).toBeNull();
  expect(Object.keys(synthesized).sort()).toEqual(expectedKeys);
});

test("an open conflict between two facts for the same marker surfaces both as top-level entries with populated conflicts arrays", async () => {
  const docId = await newDocument(currentVisitId);
  const [{ id: psaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'PSA', false, ${staff.id}) RETURNING id`;
  const a = await newFact(docId, currentVisitId, { markerId: psaMarkerId, value: "4.0", asOf: "2026-02-01" });
  const b = await newFact(docId, currentVisitId, { markerId: psaMarkerId, value: "9.0", asOf: "2026-02-01" });
  const [{ id: conflictId }] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open') RETURNING id`;

  try {
    const res = await getPatientSnapshot(snapshotReq(patientId));
    const body = (await res.json()) as any;
    const entries = body.tumor_markers.filter((m: any) => m.tracked_marker_id === psaMarkerId);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.conflicts).toHaveLength(1);
      expect(entry.conflicts[0].conflict_id).toBe(conflictId);
      expect(entry.conflicts[0].status).toBe("open");
      expect(entry.conflicts[0].historical).toBe(false);
      expect(entry.conflicts[0].authoritative_fact_id).toBeNull();
    }
    const aEntry = entries.find((e: any) => e.fact_id === a);
    expect(aEntry.conflicts[0].other_fact_id).toBe(b);
    expect(aEntry.conflicts[0].other_value).toBe("9.0");
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${conflictId}`;
  }
});

test("once a conflict resolves via authoritative pick, only the authoritative fact remains a top-level entry, tagged historical in its conflicts array", async () => {
  const docId = await newDocument(currentVisitId);
  const [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CA-125', false, ${staff.id}) RETURNING id`;
  const winner = await newFact(docId, currentVisitId, { markerId, value: "4.0", asOf: "2026-02-01" });
  const loser = await newFact(docId, currentVisitId, { markerId, value: "9.0", asOf: "2026-02-01" });
  const [{ id: conflictId }] = await sql`
    INSERT INTO conflicts (fact_id_a, fact_id_b, status, authoritative_fact_id) VALUES (${winner}, ${loser}, 'resolved', ${winner}) RETURNING id`;

  try {
    const res = await getPatientSnapshot(snapshotReq(patientId));
    const body = (await res.json()) as any;
    const entries = body.tumor_markers.filter((m: any) => m.tracked_marker_id === markerId);
    expect(entries).toHaveLength(1);
    expect(entries[0].fact_id).toBe(winner);
    expect(entries[0].conflicts).toHaveLength(1);
    expect(entries[0].conflicts[0].historical).toBe(true);
    expect(entries[0].conflicts[0].other_fact_id).toBe(loser);
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${conflictId}`;
  }
});

test("an open conflict between two facts for the same marker with DIFFERING dates still surfaces both as top-level entries (not just the later-dated one)", async () => {
  const docId = await newDocument(currentVisitId);
  const [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CA-19-9', false, ${staff.id}) RETURNING id`;
  const older = await newFact(docId, currentVisitId, { markerId, value: "4.0", asOf: "2026-01-20" });
  const newer = await newFact(docId, currentVisitId, { markerId, value: "9.0", asOf: "2026-02-01" });
  const [{ id: conflictId }] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${older}, ${newer}, 'open') RETURNING id`;

  try {
    const res = await getPatientSnapshot(snapshotReq(patientId));
    const body = (await res.json()) as any;
    const entries = body.tumor_markers.filter((m: any) => m.tracked_marker_id === markerId);
    expect(entries).toHaveLength(2);
    expect(entries.map((e: any) => e.fact_id).sort()).toEqual([newer, older].sort());
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${conflictId}`;
  }
});

test("an undated sibling never wins the top-level slot over a dated fact for the same marker", async () => {
  const docId = await newDocument(currentVisitId);
  const [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'HE4', false, ${staff.id}) RETURNING id`;
  await newFact(docId, currentVisitId, { markerId, value: "undated-value", asOf: null });
  const dated = await newFact(docId, currentVisitId, { markerId, value: "5.0", asOf: "2026-02-01" });

  const res = await getPatientSnapshot(snapshotReq(patientId));
  const body = (await res.json()) as any;
  const entries = body.tumor_markers.filter((m: any) => m.tracked_marker_id === markerId);
  expect(entries).toHaveLength(1);
  expect(entries[0].fact_id).toBe(dated);
});

test("radiology now selects only the single latest non-conflicted fact, matching current_treatment's rule (no longer lists every live fact)", async () => {
  const docId = await newDocument(currentVisitId, "radiology");
  const older = await newFact(docId, currentVisitId, { fieldType: "radiology_impression", value: "Older impression", asOf: "2026-01-05" });
  const latest = await newFact(docId, currentVisitId, { fieldType: "radiology_impression", value: "Newer impression", asOf: "2026-02-20" });

  const res = await getPatientSnapshot(snapshotReq(patientId));
  const body = (await res.json()) as any;
  const ours = body.radiology.filter((r: any) => r.fact_id === older || r.fact_id === latest);
  expect(ours).toHaveLength(1);
  expect(ours[0].fact_id).toBe(latest);
  expect(ours[0].value).toBe("Newer impression");
});
