import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";
import { formatDuration, MAX_DICTATION_SECONDS, microphoneMessage, pickRecorderMime } from "../lib/dictation";
import { usePane } from "./PaneContext";

// AM-02 pilot: the oncologist's own dictated note, audio only. Renders nothing (and makes no request) unless the
// session carries features.dictation.
export function DictationRecorder({ patientId }: { patientId: string }) {
  const { user } = useAuth();
  if (!user?.features?.dictation) return null;
  return <Recorder patientId={patientId} />;
}

type Phase = "idle" | "recording" | "recorded" | "saving";

function Recorder({ patientId }: { patientId: string }) {
  const pane = usePane();
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<{ blob: Blob; seconds: number; url: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const takeUrl = useRef<string | null>(null);

  function release() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }
  function dropTake() {
    if (takeUrl.current) URL.revokeObjectURL(takeUrl.current);
    takeUrl.current = null;
    setTake(null);
  }
  useEffect(() => () => {
    release();
    if (recorder.current?.state === "recording") { recorder.current.onstop = null; recorder.current.stop(); }
    if (takeUrl.current) URL.revokeObjectURL(takeUrl.current);
  }, []);

  async function start() {
    setMessage(null);
    setSaved(false);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMessage("This browser cannot record audio.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setMessage(microphoneMessage(err));
      return;
    }
    try {
      const mime = pickRecorderMime();
      const rec = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      rec.onstop = () => {
        const seconds = Math.min(MAX_DICTATION_SECONDS, Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
        const blob = new Blob(chunks.current, { type: rec.mimeType || mime || "audio/webm" });
        release();
        const url = URL.createObjectURL(blob);
        takeUrl.current = url;
        setTake({ blob, seconds, url });
        setElapsed(seconds);
        setPhase("recorded");
      };
      recorder.current = rec;
      startedAt.current = Date.now();
      rec.start();
      setElapsed(0);
      setPhase("recording");
      timer.current = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt.current) / 1000);
        setElapsed(Math.min(s, MAX_DICTATION_SECONDS));
        if (s >= MAX_DICTATION_SECONDS) stop(); // 30 minutes: stops by itself
      }, 250);
    } catch {
      release();
      setMessage("This browser cannot record audio.");
    }
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  function discard() {
    dropTake();
    setElapsed(0);
    setMessage(null);
    setPhase("idle");
  }

  async function save() {
    if (!take) return;
    setPhase("saving");
    setMessage(null);
    try {
      const visits = await api.listVisits(patientId);
      const visit = visits[0];
      if (!visit) throw new Error("no visit");
      await api.recordDictation(visit.id, take.blob, take.seconds);
      dropTake();
      setElapsed(0);
      setSaved(true);
      setPhase("idle");
      pane?.refresh();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "The note could not be saved. Your recording is still here; try again.");
      setPhase("recorded");
    }
  }

  return (
    <div className="dictation" aria-label="Dictated note">
      {phase === "idle" && (
        <button className="btn btn--ghost" type="button" onClick={() => void start()}>Record dictated note</button>
      )}
      {phase === "recording" && (
        <>
          <span className="dictation__time" role="timer" aria-label="Elapsed time">{formatDuration(elapsed)}</span>
          <button className="btn" type="button" onClick={stop}>Stop</button>
        </>
      )}
      {(phase === "recorded" || phase === "saving") && take && (
        <>
          <audio controls preload="metadata" src={take.url} aria-label="Your take" />
          <span className="muted">{formatDuration(take.seconds)}</span>
          <button className="btn" type="button" disabled={phase === "saving"} onClick={() => void save()}>
            {phase === "saving" ? "Saving..." : "Save to this visit"}
          </button>
          <button className="btn btn--ghost" type="button" disabled={phase === "saving"} onClick={discard}>Discard</button>
        </>
      )}
      {message && <div className="error-banner" role="status">{message}</div>}
      {saved && <div className="muted" role="status">Saved to this visit.</div>}
      <div className="muted dictation__status">Dictation pilot · your own note only · no transcript is made</div>
    </div>
  );
}
