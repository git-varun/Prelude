import { test, expect, afterEach } from "bun:test";

afterEach(() => {
  delete process.env.EXTRACTION_MODE;
  delete process.env.EXTRACTION_PROVIDER;
  delete process.env.LLM_API_KEY;
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
