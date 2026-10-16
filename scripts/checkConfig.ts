// Pure environment checks for `scripts/check-config.ts` (kept separate so they can be unit-tested without a database).
// Only variable NAMES and whether they are set are ever reported; values are never printed.

export type Mode = "local" | "prod";
export interface Finding {
  level: "ok" | "warn" | "fail";
  message: string;
}

type Env = Record<string, string | undefined>;

const set = (env: Env, key: string) => (env[key] ?? "").trim() !== "";

export function evaluateEnv(env: Env, mode: Mode): Finding[] {
  const out: Finding[] = [];
  const ok = (message: string) => out.push({ level: "ok", message });
  const warn = (message: string) => out.push({ level: "warn", message });
  const fail = (message: string) => out.push({ level: "fail", message });
  const need = (keys: string[], context: string) => {
    const missing = keys.filter((k) => !set(env, k));
    if (missing.length) fail(`${context}: ${missing.join(", ")} not set`);
    else ok(`${context}: ${keys.join(", ")} set`);
  };

  need(["DATABASE_URL"], "Database");

  // Storage
  const driver = env.OBJECT_STORAGE_DRIVER ?? "local";
  if (driver !== "local") fail(`OBJECT_STORAGE_DRIVER=${driver} is not supported (only 'local')`);
  else ok("Object storage: local driver");

  // OCR: the selected provider and its credentials. An unset provider makes every upload's OCR fail.
  const ocr = env.OCR_PROVIDER;
  if (!set(env, "OCR_PROVIDER")) {
    fail("OCR: OCR_PROVIDER is not set, so every upload's OCR step fails (expected 'azure_doc_intelligence' or 'google_document_ai')");
  } else if (ocr === "azure_doc_intelligence") {
    need(["AZURE_DOC_INTELLIGENCE_ENDPOINT", "AZURE_DOC_INTELLIGENCE_KEY"], "OCR (Azure Document Intelligence)");
  } else if (ocr === "google_document_ai") {
    need(
      ["GOOGLE_DOCUMENT_AI_PROJECT_ID", "GOOGLE_DOCUMENT_AI_LOCATION", "GOOGLE_DOCUMENT_AI_PROCESSOR_ID", "GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON"],
      "OCR (Google Document AI)",
    );
  } else {
    fail(`OCR: unrecognized OCR_PROVIDER=${ocr}`);
  }

  // Extraction
  const extraction = env.EXTRACTION_PROVIDER;
  if (!set(env, "EXTRACTION_PROVIDER")) {
    fail("Extraction: EXTRACTION_PROVIDER is not set, so fact extraction fails after OCR (expected 'anthropic' or 'gemini')");
  } else if (extraction === "anthropic") {
    need(["LLM_API_KEY"], "Extraction (Anthropic)");
  } else if (extraction === "gemini") {
    need(["GEMINI_API_KEY"], "Extraction (Gemini)");
    if (env.GEMINI_PILOT_TESTING_ONLY !== "true") fail("Extraction: EXTRACTION_PROVIDER=gemini also needs GEMINI_PILOT_TESTING_ONLY=true");
    if (mode === "prod") fail("Extraction: Gemini is for pilot testing on your own documents only, never real patient data; use 'anthropic' in prod");
  } else {
    fail(`Extraction: unrecognized EXTRACTION_PROVIDER=${extraction}`);
  }

  const emode = env.EXTRACTION_MODE;
  if (emode === undefined || emode === "" || emode === "llm") ok("Extraction mode: llm (default)");
  else if (emode === "deterministic") (mode === "prod" ? warn : ok)("Extraction mode: deterministic (rule-based; see docs/extraction-pipeline-status.md before enabling in prod)");
  else warn(`Extraction mode: EXTRACTION_MODE=${emode} is not recognised, so the LLM path is used`);

  // Web / CORS
  const webOrigin = env.WEB_ORIGIN;
  const publicApi = env.PUBLIC_API_URL;
  if (mode === "prod") {
    need(["DOMAIN", "POSTGRES_PASSWORD"], "Prod stack");
    if (env.NODE_ENV !== "production") warn("Prod: NODE_ENV is not 'production' in this environment (docker-compose.prod.yml sets it for the containers)");
    if (webOrigin && !webOrigin.startsWith("https://")) fail("Prod: WEB_ORIGIN must be an https:// origin (the cookie is credentialed)");
    if (publicApi && !publicApi.startsWith("https://")) fail("Prod: PUBLIC_API_URL must be https://");
    if (set(env, "POSTGRES_PASSWORD") && (env.POSTGRES_PASSWORD ?? "").length < 12) warn("Prod: POSTGRES_PASSWORD is shorter than 12 characters");
  } else {
    ok(`Local: web origin ${webOrigin ?? "http://localhost:3000"} (default), API URL ${publicApi ?? "http://localhost:3001"} (default)`);
  }

  // Optional features
  if (set(env, "DICTATION_PILOT_USER_ID") || set(env, "DICTATION_PILOT_EMAIL")) ok("Dictation pilot: enabled for one account");
  else ok("Dictation pilot: off (no account configured)");

  return out;
}
