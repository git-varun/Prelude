export interface ParsedRange {
  low: number | null;
  high: number | null;
  // "<N" / ">N" bounds are exclusive (N itself is outside the range); an "a-b"
  // bound is inclusive.
  exclusive: boolean;
}

const NUM = "-?\\d+(?:\\.\\d+)?";
const LT = new RegExp(`^<\\s*(${NUM})$`);
const GT = new RegExp(`^>\\s*(${NUM})$`);
// ASCII hyphen or en dash only — anything else (e.g. free text like "see report") is
// deliberately left unparseable rather than guessed at.
const BETWEEN = new RegExp(`^(${NUM})\\s*[-–]\\s*(${NUM})$`);

// Never guesses: missing or unparseable range text returns null, for the raw
// value + raw range text to be shown as-is with no indicator.
export function parseReferenceRange(raw: string | null): ParsedRange | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === "") return null;

  const lt = LT.exec(text);
  if (lt) return { low: null, high: Number(lt[1]), exclusive: true };

  const gt = GT.exec(text);
  if (gt) return { low: Number(gt[1]), high: null, exclusive: true };

  const between = BETWEEN.exec(text);
  if (between) return { low: Number(between[1]), high: Number(between[2]), exclusive: false };

  return null;
}

export type RangeFlag = "above" | "below" | null;

export function flagForRange(value: string | null, rawRange: string | null): RangeFlag {
  if (value === null) return null;
  const numValue = Number(value.trim());
  if (Number.isNaN(numValue)) return null;

  const range = parseReferenceRange(rawRange);
  if (range === null) return null;

  if (range.high !== null && (range.exclusive ? numValue >= range.high : numValue > range.high)) return "above";
  if (range.low !== null && (range.exclusive ? numValue <= range.low : numValue < range.low)) return "below";
  return null;
}
