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
  return violations;
}
