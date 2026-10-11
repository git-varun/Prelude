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

test("a first-name-only report, or an initial for the first name, is partial (not enough evidence either way)", () => {
  expect(matchIdentity("Varun Upadhyay", "Mr. VARUN").status).toBe("partial");
  expect(matchIdentity("Varun Upadhyay", "V. Upadhyay").status).toBe("partial");
});

test("same first name but a different surname is two different people: mismatch, never accepted", () => {
  expect(matchIdentity("Priya Sharma", "Priya Patel").status).toBe("mismatch");
  expect(matchIdentity("Priya Sharma", "Priya Verma").status).toBe("mismatch");
});

test("same surname but a different first name is not a match, and a shared first letter alone is not 'initials'", () => {
  expect(matchIdentity("Sanjay Gupta", "Suresh Gupta").status).toBe("mismatch");
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

test("a transliteration variant of every token is partial, per token (a shared surname must not carry the score)", () => {
  expect(matchIdentity("Shreya Gupta", "Shreyaa Gupta").status).toBe("partial");
  expect(matchIdentity("Sanjay Gupta", "Suresh Gupta").status).toBe("mismatch");
});

// ---- review fixes (C1, I1) ----

test("relational markers and their OCR variants drop the relative's name", () => {
  for (const name of ["Shyam Kumar s / o Ram Kumar", "Shyam Kumar D/0 Ram", "Shyam Kumar C/O Ram Kumar", "Shyam Kumar son of Ram Kumar", "Shyam Kumar B/O Ram Kumar"]) {
    expect(normalizeName(name)).toEqual(["shyam", "kumar"]);
  }
  expect(normalizeName("Anita wife of Ram Kumar")).toEqual(["anita"]);
});

test("a different person who is the patient's relative is not matched through the relational tail", () => {
  expect(matchIdentity("Ram Kumar", "Shyam Kumar C/O Ram Kumar").status).toBe("mismatch");
  expect(matchIdentity("Ram Kumar", "Shyam Kumar s / o Ram Kumar").status).toBe("mismatch");
  expect(matchIdentity("Ramesh", "Suresh Kumar Ref By Dr Ramesh").status).not.toBe("matched");
});

test("an implausibly long 'name' (field bleed from OCR text) is held, never matched", () => {
  const r = matchIdentity("Ramesh Kumar", "Suresh Kumar Age : 45 Yrs Sex : M Ref By : Dr Ramesh Kumar");
  expect(r.status).toBe("mismatch");
});

test("a surname-only report is not 'first-name-only' evidence: it is held", () => {
  expect(matchIdentity("Ramesh Kumar", "Kumar").status).toBe("mismatch");
  expect(matchIdentity("Sunita Devi", "Devi").status).toBe("mismatch");
  expect(matchIdentity("Varun Upadhyay", "Mr. VARUN").status).toBe("partial");
});

test("a name made only of titles is no name at all", () => {
  expect(matchIdentity("Ramesh Kumar", "Mr.").status).toBe("unknown");
  expect(matchIdentity("Mrs", "Mr").status).toBe("unknown");
});

test("close-but-different first names (Ramesh/Rajesh, Arun/Varun) are not accepted; a real variant (Shreya/Shreyaa) still is", () => {
  expect(matchIdentity("Ramesh Kumar", "Rajesh Kumar").status).toBe("mismatch");
  expect(matchIdentity("Arun", "Varun Kumar").status).toBe("mismatch");
  expect(matchIdentity("Arun", "Arjun").status).toBe("mismatch");
  expect(matchIdentity("Shreya Gupta", "Shreyaa Gupta").status).toBe("partial");
});
