export interface WordingViolation {
  term: string;
  line: number;
  snippet: string;
}

// Clinical wording rule (Decisions Log, "Clinical input — partner oncologist (Oct
// 2026)"): these terms read as a clinical judgment the tool must never make.
export const PROHIBITED_TERMS = [
  "abnormal", "flagged", "at risk", "concerning", "normal", "pathologic", "alert", "warning",
  "high risk", "critical value", "disease progression", "biochemical recurrence",
] as const;

// Strips the places a prohibited term is a code identifier rather than user-visible
// copy, so a className like "tag--warning", an import path, or a comment doesn't
// false-positive. This is a pragmatic line-based pass, not a real parser — it can
// still miss or over-strip unusual formatting, but covers the common cases.
function stripNonCopy(source: string): string {
  let text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  text = text.replace(/className\s*=\s*(\{[^}]*\}|["'`][^"'`]*["'`])/g, "className=");
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*import\b/.test(line) || /^\s*export\s+.*\bfrom\b/.test(line)) return "";
      return line.replace(/\/\/.*$/, "");
    })
    .join("\n");
}

// AM-06 additions. Unlike the terms above these are common code words ("done" status
// enums, "due" in dueLabel), so they are matched only inside copy segments (see copySegments).
export const PROHIBITED_COPY_TERMS = [
  "done", "overdue", "missed", "due", "triage", "urgent", "priority patient",
] as const;

// Approved replacement vocabulary (AM-06). Tests assert each passes the guard.
export const ALLOWED_PHRASES = [
  "Planned", "Report seen", "Past advised date, no report seen", "Not found in documents",
  "Not extracted yet", "Visit elsewhere", "Pinned", "Suggested pin",
] as const;

// A string literal exactly equal to one of these is a code value (status enum), not copy.
const CODE_VALUE_LITERALS = new Set([
  "done", // extraction_status / ocr_status enum value from the API; never rendered as copy
]);

// User-visible candidates on one line: string/template literals (with ${...} removed),
// JSX text between > and <, and bare JSX text lines. Identifiers, keys and comparisons
// are never included.
function copySegments(line: string): string[] {
  const segs: string[] = [];
  const lit = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const m of line.matchAll(lit)) {
    const body = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ");
    if (!CODE_VALUE_LITERALS.has(body)) segs.push(body);
  }
  for (const m of line.matchAll(/>([^<>{}=&|;()]+)</g)) segs.push(m[1] ?? "");
  if (/^\s*[A-Za-z][A-Za-z ,.'’!?:-]*$/.test(line)) segs.push(line);
  return segs;
}

export function findViolations(source: string): WordingViolation[] {
  const violations: WordingViolation[] = [];
  const cleaned = stripNonCopy(source);
  const lines = cleaned.split("\n");
  for (const term of PROHIBITED_TERMS) {
    const re = new RegExp(`\\b${term.replace(" ", "\\s+")}\\b`, "i");
    lines.forEach((line, i) => {
      if (re.test(line)) violations.push({ term, line: i + 1, snippet: line.trim() });
    });
  }
  const copyTerms = PROHIBITED_COPY_TERMS.map((term) => ({
    term,
    re: new RegExp(`\\b${term.replace(" ", "\\s+")}\\b`, "i"),
  }));
  lines.forEach((line, i) => {
    const segs = copySegments(line);
    for (const { term, re } of copyTerms) {
      if (segs.some((seg) => re.test(seg))) violations.push({ term, line: i + 1, snippet: line.trim() });
    }
  });
  return violations;
}
