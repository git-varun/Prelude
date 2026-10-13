import { expect, test } from "bun:test";
import { latestItem } from "./latestItem";

const it = (id: string, d: string | null) => ({ id, as_of_date: d });

test("empty list gives null", () => {
  expect(latestItem([])).toBeNull();
});

test("picks the latest dated item regardless of order", () => {
  expect(latestItem([it("a", "2026-03-01"), it("b", "2026-01-01")])?.id).toBe("a");
});

test("an undated item never displaces a dated one", () => {
  expect(latestItem([it("a", "2026-01-01"), it("u", null)])?.id).toBe("a");
  expect(latestItem([it("u", null), it("a", "2026-01-01")])?.id).toBe("a");
});

test("uses an undated item only when none is dated", () => {
  expect(latestItem([it("u1", null), it("u2", null)])?.id).toBe("u2");
});
