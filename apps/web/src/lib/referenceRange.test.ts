import { test, expect } from "bun:test";
import { parseReferenceRange, flagForRange } from "./referenceRange";

test("parses a simple numeric range", () => {
  expect(parseReferenceRange("0-5")).toEqual({ low: 0, high: 5, exclusive: false });
});

test("parses a decimal range with an en dash", () => {
  expect(parseReferenceRange("0.0–5.0")).toEqual({ low: 0, high: 5, exclusive: false });
});

test("parses a less-than range as an exclusive upper bound", () => {
  expect(parseReferenceRange("<5")).toEqual({ low: null, high: 5, exclusive: true });
});

test("parses a greater-than range as an exclusive lower bound", () => {
  expect(parseReferenceRange(">40")).toEqual({ low: 40, high: null, exclusive: true });
});

test("returns null for missing or unparseable range text", () => {
  expect(parseReferenceRange(null)).toBeNull();
  expect(parseReferenceRange("")).toBeNull();
  expect(parseReferenceRange("see report")).toBeNull();
});

test("flagForRange returns 'above' when the value exceeds the upper bound", () => {
  expect(flagForRange("7.2", "0-5")).toBe("above");
});

test("flagForRange returns 'below' when the value is under the lower bound", () => {
  expect(flagForRange("30", ">40")).toBe("below");
});

test("'<N' and '>N' bounds are exclusive: a value equal to the bound is still outside it", () => {
  expect(flagForRange("5", "<5")).toBe("above");
  expect(flagForRange("40", ">40")).toBe("below");
});

test("flagForRange returns null when the value is within range", () => {
  expect(flagForRange("3.0", "0-5")).toBeNull();
});

test("flagForRange never guesses a range: null for missing or unparseable range text", () => {
  expect(flagForRange("7.2", null)).toBeNull();
  expect(flagForRange("7.2", "see report")).toBeNull();
});

test("flagForRange returns null when the value itself isn't numeric", () => {
  expect(flagForRange("pending", "0-5")).toBeNull();
  expect(flagForRange(null, "0-5")).toBeNull();
});
