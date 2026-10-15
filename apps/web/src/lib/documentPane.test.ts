import { expect, test } from "bun:test";
import type { PatientDocumentEntry } from "../api/client";
import { documentDate, documentMetaLine, groupDocuments, locateSnippet, pageText, paneGroupOf, provenanceTag } from "./documentPane";

const doc = (id: string, o: Partial<PatientDocumentEntry> = {}): PatientDocumentEntry => ({
  id, document_type: "blood", source_origin: "own_hospital", lab_name: null, identity_status: null, extraction_status: "done",
  uploaded_at: "2026-03-04T10:00:00Z", has_text: true, collected_on: null, reported_on: null, outside_facility: null, ...o,
});

test("types map to the four README groups; pathology and discharge sit under Other", () => {
  expect(paneGroupOf("blood")).toBe("Reports");
  expect(paneGroupOf("radiology")).toBe("Radiology");
  expect(paneGroupOf("prescription")).toBe("Prescriptions");
  for (const t of ["other", "pathology", "discharge"]) expect(paneGroupOf(t)).toBe("Other");
});

test("groupDocuments orders groups as the README does, keeps document order and drops empty groups", () => {
  const groups = groupDocuments([doc("a", { document_type: "other" }), doc("b", { document_type: "prescription" }), doc("c"), doc("d", { document_type: "blood" })]);
  expect(groups.map((g) => g.group)).toEqual(["Reports", "Prescriptions", "Other"]);
  expect(groups[0]!.docs.map((d) => d.id)).toEqual(["c", "d"]);
  expect(groupDocuments([])).toEqual([]);
});

test("documentDate prefers the report date, then the collection date, then the upload date", () => {
  expect(documentDate(doc("a", { reported_on: "2026-02-02", collected_on: "2026-02-01" }))).toBe("2026-02-02");
  expect(documentDate(doc("a", { collected_on: "2026-02-01" }))).toBe("2026-02-01");
  expect(documentDate(doc("a"))).toBe("2026-03-04");
});

test("documentMetaLine: lab, date, and outside/elsewhere only when they exist", () => {
  expect(documentMetaLine(doc("a", { lab_name: "Metro Labs", collected_on: "2026-02-01" }))).toBe("Metro Labs · 2026-02-01");
  expect(documentMetaLine(doc("a"))).toBe("2026-03-04");
  expect(documentMetaLine(doc("a", { source_origin: "outside_paper" }))).toBe("2026-03-04 · outside");
  expect(documentMetaLine(doc("a", { source_origin: "outside_cd", outside_facility: "Apollo", lab_name: "L" }))).toBe("L · 2026-03-04 · Apollo · elsewhere");
});

test("locateSnippet finds the first match and returns null for missing or empty snippets", () => {
  expect(locateSnippet("CEA 4.2 ng/mL\nPSA 1.1", "PSA 1.1")).toEqual({ start: 14, end: 21 });
  expect(locateSnippet("abc abc", "abc")).toEqual({ start: 0, end: 3 });
  expect(locateSnippet("abc", "zzz")).toBeNull();
  expect(locateSnippet("abc", null)).toBeNull();
  expect(locateSnippet("abc", "")).toBeNull();
});

test("pageText picks the page, falls back to the full text, and is null without OCR", () => {
  const ocr = { fullText: "all", pages: [{ pageNumber: 1, text: "one" }, { pageNumber: 2, text: "two" }] };
  expect(pageText(ocr, 2)).toBe("two");
  expect(pageText(ocr, 9)).toBe("all");
  expect(pageText(ocr, null)).toBe("all");
  expect(pageText(null, 1)).toBeNull();
});

test("provenanceTag: exact only when the level is exact and the snippet is on the page; otherwise Document", () => {
  expect(provenanceTag({ level: "exact", snippet: "PSA", text: "a PSA b", page: 2 })).toBe("Exact match · page 2");
  expect(provenanceTag({ level: "exact", snippet: "PSA", text: "nothing here", page: 2 })).toBe("Document · page 2");
  expect(provenanceTag({ level: "exact", snippet: "PSA", text: null, page: 2 })).toBe("Document · page 2");
  expect(provenanceTag({ level: "page", snippet: "PSA", text: "a PSA b", page: 3 })).toBe("Document · page 3");
  expect(provenanceTag({ level: "document", snippet: null, text: "x", page: null })).toBe("Document · page 1");
  expect(provenanceTag({ level: null, snippet: null, text: null, page: null })).toBe("Document · page 1");
});
