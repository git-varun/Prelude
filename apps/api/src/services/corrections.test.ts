import { test, expect } from "bun:test";
import { parseCorrection } from "./corrections";

test("parseCorrection rejects an empty body", () => {
  expect(parseCorrection({})).toEqual({ ok: false, message: expect.stringContaining("at least one of") });
});
test("parseCorrection rejects coverage_status", () => {
  const r = parseCorrection({ coverage_status: "value_found", value: "1" });
  expect(r.ok).toBe(false);
});
test("parseCorrection maps snake_case body fields to the Correction shape", () => {
  const r = parseCorrection({ value: " 4.2 ", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01" });
  expect(r).toEqual({ ok: true, correction: { value: "4.2", unit: "ng/mL", referenceRange: "0-5", asOfDate: "2026-02-01" } });
});
test("parseCorrection rejects an impossible calendar date and a blank value", () => {
  expect(parseCorrection({ as_of_date: "2026-02-30" }).ok).toBe(false);
  expect(parseCorrection({ value: "  " }).ok).toBe(false);
});
test("parseCorrection: value_found requires a value; other resolutions forbid one", () => {
  expect(parseCorrection({ resolution: "value_found" }).ok).toBe(false);
  expect(parseCorrection({ resolution: "no_usable_value", value: "1" }).ok).toBe(false);
  expect(parseCorrection({ resolution: "no_usable_value" }).ok).toBe(true);
});
