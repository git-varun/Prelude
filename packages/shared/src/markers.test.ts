import { test, expect } from "bun:test";
import { CONTROLLED_MARKERS, DISEASE_SITE_PANELS, FALLBACK_MARKER_SET, matchMarker } from "./markers";

test("matchMarker matches a canonical name exactly", () => {
  expect(matchMarker("CEA")).toBe("CEA");
});

test("matchMarker is case- and space-tolerant against aliases", () => {
  expect(matchMarker("carcinoembryonic antigen")).toBe("CEA");
  expect(matchMarker("  CEA  ")).toBe("CEA");
  expect(matchMarker("psa")).toBe("Total PSA");
  expect(matchMarker("tPSA")).toBe("Total PSA");
});

test("matchMarker never matches Free PSA to Total PSA", () => {
  expect(matchMarker("Free PSA")).toBeNull();
});

test("matchMarker never matches CEACAM to CEA", () => {
  expect(matchMarker("CEACAM")).toBeNull();
});

test("matchMarker never matches CA 27-29 to CA 15-3", () => {
  expect(matchMarker("CA 27-29")).toBeNull();
});

test("matchMarker never matches a qualitative urine hCG to Beta-hCG", () => {
  expect(matchMarker("qualitative urine hCG")).toBeNull();
});

test("matchMarker returns null for an unrecognized label", () => {
  expect(matchMarker("Some Unrelated Lab Value")).toBeNull();
});

test("CONTROLLED_MARKERS lists the full canonical set", () => {
  expect(CONTROLLED_MARKERS).toEqual([
    "CEA", "CA 19-9", "CA-125", "CA 15-3", "AFP", "Total PSA", "Beta-hCG",
    "LDH", "HE4", "CA 72-4", "Thyroglobulin (Tg)", "Anti-Tg (TgAb)", "Calcitonin",
  ]);
});

test("DISEASE_SITE_PANELS has the seven site panels from the Decisions Log", () => {
  expect(DISEASE_SITE_PANELS["Colorectal/Lower GI"]).toEqual(["CEA", "CA 19-9"]);
  expect(DISEASE_SITE_PANELS["HPB"]).toEqual(["CA 19-9", "AFP", "CEA"]);
  expect(DISEASE_SITE_PANELS["Breast"]).toEqual(["CA 15-3", "CEA"]);
  expect(DISEASE_SITE_PANELS["Gynecologic"]).toEqual(["CA-125", "HE4", "CEA"]);
  expect(DISEASE_SITE_PANELS["Urologic"]).toEqual(["Total PSA", "AFP", "Beta-hCG", "LDH"]);
  expect(DISEASE_SITE_PANELS["Upper GI"]).toEqual(["CEA", "CA 19-9", "CA 72-4"]);
  expect(DISEASE_SITE_PANELS["Endocrine/Thyroid"]).toEqual(["Thyroglobulin (Tg)", "Anti-Tg (TgAb)", "Calcitonin", "CEA"]);
  expect(Object.keys(DISEASE_SITE_PANELS)).toHaveLength(7);
});

test("FALLBACK_MARKER_SET is the 6-marker fallback", () => {
  expect(FALLBACK_MARKER_SET).toEqual(["CEA", "CA 19-9", "CA-125", "CA 15-3", "AFP", "Total PSA"]);
});
