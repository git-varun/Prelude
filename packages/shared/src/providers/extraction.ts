import type { FieldType, DocumentType } from "../index";
import type { OcrResult } from "./ocr";

// Deliberately excludes 'conflicting_sources' — only the rules engine
// (services/rules.ts, M2/M7) may ever set that; a single extraction pass
// over a single document has no other source to conflict with.
export type ExtractedCoverageStatus = "not_assessed" | "value_found" | "not_applicable" | "extraction_uncertain";

export interface ExtractedFactCandidate {
  fieldType: FieldType;
  // Raw extracted marker name when it doesn't confidently match the
  // controlled list — left for the rules engine / review to resolve against
  // TRACKED_MARKER, never guessed into a controlled name here.
  trackedMarkerLabel?: string;
  value: string | null;
  unit: string | null;
  referenceRange: string | null;
  // ISO date, or null if undeterminable — never guessed.
  asOfDate: string | null;
  coverageStatus: ExtractedCoverageStatus;
  sourcePage: number | null;
  sourceLocation: string | null;
  sourceSnippet: string | null;
  confidence: number;
}

export interface ExtractionResult {
  // Candidates from the field-type calls that succeeded.
  candidates: ExtractedFactCandidate[];
  // Field types whose call failed. Empty candidates with no failed field
  // types means "nothing extractable"; empty candidates WITH failures means
  // the pass didn't actually analyze the document.
  failedFieldTypes: FieldType[];
  // Error message per failed field type, for the document's extraction_error.
  failureMessages?: Partial<Record<FieldType, string>>;
}

export interface ExtractionProvider {
  readonly name: string;
  extractFacts(ocr: OcrResult, documentType: DocumentType): Promise<ExtractionResult>;
}
