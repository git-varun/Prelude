import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { uploadDocument, runExtraction } from "./documents";
import { getPatientSnapshot, getPatientSummary, listPatients } from "./patients";
import { listOutsideEncounters } from "./visits";
import { loadDeltaBaselines, deltaKey } from "../services/delta";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";
import type { ExtractedFactCandidate } from "@prelude/shared";

delete process.env.OCR_PROVIDER;
delete process.env.EXTRACTION_PROVIDER;

let staff: TestUser;
let onc: TestUser;
let patientId: string;
let hereVisitId: string; // 2026-02-01
let currentVisitId: string; // 2026-03-01
let markerId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "outside-staff");
  onc = await createTestUser("oncologist", "outside-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: hereVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: currentVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
  [{ id: markerId }] = await sql`INSERT INTO tracked_markers (patient_id, marker_name, added_by, is_pinned, pinned_by, pinned_at) VALUES (${patientId}, 'CEA', ${staff.id}, true, ${onc.id}, now()) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, onc.id);
});

function uploadReq(fields: Record<string, string>) {
  const form = new FormData();
  form.set("visit_id", currentVisitId);
  form.set("document_type", "blood");
  form.set("source_origin", "outside_paper");
  form.set("file", new File([crypto.randomUUID()], "a.pdf", { type: "application/pdf" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const req = new Request(`http://localhost/patients/${patientId}/documents`, { method: "POST", body: form }) as Request & { params: { id: string } };
  req.params = { id: patientId };
  return req;
}
const encounterCount = async () => (await sql`SELECT count(*)::int AS n FROM outside_encounters WHERE patient_id = ${patientId}`)[0]!.n as number;
const documentCount = async () => (await sql`SELECT count(*)::int AS n FROM documents WHERE patient_id = ${patientId}`)[0]!.n as number;

test("an outside upload without both a date and a facility is refused and creates nothing", async () => {
  const docsBefore = await documentCount();
  for (const fields of <Record<string, string>[]>[
    { outside: "true" },
    { outside: "true", outside_date: "2026-02-10" },
    { outside: "true", outside_facility: "Apollo" },
    { outside: "true", outside_date: "2026-02-10", outside_facility: "   " },
    { outside: "true", outside_date: "10/02/2026", outside_facility: "Apollo" },
    { outside: "true", outside_date: "2026-02-31", outside_facility: "Apollo" },
  ]) {
    const res = await uploadDocument(uploadReq(fields), asAuthedUser(staff));
    expect(res.status).toBe(400);
  }
  expect(await encounterCount()).toBe(0);
  expect(await documentCount()).toBe(docsBefore);
});

test("date and facility without the explicit outside option never create an encounter", async () => {
  const res = await uploadDocument(uploadReq({ outside_date: "2026-02-10", outside_facility: "Apollo" }), asAuthedUser(staff));
  expect(res.status).toBe(201);
  expect(((await res.json()) as any).outside_encounter_id).toBeNull();
  expect(await encounterCount()).toBe(0);
});

test("a confirmed outside upload creates the encounter with an audit row; the same visit is reused", async () => {
  const res = await uploadDocument(uploadReq({ outside: "true", outside_date: "2026-02-10", outside_facility: " Apollo Hospital " }), asAuthedUser(staff));
  expect(res.status).toBe(201);
  const doc = (await res.json()) as any;
  expect(doc.outside_encounter_id).toBeTruthy();
  const [enc] = await sql`SELECT *, to_char(encounter_date, 'YYYY-MM-DD') AS d FROM outside_encounters WHERE id = ${doc.outside_encounter_id}`;
  expect(enc.facility).toBe("Apollo Hospital");
  expect(enc.d).toBe("2026-02-10");
  expect(enc.confirmed_by).toBe(staff.id);
  const audits = await sql`SELECT * FROM audit_log WHERE entity_type = 'outside_encounter' AND entity_id = ${enc.id}`;
  expect(audits).toHaveLength(1);
  expect(audits[0]!.action).toBe("confirm_outside_encounter");

  const again = (await (await uploadDocument(uploadReq({ outside: "true", outside_date: "2026-02-10", outside_facility: "APOLLO hospital" }), asAuthedUser(staff))).json()) as any;
  expect(again.outside_encounter_id).toBe(doc.outside_encounter_id);
  expect(await encounterCount()).toBe(1);

  await uploadDocument(uploadReq({ outside: "true", outside_date: "2026-02-11", outside_facility: "Apollo Hospital" }), asAuthedUser(staff));
  expect(await encounterCount()).toBe(2);
});

