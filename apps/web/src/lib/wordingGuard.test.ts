import { test, expect } from "bun:test";
import { findViolations } from "./wordingGuard";

test("flags a prohibited term in user-visible JSX text", () => {
  const violations = findViolations(`<p>Warning: check this value</p>`);
  expect(violations.map((v) => v.term)).toContain("warning");
});

test("does not flag a prohibited term inside a className value", () => {
  const violations = findViolations(`<span className="tag--warning">{label}</span>`);
  expect(violations).toEqual([]);
});

test("does not flag a prohibited term inside a className object expression", () => {
  const violations = findViolations(`<span className={cx("tag", { "tag--alert": isUrgent })}>x</span>`);
  expect(violations).toEqual([]);
});

test("does not flag a prohibited term inside an import path", () => {
  const violations = findViolations(`import { AlertBox } from "./alert";`);
  expect(violations).toEqual([]);
});

test("does not flag a prohibited term inside a line comment", () => {
  const violations = findViolations(`// warning: this is just a dev comment\nconst x = 1;`);
  expect(violations).toEqual([]);
});

test("does not flag a prohibited term inside a block comment", () => {
  const violations = findViolations(`/* this is normal for dev notes */\nconst x = 1;`);
  expect(violations).toEqual([]);
});

test("does not flag a camelCase identifier containing the term as a substring", () => {
  const violations = findViolations(`const isNormalized = true;`);
  expect(violations).toEqual([]);
});

test("reports the 1-indexed line number of the violation", () => {
  const violations = findViolations(`const a = 1;\nconst b = "concerning finding";`);
  expect(violations).toEqual([{ term: "concerning", line: 2, snippet: 'const b = "concerning finding";' }]);
});
