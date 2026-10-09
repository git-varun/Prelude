import { readdir } from "node:fs/promises";
import type { OcrResult } from "@prelude/shared";
import { getExtractionProvider } from "../src/services/providerFactory";
import { ExpectedDocSchema } from "./types";
import { formatSummary, scoreDoc, summarize, type DocScore } from "./score";

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

const provider = getExtractionProvider();
const docs: DocScore[] = [];

for (let run = 1; run <= repeat; run++) {
  for (const name of names) {
    const ocr = (await Bun.file(new URL(`${name}.ocr.json`, FIXTURES)).json()) as OcrResult;
    const expected = ExpectedDocSchema.parse(await Bun.file(new URL(`${name}.expected.json`, FIXTURES)).json());
    let result = await provider.extractFacts(ocr, expected.documentType);
    for (let attempt = 1; attempt <= retries && result.failedFieldTypes.length > 0; attempt++) {
      console.warn(`${name}: ${result.failedFieldTypes.join(",")} failed; retry ${attempt}/${retries} in ${retryWaitMs / 1000}s`);
      await sleep(retryWaitMs);
      result = await provider.extractFacts(ocr, expected.documentType);
    }
    const { candidates, failedFieldTypes } = result;
    if (delayMs > 0) await sleep(delayMs);
    const score = scoreDoc(repeat > 1 ? `${name}#${run}` : name, expected.facts, candidates, failedFieldTypes, expected.source);
    docs.push(score);
    console.log(
      `${score.name}: expected ${score.expected.length}, extracted ${score.extracted.length}, ` +
        `matched ${score.results.length}, wrong ${score.results.filter((r) => !r.correct).length}, ` +
        `missed ${score.missed.length}, spurious ${score.spurious.length}` +
        (failedFieldTypes.length ? ` | FAILED field types: ${failedFieldTypes.join(",")}` : ""),
    );
  }
}

const summary = summarize(docs);
console.log("\n" + formatSummary(summary));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await Bun.write(
  new URL(`${stamp}.json`, RESULTS),
  JSON.stringify({ provider: provider.name, model: process.env.EXTRACTION_MODEL ?? null, date: new Date().toISOString(), repeat, summary, docs }, null, 2),
);
console.log(`\nSaved apps/api/eval/results/${stamp}.json`);
