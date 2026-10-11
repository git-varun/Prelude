const TITLES = new Set(["mr", "mrs", "ms", "dr", "shri", "smt", "master", "baby"]);

// Relational markers (s/o, d/o, w/o, c/o, b/o, "son of", "wife of", ... and OCR variants such as "s / o" or "d/0")
// introduce a relative's name (common on Indian lab reports), never the patient's own: everything from the marker on is
// dropped, so a relative's name can never make a different person look like the patient.
const RELATIONAL = /(^|\s)(?:[sdwcb]\s*\/\s*[o0]|(?:son|daughter|wife|husband|baby|ward)\s+of)(?=\s|$).*$/i;

export function normalizeName(name: string): string[] {
  const stripped = name.toLowerCase().replace(RELATIONAL, "").replace(/[^a-z\s]/g, " ");
  // A name made only of titles ("Mr.") has no tokens: it is no name at all.
  return stripped.split(/\s+/).filter((t) => t && !TITLES.has(t));
}

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

export function jaroWinkler(s1: string, s2: string): number {
  const jaroScore = jaro(s1, s2);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaroScore + prefix * 0.1 * (1 - jaroScore);
}

function isInitialOf(initial: string, full: string): boolean {
  return initial.length === 1 && full.length > 1 && full[0] === initial;
}

// Equal-length names where every token is equal or one side is just the initial of the other ("V." / "Varun").
function initialsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i] || isInitialOf(t, b[i]!) || isInitialOf(b[i]!, t));
}

// 0.95 separates real spelling variants (Shreya/Shreyaa 0.97) from different people (Ramesh/Rajesh 0.91, Arun/Varun 0.93).
const tokenSimilar = (x: string, y: string) => x === y || jaroWinkler(x, y) >= 0.95;

export type IdentityMatchStatus = "matched" | "partial" | "mismatch" | "unknown";

export interface IdentityMatch {
  status: IdentityMatchStatus;
  reason: string;
}

// Rules, in priority order, from docs/superpowers/specs/2026-10-10-deterministic-extraction-design.md "Identity match".
export function matchIdentity(patientName: string | null, reportName: string | null): IdentityMatch {
  if (!patientName?.trim() || !reportName?.trim()) {
    return { status: "unknown", reason: "no name on the report or no patient name on file" };
  }
  const a = normalizeName(patientName);
  const b = normalizeName(reportName);
  // A name with no real word (punctuation, digits, "N/A" → single letters) is absent, not a different person.
  const hasWord = (tokens: string[]) => tokens.some((t) => t.length >= 2);
  if (!hasWord(a) || !hasWord(b)) {
    return { status: "unknown", reason: "no name on the report or no patient name on file" };
  }
  if (a.length === 0 || b.length === 0) return { status: "unknown", reason: "no usable name tokens" };
  // A real name has a handful of tokens; more means OCR field bleed ("Suresh Kumar Age : 45 Yrs ..."): hold it.
  if (a.length > 6 || b.length > 6) return { status: "mismatch", reason: "implausibly long name" };
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === setB.size && [...setA].every((t) => setB.has(t))) {
    return { status: "matched", reason: "all name tokens match" };
  }

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 2 && shorter.every((t) => longer.includes(t))) {
    return { status: "matched", reason: "all tokens of the shorter name appear in the longer name" };
  }

  // Both names carry a surname and the surnames differ: a different person, even with the same first name.
  // Safety: a conflicting name is evidence of someone else and is held; only the absence of evidence is partial/unknown.
  if (a.length >= 2 && b.length >= 2) {
    const lastA = a[a.length - 1]!;
    const lastB = b[b.length - 1]!;
    if (!tokenSimilar(lastA, lastB) && !isInitialOf(lastA, lastB) && !isInitialOf(lastB, lastA)) {
      return { status: "mismatch", reason: "surnames differ" };
    }
  }

  if (initialsMatch(a, b)) return { status: "partial", reason: "matches by initials" };
  // A single-token report is first-name-only evidence only when it matches the other name's FIRST token; a surname
  // alone ("Kumar") or someone else's first name is not evidence for this patient.
  if (shorter.length === 1) {
    return tokenSimilar(shorter[0]!, longer[0]!)
      ? { status: "partial", reason: "first name only" }
      : { status: "mismatch", reason: "a single name token that is not the first name" };
  }
  if (shorter.length >= 2 && shorter.every((t) => longer.some((u) => tokenSimilar(t, u)))) {
    return { status: "partial", reason: "every name token has a close match (transliteration)" };
  }
  return { status: "mismatch", reason: "no shared name tokens or similarity" };
}
