import { expect, test } from "bun:test";
import type { PatientDocumentEntry } from "../api/client";
import { documentDate, documentMetaLine, groupDocuments, isHeldIdentity, locateSnippet, pageText, paneGroupOf, paneView, parseLocationOffset } from "./documentPane";

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
  expect(locateSnippet("CEA 4.2 ng/mL\nPSA 1.1", "PSA 1.1")).toEqual({ start: 14, end: 21, count: 1 });
  expect(locateSnippet("abc abc", "abc")).toEqual({ start: 0, end: 3, count: 2 });
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

test("locateSnippet with duplicates: nearest the parseable location wins, else the first; count says how many", () => {
  const text = "PSA 1.1\nCEA 4\nPSA 1.1\nCEA 5\nPSA 1.1";
  expect(locateSnippet(text, "PSA 1.1")).toEqual({ start: 0, end: 7, count: 3 });
  expect(locateSnippet(text, "PSA 1.1", "chars 16-23")).toEqual({ start: 14, end: 21, count: 3 });
  expect(locateSnippet(text, "PSA 1.1", "30")?.start).toBe(28);
  expect(locateSnippet(text, "PSA 1.1", "line 3")?.start).toBe(14);
  expect(locateSnippet(text, "PSA 1.1", "bbox:1,2,3,4")?.start).toBe(0);
  expect(locateSnippet(text, "PSA 1.1", "line 99")?.start).toBe(0);
  expect(parseLocationOffset("a\nb", "line 2")).toBe(2);
  expect(parseLocationOffset("a", null)).toBeNull();
});

test("isHeldIdentity: mismatch, awaiting_oncologist and rejected are held", () => {
  for (const s of ["mismatch", "awaiting_oncologist", "rejected"]) expect(isHeldIdentity(s)).toBe(true);
  for (const s of [null, "confirmed", "match"]) expect(isHeldIdentity(s)).toBe(false);
});

const ocr = { fullText: "all text", pages: [{ pageNumber: 1, text: "one PSA 1.1" }, { pageNumber: 2, text: "PSA 1.1 and PSA 1.1" }] };

test("paneView tag: exact only when the snippet is found once on a page that exists", () => {
  const v = paneView({ ocr, page: 1, snippet: "PSA 1.1", location: null });
  expect(v.tag).toBe("Exact match · page 1");
  expect(v.text).toBe("one PSA 1.1");
  expect(v.hit).toEqual({ start: 4, end: 11 });
});

test("paneView tag: a snippet found several times is 'Page' with the count, marking the one nearest the location", () => {
  const v = paneView({ ocr, page: 2, snippet: "PSA 1.1", location: "12" });
  expect(v.tag).toBe("Page · page 2 · 2 similar lines");
  expect(v.hit).toEqual({ start: 12, end: 19 });
});

test("paneView tag: a page that exists with no snippet match (page-level fact or snippet not found) is 'Page'", () => {
  expect(paneView({ ocr, page: 1, snippet: null, location: null }).tag).toBe("Page · page 1");
  expect(paneView({ ocr, page: 1, snippet: "zzz", location: null })).toMatchObject({ tag: "Page · page 1", hit: null });
});

test("paneView tag: no page, a missing page, or no fact is 'Document' alone, never an invented page", () => {
  expect(paneView({ ocr, page: null, snippet: "PSA 1.1", location: null })).toEqual({ text: "all text", tag: "Document", hit: null });
  expect(paneView({ ocr, page: 9, snippet: "PSA 1.1", location: null })).toEqual({ text: "all text", tag: "Document", hit: null });
});

test("paneView: no OCR or empty text yields no tag", () => {
  expect(paneView({ ocr: null, page: 1, snippet: null, location: null })).toEqual({ text: null, tag: null, hit: null });
  expect(paneView({ ocr: { fullText: " ", pages: [] }, page: null, snippet: null, location: null }).tag).toBeNull();
  expect(paneView({ ocr: { fullText: "x", pages: [{ pageNumber: 1, text: "" }] }, page: 1, snippet: null, location: null }).tag).toBeNull();
});
