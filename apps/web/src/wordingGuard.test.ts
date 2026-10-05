import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findViolations } from "./lib/wordingGuard";

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
