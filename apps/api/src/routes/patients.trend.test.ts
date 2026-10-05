import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getMarkerTrend } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;
let ceaMarkerId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "trend-route-staff");
  oncologist = await createTestUser("oncologist", "trend-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: ceaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    markerId: ceaMarkerId as string | null, value: "4.2", unit: "ng/mL", referenceRange: "0-5" as string | null,
    asOf: "2026-01-01", verification: "oncologist_signed_off", signedOffBy: oncologist.id as string | null, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, reference_range,
      as_of_date, coverage_status, verification_state, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${await newDocument()}, ${f.markerId}, 'marker_value', ${f.value}, ${f.unit}, ${f.referenceRange},
      ${f.asOf}, 'value_found', ${f.verification}, ${f.signedOffBy})
    RETURNING id`;
  return row.id;
}

function trendReq(patientId: string, trackedMarkerId: string) {
  const req = new Request(`http://localhost/patients/${patientId}/markers/${trackedMarkerId}/trend`) as Request & {
    params: { id: string; trackedMarkerId: string };
  };
  req.params = { id: patientId, trackedMarkerId };
  return req;
}

test("404s for an unknown patient or tracked marker", async () => {
  expect((await getMarkerTrend(trendReq("00000000-0000-0000-0000-000000000000", ceaMarkerId))).status).toBe(404);
  expect((await getMarkerTrend(trendReq(patientId, "00000000-0000-0000-0000-000000000000"))).status).toBe(404);
});

test("returns every oncologist_signed_off fact for the marker, ordered by as_of_date ascending", async () => {
  await newFact({ asOf: "2026-03-01", value: "5.0" });
  await newFact({ asOf: "2026-01-15", value: "3.0" });
  await newFact({ asOf: "2026-02-01", value: "4.0" });

  const res = await getMarkerTrend(trendReq(patientId, ceaMarkerId));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.marker_name).toBe("CEA");
  expect(body.points.map((p: any) => p.as_of_date)).toEqual(["2026-01-15", "2026-02-01", "2026-03-01"]);
  expect(body.points.map((p: any) => p.value)).toEqual(["3.0", "4.0", "5.0"]);
  expect(body.points[0]).toHaveProperty("fact_id");
  expect(body.points[0]).toHaveProperty("unit");
  expect(body.points[0]).toHaveProperty("visit_id");
  expect(body.points[0]).toHaveProperty("reference_range");
});

test("carries each point's own reference_range through, exactly as recorded", async () => {
  await newFact({ asOf: "2026-06-01", referenceRange: "0-5" });
  await newFact({ asOf: "2026-06-02", referenceRange: "0-6" });
  await newFact({ asOf: "2026-06-03", referenceRange: null });

  const res = await getMarkerTrend(trendReq(patientId, ceaMarkerId));
  const body = (await res.json()) as any;
  const byDate = Object.fromEntries(body.points.map((p: any) => [p.as_of_date, p.reference_range]));
  expect(byDate["2026-06-01"]).toBe("0-5");
  expect(byDate["2026-06-02"]).toBe("0-6");
  expect(byDate["2026-06-03"]).toBeNull();
});

test("excludes an unverified fact", async () => {
  await newFact({ asOf: "2026-04-01", verification: "unverified", signedOffBy: null });
  const res = await getMarkerTrend(trendReq(patientId, ceaMarkerId));
  const body = (await res.json()) as any;
  expect(body.points.some((p: any) => p.as_of_date === "2026-04-01")).toBe(false);
});

test("excludes a staff_corrected fact", async () => {
  await newFact({ asOf: "2026-04-02", verification: "staff_corrected", signedOffBy: null });
  const res = await getMarkerTrend(trendReq(patientId, ceaMarkerId));
  const body = (await res.json()) as any;
  expect(body.points.some((p: any) => p.as_of_date === "2026-04-02")).toBe(false);
});

test("excludes a fact that lost an authoritative-pick conflict resolution", async () => {
  const winner = await newFact({ asOf: "2026-05-01", value: "9.0" });
  const loser = await newFact({ asOf: "2026-05-02", value: "20.0" });
  const [{ id: conflictId }] = await sql`
    INSERT INTO conflicts (fact_id_a, fact_id_b, status, authoritative_fact_id) VALUES (${winner}, ${loser}, 'resolved', ${winner}) RETURNING id`;

  try {
    const res = await getMarkerTrend(trendReq(patientId, ceaMarkerId));
    const body = (await res.json()) as any;
    expect(body.points.some((p: any) => p.fact_id === loser)).toBe(false);
    expect(body.points.some((p: any) => p.fact_id === winner)).toBe(true);
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${conflictId}`;
  }
});

test("returns an empty points array, not an error, when the marker has no signed-off facts", async () => {
  const [{ id: emptyMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'HE4', false, ${staff.id}) RETURNING id`;
  const res = await getMarkerTrend(trendReq(patientId, emptyMarkerId));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.points).toEqual([]);
});
