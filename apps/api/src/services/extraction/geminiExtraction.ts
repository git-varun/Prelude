import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import type { DocumentType, ExtractedFactCandidate, ExtractionProvider, ExtractionResult, FieldType, OcrResult } from "@prelude/shared";
import {
  ExtractionResultSchema,
  FIELD_TYPES_BY_DOCUMENT_TYPE,
  pageAnnotatedText,
  promptFor,
  toExtractedFactCandidate,
} from "./anthropicExtraction";

// Pilot-testing adapter only: live server use is scoped to Varun's own
// documents while validating the pipeline end to end (Decisions Log,
// "Staging/production hosting"), before switching EXTRACTION_PROVIDER back
// to anthropic for real patient use.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-pro-preview";

const RESPONSE_SCHEMA = z.toJSONSchema(ExtractionResultSchema);

export class GeminiExtractionProvider implements ExtractionProvider {
  readonly name = "gemini";

  constructor(private readonly apiKey: string) {}

  async extractFacts(ocr: OcrResult, documentType: DocumentType): Promise<ExtractionResult> {
    const client = new GoogleGenAI({ apiKey: this.apiKey });
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

    return { candidates, failedFieldTypes, failureMessages };
  }

  protected async extractForFieldType(
    client: GoogleGenAI,
    fieldType: FieldType,
    documentType: DocumentType,
    ocrText: string,
  ): Promise<ExtractedFactCandidate[]> {
    const response = await client.models.generateContent({
      model: MODEL,
      contents: promptFor(fieldType, documentType, ocrText),
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    if (!response.text) {
      return [];
    }
    const parsed = ExtractionResultSchema.parse(JSON.parse(response.text));
    return parsed.candidates.map((candidate) => toExtractedFactCandidate(fieldType, candidate));
  }
}
