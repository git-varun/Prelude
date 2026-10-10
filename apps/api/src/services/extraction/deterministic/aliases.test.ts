import { test, expect } from "bun:test";
import { aliasKeys, squash } from "./aliases";
import { unitsEquivalent } from "./units";

test("registry aliases join the shared table", () => {
  expect(aliasKeys("Carcinoembryonic Antigen").has(squash("CEA"))).toBe(true);
  expect(aliasKeys("PSA").has(squash("Total PSA"))).toBe(true);
});

test("triglycerides and thyroglobulin are never conflated", () => {
  expect(aliasKeys("Triglycerides").has("thyroglobulin")).toBe(false);
  expect(aliasKeys("Tg").has("triglycerides")).toBe(false);
  expect(aliasKeys("Tg").has("thyroglobulin")).toBe(true);
});

test("free and total thyroid tests stay separate", () => {
  expect(aliasKeys("T3 Total").has(squash("Free T3"))).toBe(false);
  expect(aliasKeys("FT4").has(squash("T4 Total"))).toBe(false);
});

test("unitsEquivalent covers micro sign, case and count spellings", () => {
  expect(unitsEquivalent("µIU/mL", "uIU/ml")).toBe(true);
  expect(unitsEquivalent("10^3/µL", "10^9/L")).toBe(true);
  expect(unitsEquivalent("ng/mL", "pg/mL")).toBe(false);
  expect(unitsEquivalent(null, null)).toBe(true);
  expect(unitsEquivalent(null, "g/dL")).toBe(false);
});