test("facts persisted from an outside document inherit the encounter and keep their upload visit", async () => {
  const [doc] = await sql`SELECT * FROM documents WHERE patient_id = ${patientId} AND outside_encounter_id IS NOT NULL LIMIT 1`;
  const candidate: ExtractedFactCandidate = {
    fieldType: "radiology_impression", value: "Stable", unit: null, referenceRange: null, asOfDate: "2026-02-10",
    coverageStatus: "value_found", sourcePage: 1, sourceLocation: null, sourceSnippet: null, confidence: 0.9,
  };
  await runExtraction(doc as any, "blood", { fullText: "x", pages: [], providerName: "test" }, staff.id, null,
    { name: "fake", extractFacts: async () => ({ candidates: [candidate], failedFieldTypes: [], failureMessages: {} }) });
  const [fact] = await sql`SELECT visit_id, outside_encounter_id FROM facts WHERE document_id = ${doc!.id}`;
  expect(fact!.visit_id).toBe(currentVisitId);
  expect(fact!.outside_encounter_id).toBe(doc!.outside_encounter_id);
});

let currentFactId: string;
let outsideEncId: string;

async function seedFact(visitId: string, value: string, asOf: string, o: { signed?: boolean; encId?: string | null; identity?: string | null } = {}) {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status, outside_encounter_id)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', ${o.identity ?? null}::identity_status, ${o.encId ?? null}) RETURNING id`;
  const signed = o.signed ?? false;
  const [f] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date, coverage_status,
      verification_state, signed_off_by, outside_encounter_id)
    VALUES (${patientId}, ${visitId}, ${doc!.id}, ${markerId}, 'marker_value', ${value}, 'ng/mL', ${asOf}, 'value_found',
      ${signed ? "oncologist_signed_off" : "unverified"}, ${signed ? onc.id : null}, ${o.encId ?? null}) RETURNING id`;
  return f!.id as string;
}

function snapReq(query = "") {
  const req = new Request(`http://localhost/patients/${patientId}/snapshot${query}`) as Request & { params: { id: string } };
  req.params = { id: patientId };
  return req;
}

test("compare=here ignores signed-off facts from visits elsewhere; compare=any uses the latest anywhere, even when uploaded under the current visit", async () => {
  [{ id: outsideEncId }] = await sql`INSERT INTO outside_encounters (patient_id, encounter_date, facility, confirmed_by) VALUES (${patientId}, '2026-02-20', 'Max Hospital', ${staff.id}) RETURNING id`;
  await seedFact(hereVisitId, "3.0", "2026-02-01", { signed: true });
  // The real flow: the outside report is uploaded under TODAY'S visit, so its facts carry the current visit_id.
  await seedFact(currentVisitId, "8.0", "2026-02-20", { signed: true, encId: outsideEncId });
  currentFactId = await seedFact(currentVisitId, "9.0", "2026-03-01");

  const here = await loadDeltaBaselines(patientId, "2026-03-01");
  expect(here.get(deltaKey("marker_value", markerId))?.value).toBe("3.0");
  const any = await loadDeltaBaselines(patientId, "2026-03-01", "any", currentVisitId);
  expect(any.get(deltaKey("marker_value", markerId))?.value).toBe("8.0");

  const defaultBody = (await (await getPatientSnapshot(snapReq())).json()) as any;
  expect(defaultBody.compare.mode).toBe("here");
  expect(defaultBody.compare.last_here).toEqual({ date: "2026-02-01" });
  // The 2026-02-20 Max Hospital visit is the latest outside encounter before the current visit (Apollo ones are 02-10/02-11).
  expect(defaultBody.compare.latest_any).toEqual({ facility: "Max Hospital", date: "2026-02-20" });
  const w = (b: any) => b.watchlist.find((x: any) => x.tracked_marker_id === markerId).latest.was.value;
  expect(w(defaultBody)).toBe("3.0");
  const anyBody = (await (await getPatientSnapshot(snapReq("?compare=any"))).json()) as any;
  expect(anyBody.compare.mode).toBe("any");
  expect(w(anyBody)).toBe("8.0");
  expect(anyBody.tumor_markers.find((m: any) => m.fact_id === currentFactId).delta_status).toBe("changed");

  expect((await getPatientSnapshot(snapReq("?compare=elsewhere"))).status).toBe(400);
});

