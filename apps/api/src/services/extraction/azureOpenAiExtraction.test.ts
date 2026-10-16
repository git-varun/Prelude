import { test, expect } from "bun:test";
import type { OcrResult } from "@prelude/shared";
import { AzureOpenAiExtractionProvider, strictJsonSchema, type ChatCompleter } from "./azureOpenAiExtraction";

const ocr: OcrResult = { fullText: "CEA 5.9 ng/mL", pages: [{ pageNumber: 1, text: "CEA 5.9 ng/mL" }], providerName: "test", providerRaw: null };

const rawCandidate = {
  trackedMarkerLabel: "CEA", value: "5.9", unit: "ng/mL", referenceRange: null, asOfDate: "2026-01-01",
  coverageStatus: "value_found", sourcePage: 1, sourceLocation: null, sourceSnippet: "CEA 5.9 ng/mL", facility: null, confidence: 1.7,
};

type Params = { model: string; response_format?: { type: string; json_schema?: { strict?: boolean; schema?: unknown } } };
type Reply = { choices: Array<{ finish_reason: string; message: { content: string | null; refusal?: string | null } }> };

const ok = (content: unknown): Reply => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });

// Replaces only the network client; fan-out, parsing and mapping are the code under test.
class Stubbed extends AzureOpenAiExtractionProvider {
  calls: Params[] = [];
  constructor(private readonly reply: (n: number) => Reply | Error = () => ok({ candidates: [rawCandidate] })) {
    super("https://x.openai.azure.com", "key", "my-deployment");
  }
  protected override makeClient(): ChatCompleter {
    return {
      chat: {
        completions: {
          create: async (params: Params) => {
            this.calls.push(params);
            const r = this.reply(this.calls.length);
            if (r instanceof Error) throw r;
            return r;
          },
        },
      },
    } as unknown as ChatCompleter;
  }
}

test("the provider is named 'azure_openai'", () => {
  expect(new Stubbed().name).toBe("azure_openai");
});

test("calls the deployment with a strict json_schema, and clamps the model's confidence", async () => {
  const provider = new Stubbed();
  const result = await provider.extractFacts(ocr, "blood");
  expect(provider.calls.every((c) => c.model === "my-deployment" && c.response_format?.type === "json_schema" && c.response_format.json_schema?.strict === true)).toBe(true);
  expect(result.failedFieldTypes).toEqual([]);
  expect(result.candidates.every((c) => c.confidence === 1)).toBe(true);
});

test("a thrown call is reported in failedFieldTypes/failureMessages, never swallowed", async () => {
  const provider = new Stubbed((n) => (n === 1 ? new Error("429 rate limited") : ok({ candidates: [] })));
  const result = await provider.extractFacts(ocr, "blood");
  expect(result.failedFieldTypes).toEqual(["marker_value"]);
  expect(result.failureMessages?.marker_value).toContain("429 rate limited");
});

test("a refusal, a truncated reply and invalid JSON are failures, not an empty 'done'", async () => {
  const replies: Reply[] = [
    { choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] },
    { choices: [{ finish_reason: "length", message: { content: '{"candidates":[' } }] },
    { choices: [{ finish_reason: "stop", message: { content: "not json" } }] },
  ];
  for (const reply of replies) {
    const result = await new Stubbed(() => reply).extractFacts(ocr, "radiology");
    expect(result.candidates).toEqual([]);
    expect(result.failedFieldTypes.length).toBe(3);
  }
});

test("the strict schema has no keywords Azure strict mode rejects and keeps every property required", () => {
  const schema = strictJsonSchema() as Record<string, unknown>;
  const text = JSON.stringify(schema);
  for (const kw of ["minimum", "maximum", "minLength", "maxLength", "multipleOf", "$schema"]) expect(text).not.toContain(`"${kw}"`);
  const item = (schema.properties as any).candidates.items;
  expect(item.additionalProperties).toBe(false);
  expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
});
