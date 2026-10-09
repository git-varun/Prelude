import { test, expect } from "bun:test";
import type { ExtractedFactCandidate } from "@prelude/shared";
import type { ExpectedFact } from "./types";
import { matchFacts, scoreDoc, valuesEqual, unitsEqual, rangesEqual } from "./score";

export const cand = (o: Partial<ExtractedFactCandidate> = {}): ExtractedFactCandidate => ({
  fieldType: "marker_value", trackedMarkerLabel: "Haemoglobin", value: "10.1", unit: "g/dL",
  referenceRange: "13.0-17.0", asOfDate: "2026-04-29", coverageStatus: "value_found",
  sourcePage: 1, sourceLocation: null, sourceSnippet: "snip", confidence: 0.9, ...o,
});
export const exp = (o: Partial<ExpectedFact> = {}): ExpectedFact => ({
  fieldType: "marker_value", markerLabel: "Haemoglobin", canonicalMarker: null, value: "10.1",
  unit: "g/dL", referenceRange: "13.0-17.0", asOfDate: "2026-04-29", sourcePage: 1, ...o,
});

test("valuesEqual tolerates numeric formatting but not different numbers", () => {
  expect(valuesEqual("10.0", "10")).toBe(true);
  expect(valuesEqual("1,200", "1200")).toBe(true);
  expect(valuesEqual("<0.5", "<0.5")).toBe(true);
  expect(valuesEqual("<0.5", "0.5")).toBe(false);
  expect(valuesEqual("10.1", "10.2")).toBe(false);
  expect(valuesEqual(null, null)).toBe(true);
  expect(valuesEqual(null, "1")).toBe(false);
  expect(valuesEqual("", "0")).toBe(false);
});

test("unitsEqual and rangesEqual ignore whitespace and case", () => {
  expect(unitsEqual("g/dL", "G/DL")).toBe(true);
  expect(rangesEqual("13.0 - 17.0", "13.0-17.0")).toBe(true);
  expect(rangesEqual(null, "13-17")).toBe(false);
});

test("matchFacts pairs by label+date, ignoring label punctuation/case", () => {
  const r = matchFacts([exp({ markerLabel: "HAEMOGLOBIN (Hb)" })], [cand({ trackedMarkerLabel: "Haemoglobin (Hb)" })]);
  expect(r.pairs).toHaveLength(1);
  expect(r.missed).toHaveLength(0);
  expect(r.spurious).toHaveLength(0);
});

test("matchFacts falls back to label-only when dates differ", () => {
  const r = matchFacts([exp()], [cand({ asOfDate: "2026-04-30" })]);
  expect(r.pairs).toHaveLength(1);
});

test("altDates counts as a date match", () => {
  const s = scoreDoc("d", [exp({ altDates: ["2026-04-30"] })], [cand({ asOfDate: "2026-04-30" })], []);
  expect(s.results[0]!.dateOk).toBe(true);
});

test("duplicate labels pair one-to-one and never double count", () => {
  const e = [exp({ value: "74" }), exp({ value: "4.2" })];
  const c = [cand({ value: "4.2" }), cand({ value: "74" })];
  const r = matchFacts(e, c);
  expect(r.pairs).toHaveLength(2);
  expect(new Set(r.pairs.map((p) => p.extracted)).size).toBe(2);
});

test("extra extracted facts are spurious; absent ones are missed", () => {
  const r = matchFacts([exp({ markerLabel: "RBC" })], [cand({ trackedMarkerLabel: "WBC" })]);
  expect(r.missed).toHaveLength(1);
  expect(r.spurious).toHaveLength(1);
});

test("labelless fact types match even when the extractor adds a label", () => {
  const e = exp({ fieldType: "radiology_impression", markerLabel: null, value: "Normal" });
  const c = cand({ fieldType: "radiology_impression", trackedMarkerLabel: "Chest", value: "Normal" });
  expect(matchFacts([e], [c]).pairs).toHaveLength(1);
});

test("scoreDoc marks a fact correct only when value, unit and date are right", () => {
  const s = scoreDoc("d", [exp(), exp({ markerLabel: "RBC", value: "3.6" })], [cand(), cand({ trackedMarkerLabel: "RBC", value: "3.7" })], []);
  expect(s.results.filter((r) => r.correct)).toHaveLength(1);
  expect(s.results.find((r) => r.expected.markerLabel === "RBC")!.valueOk).toBe(false);
});

test("provider failure yields misses, not a crash", () => {
  const s = scoreDoc("d", [exp(), exp({ markerLabel: "RBC" })], [], ["marker_value"]);
  expect(s.missed).toHaveLength(2);
  expect(s.failedFieldTypes).toEqual(["marker_value"]);
});