test("a baseline from a held or excluded outside document never counts, even for compare=any", async () => {
  const heldEnc = (await sql`INSERT INTO outside_encounters (patient_id, encounter_date, facility, confirmed_by) VALUES (${patientId}, '2026-02-25', 'Held Clinic', ${staff.id}) RETURNING id`)[0]!.id as string;
  await seedFact(hereVisitId, "99", "2026-02-25", { signed: true, encId: heldEnc, identity: "mismatch" });
  const excludedFact = await seedFact(hereVisitId, "77", "2026-02-26", { signed: true, encId: heldEnc });
  await sql`UPDATE facts SET excluded_at = now(), check_state = 'incorrect', error_type = 'not_in_document' WHERE id = ${excludedFact}`;
  const any = await loadDeltaBaselines(patientId, "2026-03-01", "any", currentVisitId);
  expect(any.get(deltaKey("marker_value", markerId))?.value).toBe("8.0");
});

test("snapshot facts carry outside_encounter; facts from visits here carry null", async () => {
  await sql`UPDATE facts SET outside_encounter_id = ${outsideEncId} WHERE id = ${currentFactId}`;
  const body = (await (await getPatientSnapshot(snapReq())).json()) as any;
  const f = body.tumor_markers.find((m: any) => m.fact_id === currentFactId);
  expect(f.outside_encounter).toEqual({ id: outsideEncId, facility: "Max Hospital", date: "2026-02-20" });
  expect(body.watchlist.find((x: any) => x.tracked_marker_id === markerId).latest.outside_encounter.facility).toBe("Max Hospital");
  await sql`UPDATE facts SET outside_encounter_id = NULL WHERE id = ${currentFactId}`;
  const body2 = (await (await getPatientSnapshot(snapReq())).json()) as any;
  expect(body2.tumor_markers.find((m: any) => m.fact_id === currentFactId).outside_encounter).toBeNull();
});

test("summary items carry the encounter; held-document facts stay out", async () => {
  const diag = async (visitId: string, value: string, encId: string | null, identity: string | null = null) => {
    const [doc] = await sql`
      INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status, outside_encounter_id)
      VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'pathology', 'own_hospital', ${staff.id}, 'done', ${identity}::identity_status, ${encId}) RETURNING id`;
    await sql`
      INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, outside_encounter_id)
      VALUES (${patientId}, ${visitId}, ${doc!.id}, 'diagnosis', ${value}, '2026-02-20', 'value_found', ${encId})`;
  };
  await diag(hereVisitId, "Here dx", null);
  await diag(hereVisitId, "Elsewhere dx", outsideEncId);
  await diag(hereVisitId, "Held dx", outsideEncId, "mismatch");
  const req = new Request(`http://localhost/patients/${patientId}/summary`) as Request & { params: { id: string } };
  req.params = { id: patientId };
  const body = (await (await getPatientSummary(req)).json()) as any;
  const dx = body.disease_history.diagnosis;
  expect(dx.map((d: any) => d.text).sort()).toEqual(["Elsewhere dx", "Here dx"]);
  expect(dx.find((d: any) => d.text === "Elsewhere dx").outside_encounter).toEqual({ id: outsideEncId, facility: "Max Hospital", date: "2026-02-20" });
  expect(dx.find((d: any) => d.text === "Here dx").outside_encounter).toBeNull();
});

