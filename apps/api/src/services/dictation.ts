// M3-13 (AM-02): oncologist dictation pilot. Audio only: nothing here transcribes, summarises or extracts.

export const DICTATION_MIME_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"] as const;
export const DICTATION_MAX_BYTES = 25 * 1024 * 1024;
export const DICTATION_MAX_SECONDS = 1800;

/**
 * The pilot is one oncologist account: DICTATION_PILOT_USER_ID holds that user's id (a comma-separated list is
 * tolerated, but the pilot is meant to stay a single account). True only for an oncologist whose id is listed.
 * Read per call so the flag can be changed without code changes.
 */
export function isDictationEnabledFor(
  user: { id: string; role: string } | null | undefined,
  flag: string | undefined = process.env.DICTATION_PILOT_USER_ID,
): boolean {
  if (!user || user.role !== "oncologist" || !flag) return false;
  return flag.split(",").map((s) => s.trim()).filter(Boolean).includes(user.id);
}

/** The base mime type of a Content-Type value ("audio/webm;codecs=opus" -> "audio/webm"), if it is on the allowlist. */
export function allowedDictationMime(contentType: string | null): string | null {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return (DICTATION_MIME_TYPES as readonly string[]).includes(base) ? base : null;
}

export function validDuration(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= DICTATION_MAX_SECONDS;
}

const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/mpeg": "mp3" };
export const dictationExtension = (mime: string) => EXT[mime] ?? "bin";
