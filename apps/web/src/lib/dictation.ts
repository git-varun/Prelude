/** 75 -> "1:15", 5 -> "0:05", 600 -> "10:00". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const MAX_DICTATION_SECONDS = 1800;

/** First recording format this browser supports, or "" to let it choose. */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

/** Plain words for why a recording could not start. */
export function microphoneMessage(err: unknown): string {
  const name = err instanceof DOMException || (err && typeof err === "object" && "name" in err) ? String((err as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow it in the browser settings and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device.";
  return "The microphone could not be started.";
}
