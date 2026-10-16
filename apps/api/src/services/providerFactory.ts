import type { ExtractionProvider, OcrProvider } from "@prelude/shared";
import { AzureDocIntelligenceProvider } from "./ocr/azureDocIntelligence";
import { GoogleDocumentAiProvider } from "./ocr/googleDocumentAi";
import { AnthropicExtractionProvider } from "./extraction/anthropicExtraction";
import { AzureOpenAiExtractionProvider } from "./extraction/azureOpenAiExtraction";
import { BedrockExtractionProvider } from "./extraction/bedrockExtraction";
import { GeminiExtractionProvider } from "./extraction/geminiExtraction";
import { DeterministicExtractionProvider } from "./extraction/deterministic/provider";

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

  if (providerName === "bedrock") {
    // Patient text must never leave India: pin the region and the model's inference profile at startup. A `global.`
    // or `us.` profile (or a bare model id) would route to commercial regions elsewhere. No API key: the AWS
    // default credential chain supplies credentials (instance role in production).
    const region = process.env.AWS_REGION;
    const model = process.env.EXTRACTION_MODEL;
    if (region !== "ap-south-1" && region !== "ap-south-2") {
      throw new Error(`AWS_REGION must be ap-south-1 or ap-south-2 for EXTRACTION_PROVIDER=bedrock (got ${region ? `'${region}'` : "nothing"}).`);
    }
    if (!model || !model.startsWith("in.anthropic.")) {
      throw new Error(
        `EXTRACTION_MODEL must start with 'in.anthropic.' (the India inference profile, e.g. in.anthropic.claude-sonnet-5) for EXTRACTION_PROVIDER=bedrock (got ${model ? `'${model}'` : "nothing"}).`,
      );
    }
    return new BedrockExtractionProvider(region, model);
  }

  if (providerName === "azure_openai") {
    // The region can't be read from an Azure endpoint hostname, so it is declared by the operator and checked here;
    // create the resource in Central India or South India with a Standard (regional) deployment.
    const region = process.env.AZURE_OPENAI_REGION;
    if (region !== "centralindia" && region !== "southindia") {
      throw new Error(`AZURE_OPENAI_REGION must be centralindia or southindia for EXTRACTION_PROVIDER=azure_openai (got ${region ? `'${region}'` : "nothing"}).`);
    }
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const host = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : undefined;
    if (!host || host.protocol !== "https:" || !/\.(openai|cognitiveservices)\.azure\.com$/.test(host.hostname)) {
      throw new Error("AZURE_OPENAI_ENDPOINT must be an https://<resource>.openai.azure.com URL for EXTRACTION_PROVIDER=azure_openai.");
    }
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!apiKey) throw new Error("AZURE_OPENAI_API_KEY is required for EXTRACTION_PROVIDER=azure_openai.");
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    if (!deployment) throw new Error("AZURE_OPENAI_DEPLOYMENT is required for EXTRACTION_PROVIDER=azure_openai.");
    return new AzureOpenAiExtractionProvider(host.origin, apiKey, deployment);
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
    throw new Error("EXTRACTION_PROVIDER is not set. Expected 'bedrock', 'azure_openai', 'anthropic' or 'gemini'.");
  }
  throw new Error(`Unrecognized EXTRACTION_PROVIDER: ${providerName}. Expected 'bedrock', 'azure_openai', 'anthropic' or 'gemini'.`);
}

let cachedDeterministicProvider: ExtractionProvider | undefined;

// The configured LLM provider regardless of EXTRACTION_MODE; the deterministic path falls back to it.
export function getLlmExtractionProvider(): ExtractionProvider {
  if (!cachedExtractionProvider) {
    cachedExtractionProvider = buildExtractionProvider();
  }
  return cachedExtractionProvider;
}

// EXTRACTION_MODE=deterministic enables the rule-based parser; anything else (unset, a typo) keeps today's LLM path.
export function getExtractionProvider(): ExtractionProvider {
  if (process.env.EXTRACTION_MODE === "deterministic") {
    if (!cachedDeterministicProvider) {
      cachedDeterministicProvider = new DeterministicExtractionProvider();
    }
    return cachedDeterministicProvider;
  }
  return getLlmExtractionProvider();
}
