import { useEffect, useState } from "react";
import { api, ApiError, type OutsideEncounterEntry, type VisitHistoryEntry } from "../api/client";
import { navigate } from "../router";
import { ElsewhereTag } from "../components/SummaryBits";
import { useAuth } from "../auth/AuthContext";
import { DictationAudio } from "../components/DictationNotes";
import { formatDuration } from "../lib/dictation";

// AM-02: the tag and an inline play button. Play looks up the visit's newest note, then mounts the player, so
// nothing is requested from the audio endpoint (and nothing is logged) until the oncologist asks.
function DictatedNoteTag({ visitId, seconds }: { visitId: string; seconds: number }) {
  const [noteId, setNoteId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  function play() {
    setFailed(false);
    api.listVisitDictations(visitId).then((n) => (n[0] ? setNoteId(n[0].id) : setFailed(true))).catch(() => setFailed(true));
  }
  return (
    <>
      <span className="tag">Dictated note {formatDuration(seconds)}</span>
      {noteId ? (
        <DictationAudio dictationId={noteId} autoPlay />
      ) : (
        <button className="btn btn--ghost" type="button" onClick={play}>Play note</button>
      )}
      {failed && <span className="muted">The note could not be loaded.</span>}
    </>
  );
}

export function VisitHistory({ patientId }: { patientId: string }) {
  const canDictate = !!useAuth().user?.features?.dictation;
  const [visits, setVisits] = useState<VisitHistoryEntry[] | null>(null);
  const [outside, setOutside] = useState<OutsideEncounterEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .listVisits(patientId)
      .then((v) => {
        if (current) setVisits(v);
      })
      .catch((err) => {
        if (current) setError(err instanceof ApiError ? err.message : "Failed to load visit history.");
      });
    // Best effort: visits elsewhere are extra rows; a failure leaves the visits here as they were.
    api.listOutsideEncounters(patientId).then((o) => { if (current) setOutside(o); }).catch(() => {});
    return () => {
      current = false;
    };
  }, [patientId]);

  return (
    <div>
      <div className="page-heading">
        <h1>Visit history</h1>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Back to Snapshot
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {visits === null ? (
        <p className="muted">Loading...</p>
      ) : visits.length === 0 && outside.length === 0 ? (
        <div className="empty-state">No visits recorded yet.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {[
            ...visits.map((v) => ({ kind: "here" as const, date: v.visit_date, id: v.id, v })),
            ...outside.map((o) => ({ kind: "elsewhere" as const, date: o.encounter_date, id: o.id, o })),
          ]
            .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
            .map((row) =>
              row.kind === "here" ? (
                <div className="delta-row" key={row.id}>
                  <span className="delta-row__name">{row.date}</span>
                  <span className="delta-row__meta">
                    <span className="tag">
                      {row.v.document_count} document{row.v.document_count === 1 ? "" : "s"}
                    </span>
                    <span className="tag">
                      {row.v.fact_count} fact{row.v.fact_count === 1 ? "" : "s"}
                    </span>
                    <span className="tag">
                      {row.v.signed_off_count} signed off
                    </span>
                    {canDictate && typeof row.v.dictated_note_seconds === "number" && (
                      <DictatedNoteTag visitId={row.v.id} seconds={row.v.dictated_note_seconds} />
                    )}
                  </span>
                </div>
              ) : (
                <div className="delta-row is-elsewhere" key={row.id} data-testid="elsewhere-row">
                  <span className="delta-row__name">{row.date}</span>
                  <span>{row.o.facility} · elsewhere</span>
                  <span className="delta-row__meta">
                    <ElsewhereTag encounter={{ id: row.o.id, facility: row.o.facility, date: row.o.encounter_date }} />
                    <span className="tag">
                      {row.o.document_count} document{row.o.document_count === 1 ? "" : "s"}
                    </span>
                  </span>
                </div>
              ),
            )}
        </div>
      )}
    </div>
  );
}
