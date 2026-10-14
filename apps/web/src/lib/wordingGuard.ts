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

// Known limits (this is a pragmatic scan, not a parser): a stray apostrophe in JSX text
// can pair with a later quote on the same line; template literals nested inside `${}`
// and `${}` expressions with braces nested deeper than two levels are not understood;
// JSX text is only found between a tag's `>` and the next `<` on the same line; other
// multi-line JSX text is scanned line by line, and such a bare line needs a space, a
// letter, no `= ; | & { }` code punctuation, no trailing comma and no leading keyword;
// `done` object values are exempt only on a type/interface line.

const blank = (m: string) => m.replace(/[^\n]/g, "");

// Removes comments that are not inside a quoted string, keeping newlines so line
// numbers stay valid. Quotes ' and " end at a newline; backtick strings may span lines.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === "`" || src[j] !== "\n")) {
        if (src[j] === "\\") j++;
        j++;
      }
      const stop = src[j] === c ? j + 1 : j;
      out += src.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Strips the places a prohibited term is a code identifier rather than user-visible
// copy: comments, import blocks, className and data-testid values.
function stripNonCopy(source: string): string {
  return stripComments(source)
    .replace(/^[ \t]*(?:import\b|export\s*(?:\*|\{|type\s*\{))[^;'"`]*?\bfrom\s*(["'])[^"'\n]*\1;?/gm, blank)
    .replace(/^[ \t]*import\s*["'][^"'\n]*["'];?/gm, blank)
    .replace(/className\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|'[^']*')/g, "className=")
    .replace(/data-testid\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|'[^']*')/g, "data-testid=");
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

const EXPR = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
const TEMPLATE_EXPR = /\$\{(?:[^{}]|\{[^{}]*\})*\}/g;
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\[\s\S])*)`/g;
const KEYWORD_LINE =
  /^(?:if|else|for|while|switch|return|const|let|var|function|import|export|type|interface|case|throw|await|async|new|default|try|catch|finally|do|yield)\b/;
const TYPE_LINE = /^\s*(?:export\s+)?(?:type|interface)\b/;
// A literal right after a comparison or `case` is a code value, not copy.
const AFTER_COMPARE = /(?:===|!==|==|!=|\bcase)\s*$/;

const termRe = (term: string) => new RegExp(`\\b${term.replace(" ", "\\s+")}\\b`, "i");

interface Segment {
  text: string;
  line: number; // 1-based line where the segment starts
}

// User-visible candidates: string/template literals (over the whole source, `${...}`
// removed), JSX text between a tag's > and the next <, and bare JSX text lines.
// Identifiers, keys and comparisons are never included.
function copySegments(cleaned: string, lines: string[]): Segment[] {
  const segs: Segment[] = [];
  for (const m of cleaned.matchAll(LITERAL)) {
    const idx = m.index ?? 0;
    const line = cleaned.slice(0, idx).split("\n").length;
    let body = m[1] ?? m[2] ?? m[3] ?? "";
    if (m[3] !== undefined) body = body.replace(TEMPLATE_EXPR, (x) => x.replace(/[^\n]/g, " "));
    if (body.startsWith("/") || body.includes("://")) continue; // path / URL
    const before = cleaned.slice(Math.max(0, idx - 40), idx);
    if (AFTER_COMPARE.test(before)) continue;
    if (body === "done") {
      // Status enum value: exempt only as a union member or on a type/interface line.
      const after = cleaned.slice(idx + m[0].length, idx + m[0].length + 40);
      if (/(?<!\|)\|\s*$/.test(before) || /^\s*\|(?!\|)/.test(after)) continue;
      if (TYPE_LINE.test(lines[line - 1] ?? "")) continue;
    }
    segs.push({ text: body, line });
  }
  lines.forEach((line, i) => {
    // {expr} becomes placeholder characters (they separate words), entities become spaces.
    const noExpr = line.replace(EXPR, (x) => "\u0001".repeat(x.length)).replace(/&#?\w+;/g, " ");
    for (const m of noExpr.matchAll(/<\/?[A-Za-z][^<>]*>([^<>]*)(?=<)/g)) {
      segs.push({ text: m[1] ?? "", line: i + 1 });
    }
    const t = noExpr.trim();
    if (
      t.includes(" ") &&
      /[A-Za-z]/.test(t.replace(/\u0001/g, "")) &&
      /^[A-Za-z0-9(\u0001][A-Za-z0-9 .,'’!:()%\-\u0001]*$/.test(t) &&
      !t.endsWith(",") &&
      !KEYWORD_LINE.test(t)
    ) {
      segs.push({ text: t, line: i + 1 });
    }
  });
  return segs;
}

export function findViolations(source: string): WordingViolation[] {
  const violations: WordingViolation[] = [];
  const seen = new Set<string>();
  const cleaned = stripNonCopy(source);
  const lines = cleaned.split("\n");
  const add = (term: string, line: number) => {
    const key = `${term}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ term, line, snippet: (lines[line - 1] ?? "").trim() });
  };
  for (const term of PROHIBITED_TERMS) {
    const re = termRe(term);
    lines.forEach((line, i) => {
      if (re.test(line)) add(term, i + 1);
    });
  }
  const segs = copySegments(cleaned, lines);
  for (const term of PROHIBITED_COPY_TERMS) {
    const re = termRe(term);
    for (const seg of segs) {
      const m = re.exec(seg.text);
      if (m) add(term, seg.line + seg.text.slice(0, m.index).split("\n").length - 1);
    }
  }
  return violations;
}
