import { test, expect, afterEach } from "bun:test";

afterEach(() => {
  delete process.env.EXTRACTION_MODE;
  delete process.env.EXTRACTION_PROVIDER;
  delete process.env.LLM_API_KEY;
  delete process.env.AWS_REGION;
  delete process.env.EXTRACTION_MODEL;
});

async function bedrockProvider(region: string | undefined, model: string | undefined) {
  process.env.EXTRACTION_PROVIDER = "bedrock";
  if (region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = region;
  if (model === undefined) delete process.env.EXTRACTION_MODEL; else process.env.EXTRACTION_MODEL = model;
  const { getLlmExtractionProvider } = await import(`./providerFactory?bedrock-${Math.random()}`);
  return getLlmExtractionProvider();
}

test("EXTRACTION_PROVIDER=bedrock builds the bedrock provider for an India region and an in.anthropic. model, with no LLM_API_KEY", async () => {
  expect((await bedrockProvider("ap-south-1", "in.anthropic.claude-sonnet-5")).name).toBe("bedrock");
  expect((await bedrockProvider("ap-south-2", "in.anthropic.claude-sonnet-5")).name).toBe("bedrock");
});

test("bedrock refuses to start outside the India regions", async () => {
  for (const region of ["us-east-1", "ap-southeast-2", "eu-west-1", ""]) {
    await expect(bedrockProvider(region, "in.anthropic.claude-sonnet-5")).rejects.toThrow(/AWS_REGION must be ap-south-1 or ap-south-2/);
  }
  await expect(bedrockProvider(undefined, "in.anthropic.claude-sonnet-5")).rejects.toThrow(/AWS_REGION must be ap-south-1 or ap-south-2/);
});

test("bedrock refuses any model that is not on the in. India inference profile", async () => {
  for (const model of ["global.anthropic.claude-sonnet-5", "us.anthropic.claude-sonnet-5", "anthropic.claude-sonnet-5", "claude-sonnet-5-5", "in.openai.gpt-5.6-terra", "xin.anthropic.claude-sonnet-5"]) {
    await expect(bedrockProvider("ap-south-1", model)).rejects.toThrow(/EXTRACTION_MODEL must start with 'in\.anthropic\.'/);
  }
  await expect(bedrockProvider("ap-south-1", undefined)).rejects.toThrow(/EXTRACTION_MODEL must start with 'in\.anthropic\.'/);
});

const AZURE_VARS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_REGION"] as const;

async function azureProvider(overrides: Partial<Record<(typeof AZURE_VARS)[number], string | undefined>> = {}) {
  const base = {
    AZURE_OPENAI_ENDPOINT: "https://prelude-in.openai.azure.com",
    AZURE_OPENAI_API_KEY: "k",
    AZURE_OPENAI_DEPLOYMENT: "gpt-extract",
    AZURE_OPENAI_REGION: "centralindia",
  };
  process.env.EXTRACTION_PROVIDER = "azure_openai";
  for (const v of AZURE_VARS) {
    const value = v in overrides ? overrides[v] : base[v];
    if (value === undefined) delete process.env[v]; else process.env[v] = value;
  }
  const { getLlmExtractionProvider } = await import(`./providerFactory?azure-${Math.random()}`);
  try {
    return getLlmExtractionProvider();
  } finally {
    for (const v of AZURE_VARS) delete process.env[v];
  }
}

test("EXTRACTION_PROVIDER=azure_openai builds the provider for centralindia and southindia", async () => {
  expect((await azureProvider()).name).toBe("azure_openai");
  expect((await azureProvider({ AZURE_OPENAI_REGION: "southindia" })).name).toBe("azure_openai");
});

test("azure_openai refuses to start outside the India regions", async () => {
  for (const region of ["eastus", "westeurope", "australiaeast", "", undefined]) {
    await expect(azureProvider({ AZURE_OPENAI_REGION: region })).rejects.toThrow(/AZURE_OPENAI_REGION must be centralindia or southindia/);
  }
});

test("azure_openai requires an https azure endpoint, a key and a deployment", async () => {
  await expect(azureProvider({ AZURE_OPENAI_ENDPOINT: undefined })).rejects.toThrow(/AZURE_OPENAI_ENDPOINT/);
  await expect(azureProvider({ AZURE_OPENAI_ENDPOINT: "http://x.openai.azure.com" })).rejects.toThrow(/AZURE_OPENAI_ENDPOINT/);
  await expect(azureProvider({ AZURE_OPENAI_ENDPOINT: "https://api.openai.com" })).rejects.toThrow(/AZURE_OPENAI_ENDPOINT/);
  await expect(azureProvider({ AZURE_OPENAI_API_KEY: undefined })).rejects.toThrow(/AZURE_OPENAI_API_KEY/);
  await expect(azureProvider({ AZURE_OPENAI_DEPLOYMENT: undefined })).rejects.toThrow(/AZURE_OPENAI_DEPLOYMENT/);
});

test("the unset/unrecognised provider errors list bedrock as a valid choice", async () => {
  delete process.env.EXTRACTION_PROVIDER;
  const { getLlmExtractionProvider } = await import(`./providerFactory?msg-${Math.random()}`);
  expect(() => getLlmExtractionProvider()).toThrow(/'bedrock'/);
});

test("getExtractionProvider returns the deterministic provider when EXTRACTION_MODE=deterministic, without needing EXTRACTION_PROVIDER", async () => {
  process.env.EXTRACTION_MODE = "deterministic";
  delete process.env.EXTRACTION_PROVIDER;
  const { getExtractionProvider } = await import(`./providerFactory?det-${Date.now()}`);
  expect(getExtractionProvider().name).toBe("deterministic");
});

test("getExtractionProvider falls back to the LLM provider when EXTRACTION_MODE is unset (default, unchanged behaviour)", async () => {
  delete process.env.EXTRACTION_MODE;
  delete process.env.EXTRACTION_PROVIDER;
  const { getExtractionProvider } = await import(`./providerFactory?llm-${Date.now()}`);
  expect(() => getExtractionProvider()).toThrow(/EXTRACTION_PROVIDER is not set/);
});

test("getLlmExtractionProvider ignores EXTRACTION_MODE and returns the configured LLM provider (the deterministic path's fallback)", async () => {
  process.env.EXTRACTION_MODE = "deterministic";
  process.env.EXTRACTION_PROVIDER = "anthropic";
  process.env.LLM_API_KEY = "test-key";
  const { getLlmExtractionProvider } = await import(`./providerFactory?fallback-${Date.now()}`);
  expect(getLlmExtractionProvider().name).toBe("anthropic");
});

test("an unrecognised EXTRACTION_MODE is treated as the default LLM mode, not as deterministic", async () => {
  process.env.EXTRACTION_MODE = "determinstic"; // typo must not silently enable the new path
  delete process.env.EXTRACTION_PROVIDER;
  const { getExtractionProvider } = await import(`./providerFactory?typo-${Date.now()}`);
  expect(() => getExtractionProvider()).toThrow(/EXTRACTION_PROVIDER is not set/);
});
