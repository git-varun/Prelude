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

const provider = getExtractionProvider();
const docs: DocScore[] = [];

for (let run = 1; run <= repeat; run++) {
  for (const name of names) {
    const ocr = (await Bun.file(new URL(`${name}.ocr.json`, FIXTURES)).json()) as OcrResult;
    const expected = ExpectedDocSchema.parse(await Bun.file(new URL(`${name}.expected.json`, FIXTURES)).json());
    const { candidates, failedFieldTypes } = await provider.extractFacts(ocr, expected.documentType);
    const score = scoreDoc(repeat > 1 ? `${name}#${run}` : name, expected.facts, candidates, failedFieldTypes);
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
