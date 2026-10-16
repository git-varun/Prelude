import { test, expect } from "bun:test";
import type { OcrResult } from "@prelude/shared";
import { BedrockExtractionProvider } from "./bedrockExtraction";
import type { MessageParser } from "./anthropicExtraction";

const ocr: OcrResult = { fullText: "CEA 5.9 ng/mL", pages: [{ pageNumber: 1, text: "CEA 5.9 ng/mL" }], providerName: "test", providerRaw: null };

const rawCandidate = {
  trackedMarkerLabel: "CEA", value: "5.9", unit: "ng/mL", referenceRange: null, asOfDate: "2026-01-01",
  coverageStatus: "value_found", sourcePage: 1, sourceLocation: null, sourceSnippet: "CEA 5.9 ng/mL", facility: null, confidence: 1.7,
};

type Call = { model: string; output_config?: unknown };

// Replaces only the network client; the provider's own fan-out, parsing and mapping are the code under test.
class StubbedBedrock extends BedrockExtractionProvider {
  calls: Call[] = [];
  constructor(private readonly failOn: (call: number) => boolean = () => false) {
    super("ap-south-1", "in.anthropic.claude-sonnet-5");
  }
  protected override makeClient(): MessageParser {
    return {
      messages: {
        parse: async (params: Call) => {
          this.calls.push(params);
          if (this.failOn(this.calls.length)) throw new Error("ThrottlingException");
          return { parsed_output: { candidates: [rawCandidate] } };
        },
      },
    } as unknown as MessageParser;
  }
}

test("the provider is named 'bedrock'", () => {
  expect(new BedrockExtractionProvider("ap-south-1", "in.anthropic.claude-sonnet-5").name).toBe("bedrock");
});

test("calls the configured in. model with structured output, and clamps the model's confidence", async () => {
  const provider = new StubbedBedrock();
  const result = await provider.extractFacts(ocr, "blood");
  expect(provider.calls.every((c) => c.model === "in.anthropic.claude-sonnet-5" && c.output_config !== undefined)).toBe(true);
  expect(result.failedFieldTypes).toEqual([]);
  expect(result.candidates.every((c) => c.confidence === 1)).toBe(true);
});

test("a failed call is reported in failedFieldTypes/failureMessages, never swallowed into an empty success", async () => {
  const provider = new StubbedBedrock((n) => n === 1);
  const result = await provider.extractFacts(ocr, "blood");
  expect(result.failedFieldTypes).toEqual(["marker_value"]);
  expect(result.failureMessages?.marker_value).toContain("ThrottlingException");
  expect(result.candidates.map((c) => c.fieldType)).toEqual(["reference_range"]);
});

test("the real client is an AnthropicBedrock pinned to the configured region, with no API key", () => {
  const client = (new BedrockExtractionProvider("ap-south-2", "in.anthropic.claude-sonnet-5") as unknown as {
    makeClient(): { awsRegion: string; apiKey: unknown; awsAccessKey: unknown; awsSecretKey: unknown };
  }).makeClient();
  expect(client.awsRegion).toBe("ap-south-2");
  // Credentials must come from the default AWS chain, never from static keys held by this app.
  expect(client.awsAccessKey).toBeNull();
  expect(client.awsSecretKey).toBeNull();
  expect(client.apiKey ?? null).toBeNull();
});
