import { test, expect } from "bun:test";
import { FIELD_TYPES_BY_DOCUMENT_TYPE } from "./anthropicExtraction";

test("an 'other' document has no extractable field types (M3-10: stored, never extracted)", () => {
  expect(FIELD_TYPES_BY_DOCUMENT_TYPE.other).toEqual([]);
});
