import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { api, dictationAudioUrl, type DictationEntry } from "../api/client";
import { formatDuration } from "../lib/dictation";
import { usePane } from "./PaneContext";

// One native player for a recording. preload="none": nothing is requested (so nothing is logged) until Play.
export function DictationAudio({ dictationId, autoPlay }: { dictationId: string; autoPlay?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void dictationAudioUrl(dictationId).then((u) => live && setSrc(u)).catch(() => {});
    return () => { live = false; };
  }, [dictationId]);
  if (!src) return null;
  return <audio controls preload="none" autoPlay={autoPlay} src={src} aria-label="Dictated note" />;
}

// The visit's dictated notes (AM-02), on the Snapshot header area. Renders nothing, and requests nothing, unless
// the session carries features.dictation.
export function DictationNotes({ visitId }: { visitId: string }) {
  const { user } = useAuth();
  if (!user?.features?.dictation) return null;
  return <Notes visitId={visitId} />;
}

function Notes({ visitId }: { visitId: string }) {
  const refreshKey = usePane()?.refreshKey ?? 0;
  const [notes, setNotes] = useState<DictationEntry[]>([]);
  useEffect(() => {
    let live = true;
    api.listVisitDictations(visitId).then((n) => live && setNotes(n)).catch(() => {});
    return () => { live = false; };
  }, [visitId, refreshKey]);
  if (notes.length === 0) return null;
  return (
    <div className="dictation-notes" data-testid="dictation-notes">
      {notes.map((n) => (
        <div className="dictation-notes__row" key={n.id}>
          <span>Dictated note · {formatDuration(n.duration_seconds)}</span>
          <span className="muted">{new Date(n.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
          <DictationAudio dictationId={n.id} />
        </div>
      ))}
    </div>
  );
}
