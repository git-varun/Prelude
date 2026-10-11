import type { DocumentType, ExtractionProvider, ExtractionResult, OcrResult } from "@prelude/shared";
import { FIELD_TYPES_BY_DOCUMENT_TYPE } from "../anthropicExtraction";
import { parseDocument, toCandidates } from "./pipeline";

// Phase 1: blood documents only. Radiology/prescription narrative is phase 3 (LLM narrative tier) and is
// reported as not handled so it can never look like "nothing extractable".
export class DeterministicExtractionProvider implements ExtractionProvider {
  readonly name = "deterministic";

  async extractFacts(ocr: OcrResult, documentType: DocumentType): Promise<ExtractionResult> {
    if (documentType !== "blood") {
      const failedFieldTypes = FIELD_TYPES_BY_DOCUMENT_TYPE[documentType];
      const failureMessages = Object.fromEntries(failedFieldTypes.map((f) => [f, "not handled by the deterministic parser (phase 3)"]));
      return { candidates: [], failedFieldTypes, failureMessages };
    }
    const parsed = parseDocument(ocr);
    return {
      candidates: toCandidates(parsed),
      failedFieldTypes: [],
      stats: { rows: parsed.rows.length, unplacedNumericLines: parsed.unplacedNumeric.length, lines: parsed.lineCount },
      header: parsed.header,
    };
  }
}
