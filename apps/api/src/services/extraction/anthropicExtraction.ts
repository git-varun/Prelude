import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CONTROLLED_MARKERS } from "@opd/shared";
import type { DocumentType, ExtractedFactCandidate, ExtractionProvider, FieldType, OcrResult } from "@opd/shared";

const MODEL = "claude-opus-5";

const CandidateSchema = z.object({
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

const ExtractionResultSchema = z.object({
  candidates: z.array(CandidateSchema),
});

type RawCandidate = z.infer<typeof CandidateSchema>;

// docs/02 M2: which field types a document of this type could plausibly
// state, so extraction runs one prompted call per relevant field_type
// rather than all five against every upload.
const FIELD_TYPES_BY_DOCUMENT_TYPE: Record<DocumentType, FieldType[]> = {
  blood: ["marker_value", "reference_range"],
  prescription: ["treatment_regimen"],
  radiology: ["radiology_impression", "disease_status_trend"],
};

function pageAnnotatedText(ocr: OcrResult): string {
  if (ocr.pages.length === 0) return ocr.fullText;
  return ocr.pages.map((page) => `--- Page ${page.pageNumber} ---\n${page.text}`).join("\n\n");
}

function promptFor(fieldType: FieldType, documentType: DocumentType, ocrText: string): string {
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
For each marker found, set trackedMarkerLabel to the marker's name. The patient's controlled marker
list is: ${CONTROLLED_MARKERS.join(", ")}. If the extracted marker name clearly matches one of these
(allowing for case, punctuation, and spacing differences — e.g. "CA 125" matches "CA-125"), set
trackedMarkerLabel to that exact controlled name. If it doesn't confidently match any of them, set
trackedMarkerLabel to the raw name exactly as it appears in the document instead — do not force a
match, and do not invent a controlled name; resolving that raw name is the caller's job, not yours.
value/unit/referenceRange are that marker's own reported value, unit, and reference range, if stated
alongside it.`;

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

function toExtractedFactCandidate(fieldType: FieldType, candidate: RawCandidate): ExtractedFactCandidate {
  // No verification_state field exists on ExtractedFactCandidate at all —
  // the extraction pass cannot self-authorize trust (docs/02 M2), so there
  // is nothing here that could set it.
  return {
    fieldType,
    trackedMarkerLabel: candidate.trackedMarkerLabel ?? undefined,
    value: candidate.value,
    unit: candidate.unit,
    referenceRange: candidate.referenceRange,
    asOfDate: candidate.asOfDate,
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

  async extractFacts(ocr: OcrResult, documentType: DocumentType): Promise<ExtractedFactCandidate[]> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const ocrText = pageAnnotatedText(ocr);
    const fieldTypes = FIELD_TYPES_BY_DOCUMENT_TYPE[documentType];

    const settled = await Promise.allSettled(
      fieldTypes.map((fieldType) => this.extractForFieldType(client, fieldType, documentType, ocrText)),
    );

    const candidates: ExtractedFactCandidate[] = [];
    const failures: unknown[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        candidates.push(...outcome.value);
      } else {
        failures.push(outcome.reason);
        console.error(`Extraction of field type '${fieldTypes[index]}' failed for ${documentType} document:`, outcome.reason);
      }
    });

    // If every call failed, returning [] would look identical to "nothing
    // extractable" — throw so the caller records extraction_status='failed'.
    if (failures.length === fieldTypes.length) {
      throw new AggregateError(failures, `All ${fieldTypes.length} field-type extraction call(s) failed.`);
    }

    return candidates;
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
