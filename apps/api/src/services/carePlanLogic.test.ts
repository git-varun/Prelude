import { test, expect } from "bun:test";
import { approximateDate, statedDate, derivePlanStatus, suggestMatches, type CandidateDocument } from "./carePlanLogic";

test("approximateDate parses a single simple interval relative to the advised date", () => {
  expect(approximateDate("within 2 weeks", "2026-10-13")).toBe("2026-10-27");
  expect(approximateDate("review after 10 days", "2026-10-13")).toBe("2026-10-23");
  expect(approximateDate("CT in 1 week", "2026-12-28")).toBe("2027-01-04");
  expect(approximateDate("3 months", "2026-10-13")).toBe("2027-01-13");
  expect(approximateDate("1 month", "2026-01-31")).toBe("2026-02-28");
});

test("approximateDate returns null for anything but one simple interval", () => {
  expect(approximateDate("CT chest", "2026-10-13")).toBeNull();
  expect(approximateDate("next Tuesday", "2026-10-13")).toBeNull();
  expect(approximateDate("CBC in 2 weeks, CT in 3 months", "2026-10-13")).toBeNull();
  expect(approximateDate("every other week", "2026-10-13")).toBeNull();
  expect(approximateDate("in 2 weeks", "not-a-date")).toBeNull();
});

test("approximateDate returns null for ranges and recurrences", () => {
  for (const t of ["review in 2-3 weeks", "2 to 3 weeks", "every 3 months", "monthly CBC, 3 months", "weekly for 2 weeks", "q3 months"]) {
    expect(approximateDate(t, "2026-10-13")).toBeNull();
  }
});

test("statedDate: dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd; impossible or ambiguous is null", () => {
  expect(statedDate("Review on 15/11/2026")).toBe("2026-11-15");
  expect(statedDate("Review 5-1-2027")).toBe("2027-01-05");
  expect(statedDate("on 2026-11-15")).toBe("2026-11-15");
  expect(statedDate("on 31/02/2026")).toBeNull();
  expect(statedDate("on 15/13/2026")).toBeNull();
  expect(statedDate("on 15/11/26")).toBeNull();
  expect(statedDate("CBC in 2 weeks")).toBeNull();
  expect(statedDate("15/11/2026 or 20/11/2026")).toBeNull();
});

const doc = (o: Partial<CandidateDocument>): CandidateDocument => ({
  id: "d", label: "L", imaging_modality: null, markers: [], date: "2026-11-01", ...o,
});
const item = { type: "test" as const, text: "CT chest and CA 125 within 2 weeks", advised_at: "2026-10-13" };

test("suggestMatches: modality or marker named in the test text, dated after the advice", () => {
  const ct = doc({ id: "ct", imaging_modality: "ct" });
  const ca = doc({ id: "ca", markers: ["CA-125"] });
  const mri = doc({ id: "mri", imaging_modality: "mri" });
  const cea = doc({ id: "cea", markers: ["CEA"] });
  expect(suggestMatches(item, [mri, cea, ca, ct]).map((d) => d.id).sort()).toEqual(["ca", "ct"]);
});

test("suggestMatches: not on or before the advised date, not undated, not for non-tests", () => {
  const ct = doc({ imaging_modality: "ct" });
  expect(suggestMatches(item, [{ ...ct, date: "2026-10-13" }, { ...ct, date: "2026-10-01" }, { ...ct, date: null }])).toEqual([]);
  expect(suggestMatches({ ...item, type: "procedure" }, [ct])).toEqual([]);
  expect(suggestMatches({ ...item, type: "review" }, [ct])).toEqual([]);
});

test("suggestMatches: marker names match whole words only, earliest report first", () => {
  expect(suggestMatches({ ...item, text: "CEACAM panel" }, [doc({ markers: ["CEA"] })])).toEqual([]);
  const early = doc({ id: "a", imaging_modality: "ct", date: "2026-10-20" });
  const late = doc({ id: "b", imaging_modality: "ct", date: "2026-11-20" });
  expect(suggestMatches(item, [late, early]).map((d) => d.id)).toEqual(["a", "b"]);
});

test("suggestMatches: PET-CT is not plain CT; contrast needs the word; bare MR/PET do not match", () => {
  const t = (text: string) => ({ type: "test" as const, text, advised_at: "2026-10-13" });
  expect(suggestMatches(t("PET-CT whole body"), [doc({ imaging_modality: "ct" })])).toEqual([]);
  expect(suggestMatches(t("PET CT whole body"), [doc({ imaging_modality: "ct" })])).toEqual([]);
  expect(suggestMatches(t("PET-CT whole body"), [doc({ imaging_modality: "pet_ct" })]).length).toBe(1);
  expect(suggestMatches(t("CT chest"), [doc({ imaging_modality: "ct_contrast" })])).toEqual([]);
  expect(suggestMatches(t("CT chest with contrast"), [doc({ imaging_modality: "ct_contrast" })]).length).toBe(1);
  expect(suggestMatches(t("MRI brain"), [doc({ imaging_modality: "mri_contrast" })])).toEqual([]);
  expect(suggestMatches(t("MRI brain with contrast"), [doc({ imaging_modality: "mri_contrast" })]).length).toBe(1);
  expect(suggestMatches(t("MR brain"), [doc({ imaging_modality: "mri" })])).toEqual([]);
  expect(suggestMatches(t("PET scan"), [doc({ imaging_modality: "pet_ct" })])).toEqual([]);
});

test("derivePlanStatus: confirmed match, then suggestion, then the (approximate) advised date", () => {
  const base = { due_date: "2026-10-01" as string | null, hasConfirmedMatch: false, hasSuggestion: false, today: "2026-10-13" };
  expect(derivePlanStatus({ ...base, hasConfirmedMatch: true, hasSuggestion: true })).toBe("report_seen");
  expect(derivePlanStatus({ ...base, hasSuggestion: true })).toBe("report_suggested");
  expect(derivePlanStatus(base)).toBe("past_advised");
  expect(derivePlanStatus({ ...base, due_date: "2026-10-20" })).toBe("planned");
  expect(derivePlanStatus({ ...base, due_date: null })).toBe("planned");
});
