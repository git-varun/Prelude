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

test("each AM-06 term is a violation in JSX text, a title prop and a template string", () => {
  for (const term of PROHIBITED_COPY_TERMS) {
    expect(terms(`<p>Visit ${term} today</p>`)).toContain(term);
    expect(terms(`<Card title="Marked ${term}" />`)).toContain(term);
    expect(terms("const s = `This is ${n} " + term + " now`;")).toContain(term);
    expect(terms(`<p>\n  Marked ${term}\n</p>`)).toContain(term);
  }
});

test("AM-06 terms are ignored in code, not copy", () => {
  const ok = [
    'if (x.ocr_status === "done") run();',
    'type S = "pending" | "done" | "failed";',
    "const dueLabel = fmt(r.due_date);",
    '<div className="task-done due urgent" />',
    "// this is overdue and done",
    "/* urgent triage */",
    'import { done } from "./due";',
    "<p>Predone and redone</p>",
    "const s = `${targets.length - done} left`;",
  ];
  for (const src of ok) expect(terms(src)).toEqual([]);
});

test("every ALLOWED_PHRASES entry passes the guard", () => {
  for (const p of ALLOWED_PHRASES) {
    expect(findViolations(`<p>${p}</p>`)).toEqual([]);
    expect(findViolations(`const t = "${p}";`)).toEqual([]);
  }
});
