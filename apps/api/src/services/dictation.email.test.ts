import { test, expect } from "bun:test";
import { isDictationEnabledFor } from "./dictation";

const onc = { id: "AAAA-1", role: "oncologist", email: "Onc@Clinic.org" };

test("the email flag enables only the listed oncologist (case-insensitive)", () => {
  expect(isDictationEnabledFor(onc, undefined, "onc@clinic.org")).toBe(true);
  expect(isDictationEnabledFor(onc, undefined, " other@clinic.org , ONC@clinic.org ")).toBe(true);
  expect(isDictationEnabledFor({ ...onc, email: "x@clinic.org" }, undefined, "onc@clinic.org")).toBe(false);
});

test("staff and a missing email never match, even when the email is listed", () => {
  expect(isDictationEnabledFor({ ...onc, role: "staff" }, undefined, "onc@clinic.org")).toBe(false);
  expect(isDictationEnabledFor({ id: "AAAA-1", role: "oncologist" }, undefined, "onc@clinic.org")).toBe(false);
});

test("either the id flag or the email flag enables, and neither set means off", () => {
  expect(isDictationEnabledFor(onc, "aaaa-1", undefined)).toBe(true);
  expect(isDictationEnabledFor(onc, undefined, undefined)).toBe(false);
  expect(isDictationEnabledFor(onc, "", "")).toBe(false);
});
