import { AzureOpenAI } from "openai";
import { z } from "zod";
import type { DocumentType, ExtractedFactCandidate, ExtractionProvider, ExtractionResult, FieldType, OcrResult } from "@prelude/shared";
import {
  ExtractionResultSchema,
  FIELD_TYPES_BY_DOCUMENT_TYPE,
  pageAnnotatedText,
  promptFor,
  toExtractedFactCandidate,
} from "./anthropicExtraction";

// The narrowest surface extraction needs from the client.
export type ChatCompleter = { chat: { completions: { create: AzureOpenAI["chat"]["completions"]["create"] } } };

const UNSUPPORTED_KEYWORDS = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "format"]);

function stripKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripKeywords);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).filter(([k]) => !UNSUPPORTED_KEYWORDS.has(k)).map(([k, v]) => [k, stripKeywords(v)]));
  }
  return node;
}

// Strict structured outputs want every property required and additionalProperties:false (the zod schema already is);
// numeric bounds are dropped here and enforced after the call (confidence is clamped in toExtractedFactCandidate).
export function strictJsonSchema(): unknown {
  return stripKeywords(z.toJSONSchema(ExtractionResultSchema));
}

// Claude-free extraction through Azure OpenAI. Residency is the operator's job: create the resource in Central India
// or South India and use a Standard (regional) deployment; providerFactory refuses to start without
// AZURE_OPENAI_REGION set to one of those. Same prompts, failure reporting and post-processing as the other providers.
export class AzureOpenAiExtractionProvider implements ExtractionProvider {
  readonly name = "azure_openai";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly deployment: string,
  ) {}

  protected makeClient(): ChatCompleter {
    return new AzureOpenAI({ endpoint: this.endpoint, apiKey: this.apiKey, apiVersion: "2025-04-01-preview", deployment: this.deployment });
  }

  async extractFacts(ocr: OcrResult, documentType: DocumentType): Promise<ExtractionResult> {
    const client = this.makeClient();
    const ocrText = pageAnnotatedText(ocr);
    const fieldTypes = FIELD_TYPES_BY_DOCUMENT_TYPE[documentType];

    const settled = await Promise.allSettled(
      fieldTypes.map((fieldType) => this.extractForFieldType(client, fieldType, documentType, ocrText, ocr)),
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

    // Failures are reported, never swallowed or thrown: the caller derives done/partial/failed.
    return { candidates, failedFieldTypes, failureMessages };
  }

  protected async extractForFieldType(
    client: ChatCompleter,
    fieldType: FieldType,
    documentType: DocumentType,
    ocrText: string,
    ocr: OcrResult,
  ): Promise<ExtractedFactCandidate[]> {
    const response = await client.chat.completions.create({
      model: this.deployment,
      messages: [{ role: "user", content: promptFor(fieldType, documentType, ocrText) }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction_result", strict: true, schema: strictJsonSchema() as Record<string, unknown> },
      },
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("Azure OpenAI returned no choices");
    if (choice.message.refusal) throw new Error(`Azure OpenAI refused: ${choice.message.refusal}`);
    if (choice.finish_reason === "length") throw new Error("Azure OpenAI reply was truncated (finish_reason=length)");
    if (!choice.message.content) throw new Error(`Azure OpenAI returned no content (finish_reason=${choice.finish_reason})`);

    const parsed = ExtractionResultSchema.parse(JSON.parse(choice.message.content));
    return parsed.candidates.map((candidate) => toExtractedFactCandidate(fieldType, candidate, ocr));
  }
}
