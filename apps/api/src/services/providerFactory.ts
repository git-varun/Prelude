import type { ExtractionProvider, OcrProvider } from "@opd/shared";
import { AzureDocIntelligenceProvider } from "./ocr/azureDocIntelligence";
import { AwsTextractProvider } from "./ocr/awsTextract";
import { AnthropicExtractionProvider } from "./extraction/anthropicExtraction";

let cachedProvider: OcrProvider | undefined;

function buildOcrProvider(): OcrProvider {
  const providerName = process.env.OCR_PROVIDER;

  if (providerName === "azure_doc_intelligence") {
    const endpoint = process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT;
    const key = process.env.AZURE_DOC_INTELLIGENCE_KEY;
    if (!endpoint || !key) {
      throw new Error(
        "AZURE_DOC_INTELLIGENCE_ENDPOINT and AZURE_DOC_INTELLIGENCE_KEY are required for OCR_PROVIDER=azure_doc_intelligence.",
      );
    }
    return new AzureDocIntelligenceProvider(endpoint, key);
  }

  if (providerName === "aws_textract") {
    const region = process.env.AWS_TEXTRACT_REGION;
    const accessKeyId = process.env.AWS_TEXTRACT_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_TEXTRACT_SECRET_ACCESS_KEY;
    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "AWS_TEXTRACT_REGION, AWS_TEXTRACT_ACCESS_KEY_ID, and AWS_TEXTRACT_SECRET_ACCESS_KEY are required for OCR_PROVIDER=aws_textract.",
      );
    }
    return new AwsTextractProvider(region, accessKeyId, secretAccessKey);
  }

  if (providerName === undefined) {
    throw new Error("OCR_PROVIDER is not set. Expected 'azure_doc_intelligence' or 'aws_textract'.");
  }
  throw new Error(`Unrecognized OCR_PROVIDER: ${providerName}. Expected 'azure_doc_intelligence' or 'aws_textract'.`);
}

/** Memoized: constructing a new vendor client per call would drop connection reuse for no benefit. */
export function getOcrProvider(): OcrProvider {
  if (!cachedProvider) {
    cachedProvider = buildOcrProvider();
  }
  return cachedProvider;
}

let cachedExtractionProvider: ExtractionProvider | undefined;

function buildExtractionProvider(): ExtractionProvider {
  const providerName = process.env.EXTRACTION_PROVIDER;

  if (providerName === "anthropic") {
    const apiKey = process.env.LLM_API_KEY;
    if (!apiKey) {
      throw new Error("LLM_API_KEY is required for EXTRACTION_PROVIDER=anthropic.");
    }
    return new AnthropicExtractionProvider(apiKey);
  }

  if (providerName === undefined) {
    throw new Error("EXTRACTION_PROVIDER is not set. Expected 'anthropic'.");
  }
  throw new Error(`Unrecognized EXTRACTION_PROVIDER: ${providerName}. Expected 'anthropic'.`);
}

export function getExtractionProvider(): ExtractionProvider {
  if (!cachedExtractionProvider) {
    cachedExtractionProvider = buildExtractionProvider();
  }
  return cachedExtractionProvider;
}
