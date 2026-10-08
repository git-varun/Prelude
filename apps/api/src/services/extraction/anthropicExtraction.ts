import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { DocumentType, ExtractedFactCandidate, ExtractionProvider, ExtractionResult, FieldType, OcrResult } from "@prelude/shared";

const MODEL = process.env.EXTRACTION_MODEL ?? "claude-sonnet-5-5";

export const CandidateSchema = z.object({
  trackedMarkerLabel: z.string().nullable(),
  value: z.string().nullable(),
  unit: z.string().nullable(),
  referenceRange: z.string().nullable(),
  asOfDate: z.string().nullable(),
  coverageStatus: z.enum(["not_assessed", "value_found", "not_applicable", "extraction_uncertain"]),
  sourcePage: z.number().int().nullable(),
  sourceLocation: z.string().nullable(),
  sourceSnippet: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const ExtractionResultSchema = z.object({
  candidates: z.array(CandidateSchema),
});

export type RawCandidate = z.infer<typeof CandidateSchema>;

// docs/02 M2: which field types a document of this type could plausibly
// state, so extraction runs one prompted call per relevant field_type
// rather than all five against every upload.
export const FIELD_TYPES_BY_DOCUMENT_TYPE: Record<DocumentType, FieldType[]> = {
  blood: ["marker_value", "reference_range"],
  prescription: ["treatment_regimen"],
  radiology: ["radiology_impression", "disease_status_trend"],
};

export function pageAnnotatedText(ocr: OcrResult): string {
  if (ocr.pages.length === 0) return ocr.fullText;
  return ocr.pages.map((page) => `--- Page ${page.pageNumber} ---\n${page.text}`).join("\n\n");
}

// Exported for testing the prompt text itself (the marker-matching instruction below).
export function promptFor(fieldType: FieldType, documentType: DocumentType, ocrText: string): string {
  const common = `You are extracting structured clinical data from OCR'd text of a ${documentType} document for an oncology patient snapshot tool. This is a decision-support aid, not a diagnostic system — extract only what the document explicitly states. Never infer, guess, or fill in a value the source doesn't contain.

Rules:
- If a field cannot be determined from the text, use null for that field — never fabricate a plausible-looking value.
- asOfDate must be an ISO date (YYYY-MM-DD) taken from the document (report date, collection date, etc.), or null if none is stated.
- confidence is your own calibrated confidence (0.0-1.0) that the extracted value is correct and complete.
- coverageStatus is your own initial assessment: 'value_found' if you extracted a usable value; 'not_assessed' if there's no evidence of this in the document at all; 'not_applicable' if the document explicitly states the test/field was not performed or doesn't apply; 'extraction_uncertain' if the text is ambiguous, low-confidence, or contradictory. This is a signal, not the final answer — a separate deterministic step may override it.
- The text below is marked with "--- Page N ---" separators. Use these to set sourcePage accurately. sourceSnippet must be a short verbatim quote from the text; use null for sourcePage/sourceLocation/sourceSnippet if you can't determine them — never fabricate a location.
- Return one candidate per distinct fact found; return an empty candidates array if nothing relevant is present.

OCR text:
"""
${ocrText}
"""`;

  switch (fieldType) {
    case "marker_value":
      return `${common}

Task: extract tumor marker values (lab test results with a numeric or coded value).
For each marker found, set trackedMarkerLabel to the marker's name exactly as it appears in the
document — do not try to match, normalize, or map it to any controlled list yourself; a separate
deterministic step does that matching from the raw label, and it cannot be trusted to agree with a
judgment call made here. value/unit/referenceRange are that marker's own reported value, unit, and
reference range, if stated alongside it.`;

    case "reference_range":
      return `${common}

Task: extract reference ranges stated as first-class information (e.g. a standalone normal-range table
or panel), separate from a specific marker's own value line — those belong to marker_value candidates
instead, via their own referenceRange field. Put the reference range text in value, and set
trackedMarkerLabel to the field/test this range applies to, if named.`;

    case "treatment_regimen":
      return `${common}

Task: extract the treatment regimen/protocol explicitly stated (drug names, cycle or line information,
dosage) — only what's written, never a therapy inferred from a diagnosis. Put the regimen description
in value.`;

    case "radiology_impression":
      return `${common}

Task: extract the radiologist's impression/conclusion section verbatim, not the full findings section.
Put the impression text in value.`;

    case "disease_status_trend":
      return `${common}

Task: extract any explicit statement of disease status or trend the document itself makes (e.g. "stable
disease", "partial response", "progression") — only if the document states this conclusion directly. Do
not compute or infer a trend from raw values yourself; that's a separate downstream step. Put the stated
status in value.`;
  }
}

// The LLM's asOfDate is untrusted: it goes into a DATE column, where Postgres
// would silently reinterpret "01/08/2026" or reject garbage. Only a real
// YYYY-MM-DD calendar date survives; anything else becomes null (needs manual date).
export function normalizeAsOfDate(value: string | null): string | null {
  if (value === null) return null;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith("0000")) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

export function toExtractedFactCandidate(fieldType: FieldType, candidate: RawCandidate): ExtractedFactCandidate {
  // No verification_state field exists on ExtractedFactCandidate at all —
  // the extraction pass cannot self-authorize trust (docs/02 M2), so there
  // is nothing here that could set it.
  return {
    fieldType,
    trackedMarkerLabel: candidate.trackedMarkerLabel ?? undefined,
    value: candidate.value,
    unit: candidate.unit,
    referenceRange: candidate.referenceRange,
    asOfDate: normalizeAsOfDate(candidate.asOfDate),
    coverageStatus: candidate.coverageStatus,
    sourcePage: candidate.sourcePage,
    sourceLocation: candidate.sourceLocation,
    sourceSnippet: candidate.sourceSnippet,
    confidence: candidate.confidence,
  };
}

export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name = "anthropic";

  constructor(private readonly apiKey: string) {}

  async extractFacts(ocr: OcrResult, documentType: DocumentType): Promise<ExtractionResult> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const ocrText = pageAnnotatedText(ocr);
    const fieldTypes = FIELD_TYPES_BY_DOCUMENT_TYPE[documentType];

    const settled = await Promise.allSettled(
      fieldTypes.map((fieldType) => this.extractForFieldType(client, fieldType, documentType, ocrText)),
    );

    const candidates: ExtractedFactCandidate[] = [];
    const failedFieldTypes: FieldType[] = [];
    const failureMessages: Partial<Record<FieldType, string>> = {};
    settled.forEach((outcome, index) => {
      const fieldType = fieldTypes[index]!;
      if (outcome.status === "fulfilled") {
        candidates.push(...outcome.value);
      } else {
        failedFieldTypes.push(fieldType);
        failureMessages[fieldType] = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        console.error(`Extraction of field type '${fieldType}' failed for ${documentType} document:`, outcome.reason);
      }
    });

    // Failures are reported, never swallowed or thrown: the caller derives
    // done/partial/failed from candidates + failedFieldTypes.
    return { candidates, failedFieldTypes, failureMessages };
  }

  protected async extractForFieldType(
    client: Anthropic,
    fieldType: FieldType,
    documentType: DocumentType,
    ocrText: string,
  ): Promise<ExtractedFactCandidate[]> {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: promptFor(fieldType, documentType, ocrText) }],
      output_config: { format: zodOutputFormat(ExtractionResultSchema) },
    });

    if (!response.parsed_output) {
      return [];
    }
    return response.parsed_output.candidates.map((candidate) => toExtractedFactCandidate(fieldType, candidate));
  }
}
