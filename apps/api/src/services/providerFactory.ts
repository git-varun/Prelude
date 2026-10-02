import type { ExtractionProvider, OcrProvider } from "@opd/shared";
import { AzureDocIntelligenceProvider } from "./ocr/azureDocIntelligence";
import { GoogleDocumentAiProvider } from "./ocr/googleDocumentAi";
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

  if (providerName === "google_document_ai") {
    const projectId = process.env.GOOGLE_DOCUMENT_AI_PROJECT_ID;
    const location = process.env.GOOGLE_DOCUMENT_AI_LOCATION;
    const processorId = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
    const credentialsJson = process.env.GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON;
    if (!projectId || !location || !processorId || !credentialsJson) {
      throw new Error(
        "GOOGLE_DOCUMENT_AI_PROJECT_ID, GOOGLE_DOCUMENT_AI_LOCATION, GOOGLE_DOCUMENT_AI_PROCESSOR_ID, and GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON are required for OCR_PROVIDER=google_document_ai.",
      );
    }
    const credentials = JSON.parse(credentialsJson) as { client_email: string; private_key: string };
    return new GoogleDocumentAiProvider(projectId, location, processorId, credentials);
  }

  if (providerName === undefined) {
    throw new Error("OCR_PROVIDER is not set. Expected 'azure_doc_intelligence' or 'google_document_ai'.");
  }
  throw new Error(`Unrecognized OCR_PROVIDER: ${providerName}. Expected 'azure_doc_intelligence' or 'google_document_ai'.`);
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
