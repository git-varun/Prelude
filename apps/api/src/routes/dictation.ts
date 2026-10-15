import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { allowedDictationMime, dictationExtension, DICTATION_MAX_BYTES, validDuration } from "../services/dictation";
import { deleteDocumentFile, documentFile, saveDictationFile } from "../services/storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

// POST /visits/:id/dictation?duration_seconds=N -- the raw audio is the body, its Content-Type the mime.
// Audio only: no speech-to-text, no LLM, no extraction is called from here (AM-02).
export async function recordDictation(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const visitId = req.params.id;
  if (!isUuid(visitId)) return jsonError(404, "not_found", "Visit not found.");
  const [visit] = await sql`SELECT id, patient_id FROM visits WHERE id = ${visitId}`;
  if (!visit) return jsonError(404, "not_found", "Visit not found.");

  const mime = allowedDictationMime(req.headers.get("content-type"));
  if (!mime) return jsonError(400, "bad_request", "Unsupported audio type.");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > DICTATION_MAX_BYTES) return jsonError(413, "too_large", "The recording is larger than 25 MB.");
  const rawDuration = new URL(req.url).searchParams.get("duration_seconds");
  const duration = rawDuration !== null && /^\d+$/.test(rawDuration) ? Number(rawDuration) : NaN;
  if (!validDuration(duration)) return jsonError(400, "bad_request", "duration_seconds must be a whole number from 1 to 1800.");

  const data = await req.blob();
  if (data.size === 0) return jsonError(400, "bad_request", "The recording is empty.");
  if (data.size > DICTATION_MAX_BYTES) return jsonError(413, "too_large", "The recording is larger than 25 MB.");

  const { file_ref } = await saveDictationFile(visitId, dictationExtension(mime), data);
  try {
    const row = await sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as typeof sql;
      const [d] = await tx`
        INSERT INTO visit_dictations (visit_id, patient_id, recorded_by, file_ref, mime, duration_seconds, size_bytes)
        VALUES (${visitId}, ${visit.patient_id}, ${user.id}, ${file_ref}, ${mime}, ${duration}, ${data.size})
        RETURNING id, duration_seconds, created_at
      `;
      await tx`
        INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
        VALUES (${user.id}, 'record_dictation', 'visit', ${visitId}, NULL,
                ${JSON.stringify({ dictation_id: d.id, duration_seconds: duration, size_bytes: data.size })}::jsonb)
      `;
      await tx`INSERT INTO dictation_access_log (dictation_id, user_id, action) VALUES (${d.id}, ${user.id}, 'record')`;
      return d;
    });
    return Response.json(
      { id: row.id, duration_seconds: row.duration_seconds, created_at: new Date(row.created_at).toISOString() },
      { status: 201 },
    );
  } catch (err) {
    await deleteDocumentFile(file_ref);
    throw err;
  }
}

export async function listVisitDictations(req: Request & { params: { id: string } }): Promise<Response> {
  const visitId = req.params.id;
  if (!isUuid(visitId)) return jsonError(404, "not_found", "Visit not found.");
  const [visit] = await sql`SELECT id FROM visits WHERE id = ${visitId}`;
  if (!visit) return jsonError(404, "not_found", "Visit not found.");
  const rows = await sql`
    SELECT d.id, d.duration_seconds, d.created_at, u.name AS recorded_by_name
    FROM visit_dictations d JOIN users u ON u.id = d.recorded_by
    WHERE d.visit_id = ${visitId}
    ORDER BY d.created_at DESC, d.id DESC
  `;
  return Response.json(rows.map((r: any) => ({ ...r, created_at: new Date(r.created_at).toISOString() })));
}

const NO_STORE = { "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" };

// GET /dictations/:id/audio -- writes the 'play' access-log row BEFORE any byte is streamed. A request for a file that
// is missing from storage is a 404 and is not logged (nothing was played). Seek requests (Range) are requests too and
// each is logged: the log may over-count a play, never under-count it.
export async function playDictation(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const id = req.params.id;
  if (!isUuid(id)) return jsonError(404, "not_found", "Recording not found.");
  const [d] = await sql`SELECT id, file_ref, mime FROM visit_dictations WHERE id = ${id}`;
  if (!d) return jsonError(404, "not_found", "Recording not found.");
  const file = documentFile(d.file_ref);
  if (!(await file.exists())) return jsonError(404, "not_found", "Recording is not available in storage.");

  await sql`INSERT INTO dictation_access_log (dictation_id, user_id, action) VALUES (${id}, ${user.id}, 'play')`;

  const size = file.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...NO_STORE, "Content-Range": `bytes */${size}` } });
    }
    // Read the slice (at most 25 MB) rather than hand a sliced BunFile to Response, which streamed the whole file.
    return new Response(await file.slice(start, end + 1).arrayBuffer(), {
      status: 206,
      headers: { ...NO_STORE, "Content-Type": d.mime, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(file, { headers: { ...NO_STORE, "Content-Type": d.mime, "Content-Length": String(size) } });
}
