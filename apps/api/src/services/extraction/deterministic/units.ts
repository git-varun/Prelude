const compact = (s: string) => s.toLowerCase().replace(/\s+/g, "");

// Equivalent spellings of the same unit, after lowercasing, removing whitespace and mapping µ/μ -> u.
const UNIT_EQUIV: Record<string, string> = {
  "thou/ul": "10^3/ul", "k/ul": "10^3/ul", "x10^3/ul": "10^3/ul", "x10³/ul": "10^3/ul", "10³/ul": "10^3/ul", "10^9/l": "10^3/ul",
  "millions/mm³": "10^6/ul", "millions/mm3": "10^6/ul", "mill/mm3": "10^6/ul", "m/ul": "10^6/ul", "x10^6/ul": "10^6/ul",
};

export function normUnit(u: string): string {
  const c = compact(u).replace(/[µμ]/g, "u");
  return UNIT_EQUIV[c] ?? c;
}

export function unitsEquivalent(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normUnit(a) === normUnit(b);
}
