import { expect, test } from "bun:test";
import { canReprocess, failedStepLabel } from "./reprocess";

const base = { document_type: "blood", ocr_status: "done", extraction_status: "done", identity_status: null } as const;

test("a document can be reprocessed only when its OCR or its extraction failed", () => {
  expect(canReprocess({ ...base, ocr_status: "failed", extraction_status: "pending" })).toBe(true);
  expect(canReprocess({ ...base, extraction_status: "failed" })).toBe(true);
  expect(canReprocess(base)).toBe(false);
  expect(canReprocess({ ...base, extraction_status: "partial" })).toBe(false);
  expect(canReprocess({ ...base, ocr_status: "pending", extraction_status: "pending" })).toBe(false);
});

test("'other' and rejected documents are never reprocessed", () => {
  expect(canReprocess({ ...base, document_type: "other", ocr_status: "failed", extraction_status: "not_extracted" })).toBe(false);
  expect(canReprocess({ ...base, ocr_status: "failed", identity_status: "rejected" })).toBe(false);
});

test("the failed step is named", () => {
  expect(failedStepLabel({ ocr_status: "failed" })).toContain("OCR");
  expect(failedStepLabel({ ocr_status: "done" })).toContain("facts");
});
