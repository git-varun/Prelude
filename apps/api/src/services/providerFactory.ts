import type { ExtractionProvider, OcrProvider } from "@prelude/shared";
import { AzureDocIntelligenceProvider } from "./ocr/azureDocIntelligence";
import { GoogleDocumentAiProvider } from "./ocr/googleDocumentAi";
import { AnthropicExtractionProvider } from "./extraction/anthropicExtraction";
import { GeminiExtractionProvider } from "./extraction/geminiExtraction";

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

  if (providerName === "gemini") {
    // Decisions Log, "Staging/production hosting": Gemini on the live
    // server is scoped to pilot-testing the pipeline against Varun's own
    // documents only, never real patient uploads — GEMINI_PILOT_TESTING_ONLY
    // is a second, explicit flag so this can't be reached by EXTRACTION_PROVIDER
    // alone (e.g. a copied .env), and must be switched back to anthropic
    // before real patient use.
    const apiKey = process.env.GEMINI_API_KEY;
    const pilotFlag = process.env.GEMINI_PILOT_TESTING_ONLY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is required for EXTRACTION_PROVIDER=gemini.");
    }
    if (pilotFlag !== "true") {
      throw new Error(
        "EXTRACTION_PROVIDER=gemini also requires GEMINI_PILOT_TESTING_ONLY=true — this path is for pipeline testing against your own documents only, never real patient data.",
      );
    }
    return new GeminiExtractionProvider(apiKey);
  }

  if (providerName === undefined) {
    throw new Error("EXTRACTION_PROVIDER is not set. Expected 'anthropic' or 'gemini'.");
  }
  throw new Error(`Unrecognized EXTRACTION_PROVIDER: ${providerName}. Expected 'anthropic' or 'gemini'.`);
}

export function getExtractionProvider(): ExtractionProvider {
  if (!cachedExtractionProvider) {
    cachedExtractionProvider = buildExtractionProvider();
  }
  return cachedExtractionProvider;
}
