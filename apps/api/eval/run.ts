import { readdir } from "node:fs/promises";
import type { OcrResult } from "@prelude/shared";
import { getExtractionProvider, getLlmExtractionProvider } from "../src/services/providerFactory";
import { ExpectedDocSchema } from "./types";
import { DeterministicExtractionProvider } from "../src/services/extraction/deterministic/provider";
import { parseDocument } from "../src/services/extraction/deterministic/pipeline";
import { evaluateGates, formatSummary, scoreDoc, scoreHeader, summarize, type DocScore } from "./score";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const RESULTS = new URL("./results/", import.meta.url);

const repeatArg = process.argv.indexOf("--repeat");
const repeat = repeatArg >= 0 ? Number(process.argv[repeatArg + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat expects a positive integer");

const names = (await readdir(FIXTURES).catch(() => [] as string[]))
  .filter((f) => f.endsWith(".expected.json"))
  .map((f) => f.replace(".expected.json", ""))
  .sort();
if (names.length === 0) {
  throw new Error(`No fixtures in ${FIXTURES.pathname}. Run \`bun run eval:fixtures\` and write the .expected.json answer keys first.`);
}

// Providers on free tiers rate-limit (Gemini: 15 req/min). EVAL_DELAY_MS paces documents; a document
// whose call failed is retried (EVAL_RETRIES, default 2) after EVAL_RETRY_WAIT_MS (default 30s).
const delayMs = Number(process.env.EVAL_DELAY_MS ?? 0);
const retries = Number(process.env.EVAL_RETRIES ?? 2);
const retryWaitMs = Number(process.env.EVAL_RETRY_WAIT_MS ?? 30_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const deterministic = process.env.EVAL_PROVIDER === "deterministic";
// EVAL_PROVIDER=bedrock|azure_openai|anthropic|gemini picks that LLM provider for this run (the factory's own guards still apply,
// e.g. bedrock requires an India AWS_REGION and an in.anthropic. EXTRACTION_MODEL); unset falls back to EXTRACTION_PROVIDER.
const llmOverride = process.env.EVAL_PROVIDER;
if (llmOverride && llmOverride !== "deterministic") {
  if (!["bedrock", "azure_openai", "anthropic", "gemini"].includes(llmOverride)) {
    throw new Error(`Unrecognized EVAL_PROVIDER: ${llmOverride}. Expected 'bedrock', 'azure_openai', 'anthropic', 'gemini' or 'deterministic'.`);
  }
  process.env.EXTRACTION_PROVIDER = llmOverride;
}
const provider = deterministic ? new DeterministicExtractionProvider() : llmOverride ? getLlmExtractionProvider() : getExtractionProvider();
let headerChecked = 0;
let headerCorrect = 0;
const docs: DocScore[] = [];

for (let run = 1; run <= repeat; run++) {
  for (const name of names) {
    const ocr = (await Bun.file(new URL(`${name}.ocr.json`, FIXTURES)).json()) as OcrResult;
    const expected = ExpectedDocSchema.parse(await Bun.file(new URL(`${name}.expected.json`, FIXTURES)).json());
    if (deterministic && expected.documentType !== "blood") {
      console.log(`${name}: skipped (phase 1: blood only)`);
      continue;
    }
    let result = await provider.extractFacts(ocr, expected.documentType);
    for (let attempt = 1; attempt <= retries && result.failedFieldTypes.length > 0; attempt++) {
      console.warn(`${name}: ${result.failedFieldTypes.join(",")} failed; retry ${attempt}/${retries} in ${retryWaitMs / 1000}s`);
      await sleep(retryWaitMs);
      result = await provider.extractFacts(ocr, expected.documentType);
    }
    const { candidates, failedFieldTypes } = result;
    if (delayMs > 0) await sleep(delayMs);
    const source = expected.keyOrigin === "scripted" ? "real_scripted" : expected.keyOrigin === "spot_check" ? "real_spot_check" : expected.source;
    const score = scoreDoc(repeat > 1 ? `${name}#${run}` : name, expected.facts, candidates, failedFieldTypes, source);
    docs.push(score);
    let extra = "";
    if (deterministic) {
      extra = ` | unplaced ${result.stats?.unplacedNumericLines ?? 0}`;
      if (expected.header) {
        const h = scoreHeader(expected.header, parseDocument(ocr).header);
        headerChecked += h.checked;
        headerCorrect += h.correct;
        extra += ` | header ${h.correct}/${h.checked}${h.wrong.length ? ` wrong: ${h.wrong.join(",")}` : ""}`;
      }
    }
    console.log(
      `${score.name}: expected ${score.expected.length}, extracted ${score.extracted.length}, ` +
        `matched ${score.results.length}, wrong ${score.results.filter((r) => !r.correct).length}, ` +
        `missed ${score.missed.length}, spurious ${score.spurious.length}` +
        (failedFieldTypes.length ? ` | FAILED field types: ${failedFieldTypes.join(",")}` : "") +
        extra,
    );
  }
}

const summary = summarize(docs);
console.log("\n" + formatSummary(summary));
if (deterministic && headerChecked > 0) console.log(`header fields correct: ${headerCorrect}/${headerChecked}`);
if (docs.some((d) => d.source === "real_spot_check")) console.log("real_spot_check: recall not measurable: the key contains only rows the extractor found");
for (const g of evaluateGates(summary)) console.log(`${g.pass ? "PASS" : "FAIL"} ${g.name} (${g.detail})`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await Bun.write(
  new URL(`${stamp}.json`, RESULTS),
  JSON.stringify({ provider: provider.name, model: process.env.EXTRACTION_MODEL ?? null, date: new Date().toISOString(), repeat, summary, docs }, null, 2),
);
console.log(`\nSaved apps/api/eval/results/${stamp}.json`);
