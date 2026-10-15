import { expect, test } from "bun:test";
import { evaluateEnv } from "./checkConfig";

const good = {
  DATABASE_URL: "postgres://x", OCR_PROVIDER: "azure_doc_intelligence", AZURE_DOC_INTELLIGENCE_ENDPOINT: "https://e", AZURE_DOC_INTELLIGENCE_KEY: "k",
  EXTRACTION_PROVIDER: "anthropic", LLM_API_KEY: "k",
};
const fails = (env: Record<string, string | undefined>, mode: "local" | "prod" = "local") =>
  evaluateEnv(env, mode).filter((f) => f.level === "fail").map((f) => f.message);

test("a complete local environment has no failures", () => {
  expect(fails(good)).toEqual([]);
});

test("an unset OCR_PROVIDER or EXTRACTION_PROVIDER is a failure that names the consequence", () => {
  const f = fails({ DATABASE_URL: "x" });
  expect(f.some((m) => m.includes("OCR_PROVIDER is not set") && m.includes("OCR step fails"))).toBe(true);
  expect(f.some((m) => m.includes("EXTRACTION_PROVIDER is not set"))).toBe(true);
});

test("the selected provider's credentials are required, and an empty value counts as missing", () => {
  expect(fails({ ...good, LLM_API_KEY: "" }).join()).toContain("LLM_API_KEY not set");
  expect(fails({ ...good, AZURE_DOC_INTELLIGENCE_KEY: undefined }).join()).toContain("AZURE_DOC_INTELLIGENCE_KEY not set");
  expect(fails({ ...good, OCR_PROVIDER: "nope" }).join()).toContain("unrecognized OCR_PROVIDER");
});

test("gemini needs its pilot flag and is refused in prod", () => {
  const gem = { ...good, EXTRACTION_PROVIDER: "gemini", GEMINI_API_KEY: "k", LLM_API_KEY: undefined };
  expect(fails(gem).join()).toContain("GEMINI_PILOT_TESTING_ONLY=true");
  expect(fails({ ...gem, GEMINI_PILOT_TESTING_ONLY: "true" })).toEqual([]);
  expect(fails({ ...gem, GEMINI_PILOT_TESTING_ONLY: "true", DOMAIN: "d.example", POSTGRES_PASSWORD: "p".repeat(16) }, "prod").join()).toContain("never real patient data");
});

test("prod needs DOMAIN and POSTGRES_PASSWORD and https origins", () => {
  expect(fails(good, "prod").join()).toContain("DOMAIN, POSTGRES_PASSWORD not set");
  const prod = { ...good, DOMAIN: "d.example", POSTGRES_PASSWORD: "p".repeat(16), NODE_ENV: "production" };
  expect(fails(prod, "prod")).toEqual([]);
  expect(fails({ ...prod, WEB_ORIGIN: "http://d.example" }, "prod").join()).toContain("WEB_ORIGIN must be an https");
});
