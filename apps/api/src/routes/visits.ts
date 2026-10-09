import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { LIVE_FACT_FILTER } from "../services/delta";

interface CreateVisitBody {
  visit_date?: string;
}

// Full chronological visit history (docs/01 Screen Inventory calls out history
// only implicitly via "previous visit" on Snapshot, which shows just the two
// most recent) -- a per-visit summary count, not a full re-rendered Snapshot
// per historical visit (that's its own larger scope: arbitrary-visit facts
// selection, conflicts, provenance -- not something to half-build here).
export async function listVisits(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;

  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
  if (!patient) {
    return jsonError(404, "not_found", "Patient not found.");
  }

  const visits = await sql`
    SELECT v.id, to_char(v.visit_date, 'YYYY-MM-DD') AS visit_date,
           (SELECT count(*)::int FROM documents d WHERE d.visit_id = v.id) AS document_count,
           (SELECT count(*)::int FROM facts f WHERE f.visit_id = v.id AND ${LIVE_FACT_FILTER}) AS fact_count,
           (SELECT count(*)::int FROM facts f WHERE f.visit_id = v.id AND f.verification_state = 'oncologist_signed_off' AND ${LIVE_FACT_FILTER}) AS signed_off_count
    FROM visits v
    WHERE v.patient_id = ${patientId}
    ORDER BY v.visit_date DESC, v.id DESC
  `;

  return Response.json(visits);
}

/**
 * "Create/open the current visit" (docs/02 M1): a visit is a lightweight
 * grouping of the documents pushed for one OPD consult, not an
 * encounter-management model (docs/01 §9). Calling this twice for the same
 * patient/date reopens the same visit rather than creating a duplicate, so
 * staff can call it idempotently at the start of each upload session without
 * fragmenting one consult's documents across multiple VISIT rows.
 */
export async function createOrOpenVisit(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const patientId = req.params.id;

  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
  if (!patient) {
    return jsonError(404, "not_found", "Patient not found.");
  }

  let body: CreateVisitBody = {};
  const raw = await req.text();
  if (raw) {
    try {
      body = JSON.parse(raw) as CreateVisitBody;
    } catch {
      return jsonError(400, "bad_request", "Malformed JSON body.");
    }
  }

  // Falls back to the server's own UTC day only if a caller omits visit_date
  // entirely -- the real client (Upload.tsx) always supplies its own local
  // date now, since guessing a clinic's timezone from the server has no
  // correct answer and previously misfiled documents near local midnight.
  const visitDate = body.visit_date ?? new Date().toISOString().slice(0, 10);

  // Atomic upsert via the unique (patient_id, visit_date) constraint
  // (migration 007) -- the previous check-then-insert raced under
  // concurrent requests (two tabs/devices opening the same day's visit at
  // once), each missing the other's row and fragmenting one consult across
  // two visit rows.
  const [row] = await sql`
    INSERT INTO visits (patient_id, visit_date)
    VALUES (${patientId}, ${visitDate})
    ON CONFLICT (patient_id, visit_date) DO UPDATE SET visit_date = EXCLUDED.visit_date
    RETURNING id, patient_id, to_char(visit_date, 'YYYY-MM-DD') AS visit_date,
              (xmax = 0) AS inserted
  `;
  const { inserted, ...visit } = row;
  return Response.json(visit, { status: inserted ? 201 : 200 });
}
