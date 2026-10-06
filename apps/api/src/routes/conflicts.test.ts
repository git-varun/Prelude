import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getConflict, annotateConflict, resolveConflict } from "./conflicts";
import { signOffFact } from "./facts";
import { getPatientSnapshot } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;
let documentId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "conflicts-route-staff");
  oncologist = await createTestUser("oncologist", "conflicts-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: documentId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newFact(value: string): Promise<string> {
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visitId}, ${documentId}, 'treatment_regimen', ${value}, '2026-02-01', 'conflicting_sources', 'unverified')
    RETURNING id`;
  return row.id;
}

async function newConflict(status: "open" | "annotated" | "resolved" = "open"): Promise<{ id: string; a: string; b: string }> {
  const a = await newFact("FOLFOX");
  const b = await newFact("FOLFIRI");
  const [row] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, ${status}) RETURNING id`;
  return { id: row.id, a, b };
}

function req(id: string, body?: unknown) {
  const r = new Request(`http://localhost/conflicts/${id}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) as Request & {
    params: { id: string };
  };
  r.params = { id };
  return r;
}

async function conflictRow(id: string) {
  const [row] = await sql`SELECT * FROM conflicts WHERE id = ${id}`;
  return row;
}

// --- GET /conflicts/:id ---

test("GET returns the conflict with both facts", async () => {
  const { id, a, b } = await newConflict();
  const res = await getConflict(req(id), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.conflict.id).toBe(id);
  expect([body.fact_a.id, body.fact_b.id].sort()).toEqual([a, b].sort());
});

test("GET 404s for an unknown conflict", async () => {
  const res = await getConflict(req("00000000-0000-0000-0000-000000000000"), asAuthedUser(staff));
  expect(res.status).toBe(404);
});

// --- POST /conflicts/:id/annotate ---

test("annotate moves open -> annotated and sets annotation_note", async () => {
  const { id } = await newConflict("open");
  const res = await annotateConflict(req(id, { annotation_note: "Checked with referring clinic." }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await conflictRow(id);
  expect(row.status).toBe("annotated");
  expect(row.annotation_note).toBe("Checked with referring clinic.");
  expect(row.resolution_note).toBeNull();
});

test("annotate is allowed for an oncologist too", async () => {
  const { id } = await newConflict("open");
  const res = await annotateConflict(req(id, { annotation_note: "Looks like a transcription error." }), asAuthedUser(oncologist));
  expect(res.status).toBe(200);
  expect((await conflictRow(id)).status).toBe("annotated");
});

test("annotate requires a non-empty annotation_note", async () => {
  const { id } = await newConflict("open");
  const res = await annotateConflict(req(id, {}), asAuthedUser(staff));
  expect(res.status).toBe(400);
  expect((await conflictRow(id)).status).toBe("open");
});

test("annotate 409s on an already-annotated conflict", async () => {
  const { id } = await newConflict("annotated");
  const res = await annotateConflict(req(id, { annotation_note: "Second pass." }), asAuthedUser(staff));
  expect(res.status).toBe(409);
});

test("annotate 409s on a resolved conflict", async () => {
  const { id } = await newConflict("resolved");
  const res = await annotateConflict(req(id, { annotation_note: "Too late." }), asAuthedUser(staff));
  expect(res.status).toBe(409);
});

test("annotate 404s for an unknown conflict", async () => {
  const res = await annotateConflict(req("00000000-0000-0000-0000-000000000000", { annotation_note: "x" }), asAuthedUser(staff));
  expect(res.status).toBe(404);
});

// --- POST /conflicts/:id/resolve ---

test("resolve with authoritative_fact_id sets value_found on the winner only and leaves the loser's coverage_status alone", async () => {
  const { id, a, b } = await newConflict("open");
  const res = await resolveConflict(req(id, { authoritative_fact_id: a }), asAuthedUser(oncologist));
  expect(res.status).toBe(200);

  const row = await conflictRow(id);
  expect(row.status).toBe("resolved");
  expect(row.authoritative_fact_id).toBe(a);
  expect(row.resolved_by).toBe(oncologist.id);
  expect(row.resolved_at).not.toBeNull();
  expect(row.resolution_note).not.toBeNull();

  const [factA] = await sql`SELECT coverage_status FROM facts WHERE id = ${a}`;
  const [factB] = await sql`SELECT coverage_status FROM facts WHERE id = ${b}`;
  expect(factA.coverage_status).toBe("value_found");
  expect(factB.coverage_status).toBe("conflicting_sources");
});

test("resolve with both_stand sets value_found on both facts", async () => {
  const { id, a, b } = await newConflict("annotated");
  const res = await resolveConflict(req(id, { both_stand: true }), asAuthedUser(oncologist));
  expect(res.status).toBe(200);

  expect((await conflictRow(id)).authoritative_fact_id).toBeNull();
  const [factA] = await sql`SELECT coverage_status FROM facts WHERE id = ${a}`;
  const [factB] = await sql`SELECT coverage_status FROM facts WHERE id = ${b}`;
  expect(factA.coverage_status).toBe("value_found");
  expect(factB.coverage_status).toBe("value_found");
});

test("resolve rejects an authoritative_fact_id that isn't part of the pair", async () => {
  const { id } = await newConflict("open");
  const other = await newFact("unrelated");
  const res = await resolveConflict(req(id, { authoritative_fact_id: other }), asAuthedUser(oncologist));
  expect(res.status).toBe(400);
  expect((await conflictRow(id)).status).toBe("open");
});

test("resolve rejects a body with neither authoritative_fact_id nor both_stand", async () => {
  const { id } = await newConflict("open");
  const res = await resolveConflict(req(id, {}), asAuthedUser(oncologist));
  expect(res.status).toBe(400);
});

test("resolve 409s on an already-resolved conflict", async () => {
  const { id, a } = await newConflict("resolved");
  const res = await resolveConflict(req(id, { authoritative_fact_id: a }), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
});

test("resolve 404s for an unknown conflict", async () => {
  const res = await resolveConflict(req("00000000-0000-0000-0000-000000000000", { both_stand: true }), asAuthedUser(oncologist));
  expect(res.status).toBe(404);
});

test("annotate and resolve each write an audit_log row", async () => {
  const { id, a } = await newConflict("open");
  await annotateConflict(req(id, { annotation_note: "note" }), asAuthedUser(staff));
  await resolveConflict(req(id, { authoritative_fact_id: a }), asAuthedUser(oncologist));

  const rows = await sql`SELECT action, actor_id FROM audit_log WHERE entity_type = 'conflict' AND entity_id = ${id} ORDER BY created_at`;
  expect(rows.map((r: any) => r.action)).toEqual(["annotate_conflict", "resolve_conflict"]);
  expect(rows[0].actor_id).toBe(staff.id);
  expect(rows[1].actor_id).toBe(oncologist.id);
});

// --- Integration: resolving unblocks sign-off and removes the loser from the snapshot ---

test("integration: an authoritative-pick loser disappears from the next GET /patients/:id/snapshot, and the blocked fact becomes signable once resolved", async () => {
  const a = await newFact("FOLFOX");
  const b = await newFact("FOLFIRI");
  const [{ id: conflictId }] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open') RETURNING id`;

  const signOffReq = (id: string) => {
    const r = new Request(`http://localhost/facts/${id}/sign-off`, { method: "POST" }) as Request & { params: { id: string } };
    r.params = { id };
    return r;
  };
  expect((await signOffFact(signOffReq(a), asAuthedUser(oncologist))).status).toBe(409);

  const res = await resolveConflict(req(conflictId, { authoritative_fact_id: a }), asAuthedUser(oncologist));
  expect(res.status).toBe(200);

  const signOffRes = await signOffFact(signOffReq(a), asAuthedUser(oncologist));
  expect(signOffRes.status).toBe(200);

  const snapshotRes = await getPatientSnapshot(
    (() => {
      const r = new Request(`http://localhost/patients/${patientId}/snapshot`) as Request & { params: { id: string } };
      r.params = { id: patientId };
      return r;
    })(),
  );
  const snapshot = await snapshotRes.json();
  const treatmentFactIds = snapshot.current_treatment.map((f: any) => f.fact_id);
  expect(treatmentFactIds).toContain(a);
  expect(treatmentFactIds).not.toContain(b);
});