test("outside encounters are listed in date order with their document count, separate from visits", async () => {
  const req = new Request(`http://localhost/patients/${patientId}/outside-encounters`) as Request & { params: { id: string } };
  req.params = { id: patientId };
  const rows = (await (await listOutsideEncounters(req)).json()) as any[];
  const dates = rows.map((r) => r.encounter_date);
  expect(dates).toEqual([...dates].sort().reverse());
  const max = rows.find((r) => r.facility === "Max Hospital");
  expect(max.document_count).toBeGreaterThan(0);
  expect("signed_off_count" in max).toBe(false);
});

test("the patient list reports a visit elsewhere only when it is newer than the latest visit here", async () => {
  const find = async () => {
    const rows = (await (await listPatients(new Request("http://localhost/patients?limit=500"))).json()) as any[];
    return rows.find((r) => r.id === patientId);
  };
  expect((await find()).latest_elsewhere).toBeNull(); // newest outside is 2026-02-26, latest visit here is 2026-03-01
  await sql`INSERT INTO outside_encounters (patient_id, encounter_date, facility, confirmed_by) VALUES (${patientId}, '2026-04-02', 'Newer Clinic', ${staff.id})`;
  expect((await find()).latest_elsewhere).toEqual({ facility: "Newer Clinic", date: "2026-04-02" });
});

test("compare=any: signed-off here-facts of the current visit are never their own baseline", async () => {
  const own = await seedFact(currentVisitId, "55", "2026-03-02", { signed: true });
  // A later "current" date lets the date rule alone admit the visit's own fact; only the visit/origin exclusion keeps it out.
  const any = await loadDeltaBaselines(patientId, "2026-03-05", "any", currentVisitId);
  expect(any.get(deltaKey("marker_value", markerId))?.value).toBe("8.0");
  await sql`DELETE FROM facts WHERE id = ${own}`;
});

test("outside upload validation: impossible, ancient and future dates are 400 not 500; facility is capped", async () => {
  const before = await encounterCount();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  for (const outside_date of ["0000-01-01", "1899-12-31", tomorrow, "2999-01-01"]) {
    const res = await uploadDocument(uploadReq({ outside: "true", outside_date, outside_facility: "Apollo" }), asAuthedUser(staff));
    expect(res.status).toBe(400);
  }
  const future = await uploadDocument(uploadReq({ outside: "true", outside_date: tomorrow, outside_facility: "Apollo" }), asAuthedUser(staff));
  expect(((await future.json()) as any).message).toBe("Date must be a real date not in the future");
  const long = await uploadDocument(uploadReq({ outside: "true", outside_date: "2026-02-10", outside_facility: "x".repeat(121) }), asAuthedUser(staff));
  expect(long.status).toBe(400);
  const ok = await uploadDocument(uploadReq({ outside: "true", outside_date: "2026-02-10", outside_facility: "y".repeat(120) }), asAuthedUser(staff));
  expect(ok.status).toBe(201);
  expect(await encounterCount()).toBe(before + 1);
});

test("two spellings of a facility differing only in inner whitespace share one encounter", async () => {
  const a = (await (await uploadDocument(uploadReq({ outside: "true", outside_date: "2026-01-05", outside_facility: "City  General   Hospital" }), asAuthedUser(staff))).json()) as any;
  const b = (await (await uploadDocument(uploadReq({ outside: "true", outside_date: "2026-01-05", outside_facility: " city general hospital " }), asAuthedUser(staff))).json()) as any;
  expect(a.outside_encounter_id).toBeTruthy();
  expect(b.outside_encounter_id).toBe(a.outside_encounter_id);
  const [enc] = await sql`SELECT facility FROM outside_encounters WHERE id = ${a.outside_encounter_id}`;
  expect(enc!.facility).toBe("City General Hospital");
});
