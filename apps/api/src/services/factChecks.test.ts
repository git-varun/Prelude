import { test, expect } from "bun:test";
import { parseCheck } from "./factChecks";

test("parseCheck accepts correct with no other fields", () => {
  expect(parseCheck({ result: "correct" })).toEqual({ ok: true, input: { result: "correct" } });
});
test("parseCheck requires error_type for incorrect and rejects an unknown one", () => {
  expect(parseCheck({ result: "incorrect" }).ok).toBe(false);
  expect(parseCheck({ result: "incorrect", error_type: "typo" }).ok).toBe(false);
});
test("parseCheck requires the correction field matching the error type", () => {
  expect(parseCheck({ result: "incorrect", error_type: "value", correction: { unit: "mg" } }).ok).toBe(false);
  expect(parseCheck({ result: "incorrect", error_type: "value", correction: { value: "5" } }).ok).toBe(true);
  expect(parseCheck({ result: "incorrect", error_type: "date", correction: { as_of_date: "2026-03-01" } }).ok).toBe(true);
});
test("parseCheck forbids a correction for the two exclusion types", () => {
  expect(parseCheck({ result: "incorrect", error_type: "not_in_document", correction: { value: "1" } }).ok).toBe(false);
  expect(parseCheck({ result: "incorrect", error_type: "wrong_patient" }).ok).toBe(true);
});
