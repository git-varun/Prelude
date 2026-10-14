import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientDocumentIdentity, listPatients } from "./patients";
import { setDocumentIdentityStatus } from "./documents";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let otherPatientId: string;
const docs: Record<string, string> = {};
const visitIds: Record<string, string> = {};

async function insertDoc(pid: string, key: string, identity: string | null, extra: { lab?: string; name?: string; uploaded?: string } = {}) {
  const v = { id: visitIds[pid] };
  const [d] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status, lab_name, patient_name_on_report, uploaded_at)
    VALUES (${pid}, ${v.id}, ${`local://t/secret-${key}.pdf`}, 'blood', 'own_hospital', ${staff.id}, 'done', ${identity}::identity_status,
            ${extra.lab ?? null}, ${extra.name ?? null}, ${extra.uploaded ?? "2026-03-01T00:00:00Z"})
    RETURNING id`;
  docs[key] = d.id;
}

beforeAll(async () => {
  staff = await createTestUser("staff", "ident-list-staff");
  oncologist = await createTestUser("oncologist", "ident-list-onc");
  patientId = (await createTestPatient(staff.id)).id;
  otherPatientId = (await createTestPatient(staff.id)).id;
  for (const pid of [patientId, otherPatientId]) {
    const [v] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${pid}, '2026-03-01') RETURNING id`;
    visitIds[pid] = v.id;
  }
  await insertDoc(patientId, "mismatch", "mismatch", { lab: "Lab A", name: "Someone Else", uploaded: "2026-03-02T00:00:00Z" });
  await insertDoc(patientId, "partial", "partial", { lab: "Lab B", name: "Test P.", uploaded: "2026-03-03T00:00:00Z" });
  await insertDoc(patientId, "matched", "matched");
  await insertDoc(patientId, "confirmed", "confirmed");
  await insertDoc(patientId, "rejected", "rejected");
  await insertDoc(patientId, "unknown", "unknown");
  await insertDoc(patientId, "live", null);
  await insertDoc(otherPatientId, "otherMismatch", "mismatch", { name: "Other Held" });
});

afterAll(async () => {
  await deleteTestPatients(patientId, otherPatientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

function req(path: string, params: Record<string, string>) {
  const r = new Request(`http://localhost${path}`) as Request & { params: Record<string, string> };
  r.params = params;
  return r;
}
const identity = (id: string) => getPatientDocumentIdentity(req(`/patients/${id}/documents/identity`, { id }) as any);

test("returns the patient's name and the mismatch, partial and confirmed documents, newest first", async () => {
  const res = await identity(patientId);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.patient_name).toBe("Test Patient");
  const byKey = (k: string) => body.documents.find((d: any) => d.id === docs[k]);
  expect(body.documents.map((d: any) => d.id).slice(0, 2)).toEqual([docs.partial, docs.mismatch]);
  expect(body.documents).toHaveLength(3);
  expect(byKey("mismatch").identity_status).toBe("mismatch");
  expect(byKey("mismatch").lab_name).toBe("Lab A");
  expect(byKey("mismatch").patient_name_on_report).toBe("Someone Else");
  expect(byKey("confirmed").identity_status).toBe("confirmed");
});

test("excludes matched, rejected, unknown and live (null) documents", async () => {
  const body = (await (await identity(patientId)).json()) as any;
  const ids = body.documents.map((d: any) => d.id);
  for (const k of ["matched", "rejected", "unknown", "live"]) expect(ids).not.toContain(docs[k]);
});

test("is scoped to the patient: another patient's held document is never returned", async () => {
  const body = (await (await identity(patientId)).json()) as any;
  expect(body.documents.map((d: any) => d.id)).not.toContain(docs.otherMismatch);
  const other = (await (await identity(otherPatientId)).json()) as any;
  expect(other.documents.map((d: any) => d.id)).toEqual([docs.otherMismatch]);
});

test("exposes exactly the whitelisted columns and never file_ref", async () => {
  const res = await identity(patientId);
  const text = JSON.stringify(await res.json());
  expect(text).not.toContain("file_ref");
  expect(text).not.toContain("local://");
  const body = JSON.parse(text);
  for (const d of body.documents) {
    expect(Object.keys(d).sort()).toEqual([
      "collected_on", "confirmed_at", "confirmed_by_name", "document_type", "id", "identity_status", "lab_name", "patient_name_on_report",
      "staff_identity_assessment", "staff_identity_at", "staff_identity_by_name", "staff_identity_note", "uploaded_at",
    ]);
  }
});

test("404 for a non-uuid and for an unknown patient", async () => {
  const bad = await identity("not-a-uuid");
  expect(bad.status).toBe(404);
  expect(((await bad.json()) as any).error).toBe("not_found");
  expect((await identity(crypto.randomUUID())).status).toBe(404);
});

test("held_document_count counts only mismatch documents per patient", async () => {
  const list = (await (await listPatients(new Request("http://localhost/patients?limit=500"))).json()) as any[];
  expect(list.find((p) => p.id === patientId).held_document_count).toBe(1); // partial is not held
  expect(list.find((p) => p.id === otherPatientId).held_document_count).toBe(1);
  const searched = (await (await listPatients(new Request("http://localhost/patients?search=Test&limit=500"))).json()) as any[];
  expect(searched.find((p) => p.id === patientId).held_document_count).toBe(1);
});

test("confirming or rejecting a held document removes it from the list and from the count", async () => {
  const act = (id: string, action: string) =>
    setDocumentIdentityStatus(
      Object.assign(new Request(`http://localhost/documents/${id}/identity`, { method: "POST", body: JSON.stringify({ action }) }), { params: { id } }),
      asAuthedUser(oncologist),
    );
  expect((await act(docs.mismatch!, "confirm")).status).toBe(200);
  let body = (await (await identity(patientId)).json()) as any;
  // Confirmed stays listed (the "Accepted with a name difference" list), with who confirmed it.
  const confirmed = body.documents.find((d: any) => d.id === docs.mismatch);
  expect(confirmed.identity_status).toBe("confirmed");
  expect(confirmed.confirmed_by_name).toBe("ident-list-onc");
  expect(body.documents.filter((d: any) => d.identity_status === "mismatch")).toEqual([]);
  const list = (await (await listPatients(new Request("http://localhost/patients?limit=500"))).json()) as any[];
  expect(list.find((p) => p.id === patientId).held_document_count).toBe(0);

  expect((await act(docs.otherMismatch!, "reject")).status).toBe(200);
  body = (await (await identity(otherPatientId)).json()) as any;
  expect(body.documents).toEqual([]);
});
