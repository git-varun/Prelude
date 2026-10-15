import { useEffect, useRef, useState } from "react";
import { api, ApiError, dictationAudioUrl, type DictationEntry, type OutsideEncounterEntry, type VisitHistoryEntry } from "../api/client";
import { navigate } from "../router";
import { ElsewhereTag } from "../components/SummaryBits";
import { useAuth } from "../auth/AuthContext";
import { formatDuration } from "../lib/dictation";

// AM-02: one note with its own Play button. The audio element exists (preload="none", so nothing is requested or
// logged yet) and Play calls play() straight from the click, with no await in between.
function NoteRow({ note }: { note: DictationEntry }) {
  const [src, setSrc] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let live = true;
    void dictationAudioUrl(note.id).then((u) => live && setSrc(u)).catch(() => {});
    return () => { live = false; };
  }, [note.id]);
  return (
    <span className="dictation-notes__row">
      <span>Dictated note {formatDuration(note.duration_seconds)}</span>
      <span className="muted">{new Date(note.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
      <button className="btn btn--ghost" type="button" disabled={!src} onClick={() => void audio.current?.play().catch(() => {})}>Play</button>
      {src && <audio ref={audio} controls preload="none" src={src} aria-label="Dictated note" />}
    </span>
  );
}

// The tag shows the newest note's length. The list of ALL the visit's notes is fetched only when "Notes" is clicked.
function DictatedNoteTag({ visitId, seconds }: { visitId: string; seconds: number }) {
  const [notes, setNotes] = useState<DictationEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  function open() {
    if (notes) return setNotes(null);
    setFailed(false);
    api.listVisitDictations(visitId).then(setNotes).catch(() => setFailed(true));
  }
  return (
    <>
      <span className="tag">Dictated note {formatDuration(seconds)}</span>
      <button className="btn btn--ghost" type="button" aria-expanded={!!notes} onClick={open}>Notes</button>
      {failed && <span className="muted">The notes could not be loaded.</span>}
      {notes && (
        <span className="dictation-notes">
          {notes.map((n) => <NoteRow key={n.id} note={n} />)}
        </span>
      )}
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
