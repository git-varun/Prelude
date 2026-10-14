import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findViolations, ALLOWED_PHRASES, PROHIBITED_COPY_TERMS } from "./lib/wordingGuard";

const SRC_DIR = join(import.meta.dir);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    if (entry === "wordingGuard.ts") continue; // defines the term list itself, not user-visible copy
    files.push(full);
  }
  return files;
}

test("no apps/web source file uses a prohibited clinical-judgment term as user-visible copy", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf-8");
    for (const v of findViolations(source)) {
      violations.push(`${file}:${v.line}: "${v.term}" in: ${v.snippet}`);
    }
  }
  expect(violations).toEqual([]);
});

const terms = (src: string) => findViolations(src).map((v) => v.term);

// Literal spec (AM-06): the exported lists must match this, not themselves.
const SPEC_TERMS = ["done", "overdue", "missed", "due", "triage", "urgent", "priority patient"];
const SPEC_PHRASES = [
  "Planned", "Report seen", "Past advised date, no report seen", "Not found in documents",
  "Not extracted yet", "Visit elsewhere", "Pinned", "Suggested pin",
];

test("exported lists equal the AM-06 spec", () => {
  expect([...PROHIBITED_COPY_TERMS] as string[]).toEqual(SPEC_TERMS);
  expect([...ALLOWED_PHRASES] as string[]).toEqual(SPEC_PHRASES);
});

test("each AM-06 term is a violation in JSX text, a title prop and a template string", () => {
  for (const term of SPEC_TERMS) {
    expect(terms(`<p>Visit ${term} today</p>`)).toContain(term);
    expect(terms(`<Card title="Marked ${term}" />`)).toContain(term);
    expect(terms("const s = `This is ${n} " + term + " now`;")).toContain(term);
    expect(terms(`<p>\n  Marked ${term}\n</p>`)).toContain(term);
  }
});

test("dynamic and punctuated JSX copy is scanned", () => {
  expect(terms("<p>Overdue {n}</p>")).toContain("overdue");
  expect(terms("<p>{n} overdue</p>")).toContain("overdue");
  expect(terms("<p>Overdue (see plan)</p>")).toContain("overdue");
  expect(terms("<p>Done &amp; dusted</p>")).toContain("done");
  expect(terms("<p>\n  3 overdue\n</p>")).toContain("overdue");
  expect(terms("<p>\n  Overdue {n}\n</p>")).toContain("overdue");
});

test("multi-line template literals are scanned and report the literal's line", () => {
  const src = "const a = 1;\nconst s = `first line\nsecond ${x} overdue\nthird`;";
  const v = findViolations(src).filter((x) => x.term === "overdue");
  expect(v.map((x) => x.line)).toEqual([3]);
  expect(terms("const s = `ok ${\n  n + due\n} text`;")).toEqual([]);
});

test("only code-position 'done' literals are exempt", () => {
  expect(terms('<span>{"done"}</span>')).toContain("done");
  expect(terms("{s ? 'done' : 'p'}")).toContain("done");
  expect(terms('const label = "done";')).toContain("done");
  expect(terms('const l = x || "done";')).toContain("done");
  expect(terms('if (a.ocr_status === "done") go();')).toEqual([]);
  expect(terms("if (a !== 'done') go();")).toEqual([]);
  expect(terms('switch (s) { case "done": break; }')).toEqual([]);
  expect(terms('type S = "pending" | "done" | "failed";')).toEqual([]);
  expect(terms('type S =\n  | "pending"\n  | "done";')).toEqual([]);
  expect(terms('type S =\n  "done"\n  | "pending";')).toEqual([]);
  expect(terms('interface R { status: "done" }')).toEqual([]);
});

test("AM-06 terms are ignored in code, not copy", () => {
  const ok = [
    'if (x.ocr_status === "done") run();',
    "const dueLabel = fmt(r.due_date);",
    '<div className="task-done due urgent" />',
    "// this is overdue and done",
    "/* urgent triage */",
    'import { done } from "./due";',
    "import {\n  done,\n  due,\n  overdue,\n} from \"./x\";",
    'import "./due.css";',
    "<p>Predone and redone</p>",
    "const s = `${targets.length - done} left`;",
    '<ul data-testid="due-list" />',
    'fetch("/api/due");',
    'const u = "http://x/due";',
    'case "urgent":',
    "const r = {\n  done,\n  due,\n};",
    "  due,\n  overdue",
  ];
  for (const src of ok) expect(terms(src)).toEqual([]);
});

test("a // inside a string does not hide copy after it", () => {
  expect(terms('const u = "http://x"; const t = \'overdue\';')).toContain("overdue");
});

test("every ALLOWED_PHRASES entry passes the guard", () => {
  for (const p of SPEC_PHRASES) {
    expect(findViolations(`<p>${p}</p>`)).toEqual([]);
    expect(findViolations(`const t = "${p}";`)).toEqual([]);
  }
});
