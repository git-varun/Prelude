import { test, expect } from "bun:test";
import { matchIdentity, normalizeName, jaroWinkler } from "./identity";

test("normalizeName strips titles, relational suffixes and punctuation", () => {
  expect(normalizeName("Mr. VARUN")).toEqual(["varun"]);
  expect(normalizeName("Varun S/O Suresh Upadhyay")).toEqual(["varun"]);
  expect(normalizeName("Smt. Priya Sharma")).toEqual(["priya", "sharma"]);
});

test("jaroWinkler matches the textbook example", () => {
  expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 2);
  expect(jaroWinkler("varun", "varun")).toBe(1);
});

test("identical and superset names are matched", () => {
  expect(matchIdentity("Varun Upadhyay", "Varun Upadhyay").status).toBe("matched");
  expect(matchIdentity("Varun Upadhyay", "Mr. Varun Kumar Upadhyay").status).toBe("matched");
});

test("a single shared token, a first-name-only report, or initials are partial, not matched or mismatch", () => {
  expect(matchIdentity("Varun Upadhyay", "Mr. VARUN").status).toBe("partial");
  expect(matchIdentity("Varun Upadhyay", "V. Upadhyay").status).toBe("partial");
  expect(matchIdentity("Priya Sharma", "Priya Patel").status).toBe("partial");
});

test("a fuzzy transliteration variant is partial via Jaro-Winkler", () => {
  expect(matchIdentity("Shreya Gupta", "Shreyaa Gupta").status).toBe("partial");
});

test("two unrelated names are mismatch", () => {
  expect(matchIdentity("Varun Upadhyay", "Suresh Kumar").status).toBe("mismatch");
});

test("a missing report name or missing patient name is unknown, never mismatch", () => {
  expect(matchIdentity("Varun Upadhyay", null).status).toBe("unknown");
  expect(matchIdentity(null, "Varun Upadhyay").status).toBe("unknown");
  expect(matchIdentity(null, null).status).toBe("unknown");
  expect(matchIdentity("Varun Upadhyay", "   ").status).toBe("unknown");
});

test("a report name or patient name that normalizes to nothing (punctuation/digits only) is unknown, not mismatch", () => {
  expect(matchIdentity("...", "Varun Upadhyay").status).toBe("unknown");
  expect(matchIdentity("Varun Upadhyay", "N/A").status).toBe("unknown");
  expect(matchIdentity("12345", "Varun Upadhyay").status).toBe("unknown");
});

test("two different common-first-name people are not matched by first name alone", () => {
  const r = matchIdentity("Priya Sharma", "Priya Verma");
  expect(r.status).not.toBe("matched");
  expect(r.status).toBe("partial");
});
