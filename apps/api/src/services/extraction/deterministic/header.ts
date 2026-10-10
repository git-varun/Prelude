import { squash } from "./aliases";
import type { Line } from "./types";

export interface HeaderFields {
  labName: string | null;
  collectedOn: string | null;
  receivedOn: string | null;
  reportedOn: string | null;
  patientName: string | null;
  labPatientRef: string | null;
  age: string | null;
  sex: string | null;
  referringDoctor: string | null;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: string, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Day-first (Indian labs). Spaces inside the value are removed first because some PDFs are letter-spaced ("12/D ec/2024").
export function parseDate(input: string): string | null {
  const c = input.replace(/\s+/g, "");
  let m = c.match(/(\d{1,2})[\/\-]([A-Za-z]{3})[A-Za-z]*[\/\-]((?:19|20)\d{2})/);
  if (m && MON[m[2]!.toLowerCase()]) return iso(m[3]!, MON[m[2]!.toLowerCase()]!, Number(m[1]));
  m = c.match(/((?:19|20)\d{2})-(\d{2})-(\d{2})/);
  if (m) return iso(m[1]!, Number(m[2]), Number(m[3]));
  m = c.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:19|20)\d{2})/);
  if (m) return iso(m[3]!, Number(m[2]), Number(m[1]));
  m = input.match(/(\d{1,2})[\/\- ]([A-Za-z]{3})[\/\- ](\d{2})(?!\d)/);
  if (m && MON[m[2]!.toLowerCase()]) return iso(`20${m[3]}`, MON[m[2]!.toLowerCase()]!, Number(m[1]));
  return null;
}

const COLLECTED_KEYS = ["collectedon", "collectiondate", "collectiondatetime", "samplecolldate", "samplecollecteddate", "sampledrawn", "sampledatetime", "sampledate", "collecteddate"];
const RECEIVED_KEYS = ["receivedon", "receivingon", "samplereceived"];
const REPORTED_KEYS = ["reporteddate", "reportedon", "reportdatetime", "reportingdatetime", "reportdate"];
const NAME_KEYS = ["patientname", "customername", "name"];
const REF_KEYS = ["patientid", "pateintid", "patientregno", "maxidlabid", "uhid", "barcodeno"];
const AGE_KEYS = ["agegender", "agesex", "age"];
const DOCTOR_KEYS = ["referredby", "referedby", "refby", "refdoctor", "referdoctor", "doctorname"];
const LAB_PAIR_KEYS = ["testingdoneby", "testperformedat"];

// A cell that starts a new `Label :` pair, so a blank `Address :` cell must not take it as its value.
const LOOKS_LIKE_PAIR = /^[A-Za-z][A-Za-z .\/()_-]{1,35}\s*:/;
const BARE_NAME = /^(mr|mrs|ms|miss|master|baby|dr|shri|smt)\.?\s+[A-Za-z]/i;
const COMPANY = /([A-Z][A-Za-z0-9&.' -]{2,60}?\b(?:Pvt\.?\s*Ltd\.?|Private Limited|LLP|Limited))/;

interface Pair {
  key: string;
  value: string;
}

function pairsOf(line: Line): Pair[] {
  const merged: string[] = [];
  for (const c of line.cells) {
    if (c.text.startsWith(":") && merged.length > 0) merged[merged.length - 1] += ` ${c.text}`;
    else merged.push(c.text);
  }
  const out: Pair[] = [];
  for (let i = 0; i < merged.length; i++) {
    const cell = merged[i]!;
    const at = cell.indexOf(":");
    if (at <= 0 || at > 40) continue;
    let value = cell.slice(at + 1).trim();
    if (!value && i + 1 < merged.length && !LOOKS_LIKE_PAIR.test(merged[i + 1]!)) value = merged[++i]!.replace(/^:\s*/, "").trim();
    out.push({ key: squash(cell.slice(0, at)), value });
  }
  return out;
}

function sexAndAge(value: string): { age: string | null; sex: string | null } {
  const age = value.match(/(\d{1,3})/)?.[1] ?? null;
  const words = [...value.matchAll(/\b(male|female)\b/gi)];
  if (words.length > 0) return { age, sex: words[words.length - 1]![1]![0]!.toUpperCase() };
  const letters = [...value.matchAll(/\b([MF])\b/gi)];
  return { age, sex: letters.length > 0 ? letters[letters.length - 1]![1]!.toUpperCase() : null };
}

const LAB_WORDS = /(laborator|diagnos|patholog|hospital|healthcare|clinic|\blabs?\b)/i;
const TITLE_WORDS = /\b(report|investigation)\b/i;

function findLabName(lines: Line[], pairs: Pair[]): string | null {
  for (const line of lines.slice(0, 12)) {
    const text = line.cells.map((c) => c.text).join(" ");
    if (LAB_WORDS.test(text) && !text.includes(":") && !TITLE_WORDS.test(text) && text.length <= 80) {
      return text.replace(/^testing done by\s+/i, "").trim();
    }
  }
  const fromPair = pairs.find((p) => LAB_PAIR_KEYS.includes(p.key) && p.value);
  if (fromPair) return fromPair.value;
  for (const line of lines) {
    const text = line.cells.map((c) => c.text).join(" ");
    const company = LAB_WORDS.test(text) ? text.match(COMPANY)?.[1] : undefined;
    if (company) return company.trim();
  }
  return null;
}

function findBareName(lines: Line[]): string | null {
  for (const line of lines.slice(0, 15)) {
    const first = line.cells[0]?.text ?? "";
    if (BARE_NAME.test(first) && !first.includes(":") && first.split(/\s+/).length <= 5) return first;
  }
  return null;
}

export function parseHeader(lines: Line[]): HeaderFields {
  const pairs = lines.flatMap(pairsOf);
  const first = (keys: string[]): string | null => pairs.find((p) => keys.includes(p.key) && p.value)?.value ?? null;
  const dateOf = (keys: string[]): string | null => {
    for (const p of pairs) {
      if (keys.includes(p.key)) {
        const d = parseDate(p.value);
        if (d) return d;
      }
    }
    return null;
  };
  const ageGender = first(AGE_KEYS);
  const { age, sex } = ageGender ? sexAndAge(ageGender) : { age: null, sex: null };
  return {
    labName: findLabName(lines, pairs),
    collectedOn: dateOf(COLLECTED_KEYS) ?? dateOf(["date"]),
    receivedOn: dateOf(RECEIVED_KEYS),
    reportedOn: dateOf(REPORTED_KEYS),
    patientName: first(NAME_KEYS) ?? findBareName(lines),
    labPatientRef: first(REF_KEYS),
    age,
    sex,
    referringDoctor: first(DOCTOR_KEYS),
  };
}
