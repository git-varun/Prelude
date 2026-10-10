import { test, expect } from "bun:test";
import { linesFromText } from "./lines";
import { parseDate, parseHeader } from "./header";

const header = (text: string) => parseHeader(linesFromText(text, 1));

test("parseDate handles the formats seen on real labs and rejects impossible dates", () => {
  expect(parseDate("29/Apr/2026 10:00 AM")).toBe("2026-04-29");
  expect(parseDate("08-May-26 15:54")).toBe("2026-05-08");
  expect(parseDate("20.07.2026")).toBe("2026-07-20");
  expect(parseDate("20-07-2026 01:03:PM")).toBe("2026-07-20");
  expect(parseDate("12/D ec/202410:01PM")).toBe("2024-12-12");
  expect(parseDate("2026-03-14")).toBe("2026-03-14");
  expect(parseDate("31/13/2026")).toBeNull();
  expect(parseDate("nonsense")).toBeNull();
});

test("key : value pairs across cells", () => {
  const h = header(
    [
      "SYNTHETIC DIAGNOSTIC LABS",
      "Patient Name : Mr. TEST PERSON      PateintID : LAB/123",
      "Age/Gender : 28 Y/Male      Collected On : 08/Apr/2026 10:00 AM",
      "Refered By : Dr. SELF      Reported Date : 09/Apr/2026 05:29 AM",
    ].join("\n"),
  );
  expect(h).toMatchObject({
    labName: "SYNTHETIC DIAGNOSTIC LABS", patientName: "Mr. TEST PERSON", labPatientRef: "LAB/123",
    age: "28", sex: "M", collectedOn: "2026-04-08", reportedOn: "2026-04-09", referringDoctor: "Dr. SELF",
  });
});

test("a colon in its own cell and a label ending in a colon both bind to the value", () => {
  const h = header("Reported Date      : 30/Apr/2026 07:58 AM\nNAME:      TEST PERSON      AGE/SEX:      58 YRS /M\nDATE:      20.07.2026");
  expect(h).toMatchObject({ reportedOn: "2026-04-30", patientName: "TEST PERSON", age: "58", sex: "M", collectedOn: "2026-07-20" });
});

test("letter-spaced label and value still parse", () => {
  const h = header("S ample C oll. D ate:      12/D ec/202410:01PM");
  expect(h.collectedOn).toBe("2024-12-12");
});

test("a specific collection key beats a generic Date", () => {
  const h = header("Date : 01/01/2020      Collection Date : 05/03/2026");
  expect(h.collectedOn).toBe("2026-03-05");
});

test("age/sex variants: M/58 Y, and the last standalone sex token wins", () => {
  expect(header("Age/Gender : M/58 Y")).toMatchObject({ age: "58", sex: "M" });
  expect(header("Age/Gender : 28 Y 0 M 0 D /F")).toMatchObject({ age: "28", sex: "F" });
});

test("a report title is not taken as the lab name", () => {
  expect(header("Laboratory Investigation Report\nPatient Name : X Y").labName).toBeNull();
});

test("missing fields are null", () => {
  expect(header("nothing useful here")).toEqual({
    labName: null, collectedOn: null, receivedOn: null, reportedOn: null, patientName: null,
    labPatientRef: null, age: null, sex: null, referringDoctor: null,
  });
});
