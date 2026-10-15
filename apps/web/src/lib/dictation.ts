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

/** 32 kbps speech audio: 30 minutes is about 7 MB, well under the 25 MB server cap. */
export const DICTATION_BITS_PER_SECOND = 32000;
/** Recording stops by itself near this size, leaving headroom under the server's 25 MB cap. */
export const DICTATION_SOFT_LIMIT_BYTES = 23 * 1024 * 1024;

/** True once the recorded chunks together reach the soft size limit. */
export function reachedSizeLimit(totalBytes: number, limit: number = DICTATION_SOFT_LIMIT_BYTES): boolean {
  return totalBytes >= limit;
}

export const SIZE_LIMIT_MESSAGE = "Stopped at the size limit. Save this note and start another.";
export const TOO_LARGE_MESSAGE = "This recording is too large to save. Record a shorter note.";
