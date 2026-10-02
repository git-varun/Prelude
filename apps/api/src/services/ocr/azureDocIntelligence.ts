import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";
import type { AnalyzeOperationOutput, AnalyzeResultOutput } from "@azure-rest/ai-document-intelligence";
import { AzureKeyCredential } from "@azure/core-auth";
import type { OcrProvider, OcrResult, OcrPage } from "@prelude/shared";

// prebuilt-read is Azure's general OCR model (text + layout, no
// form/structure extraction) — the right fit here since field-level
// extraction is a separate step (services/extraction.ts, M2), not this
// adapter's job.
const MODEL_ID = "prebuilt-read";

function toPages(analyzeResult: AnalyzeResultOutput): OcrPage[] {
  return analyzeResult.pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: (page.lines ?? []).map((line) => line.content).join("\n"),
  }));
}

export class AzureDocIntelligenceProvider implements OcrProvider {
  readonly name = "azure_doc_intelligence";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  // mimeType is unused: Azure's base64Source flow infers the document
  // format from content, so the adapter doesn't need it — kept in the
  // signature only because OcrProvider requires it.
  async extractText(file: Buffer, _mimeType: string): Promise<OcrResult> {
    const client = DocumentIntelligence(this.endpoint, new AzureKeyCredential(this.apiKey));

    const initialResponse = await client.path("/documentModels/{modelId}:analyze", MODEL_ID).post({
      contentType: "application/json",
      body: { base64Source: file.toString("base64") },
    });

    if (isUnexpected(initialResponse)) {
      const message = initialResponse.body?.error?.message ?? `HTTP ${initialResponse.status}`;
      throw new Error(`Azure Document Intelligence request failed: ${message}`);
    }

    const poller = getLongRunningPoller(client, initialResponse);
    const result = await poller.pollUntilDone();
    const body = result.body as AnalyzeOperationOutput;

    if (body.status !== "succeeded" || !body.analyzeResult) {
      throw new Error(`Azure Document Intelligence analysis did not succeed: ${body.status} ${body.error?.message ?? ""}`.trim());
    }

    return {
      fullText: body.analyzeResult.content,
      pages: toPages(body.analyzeResult),
      providerName: this.name,
      providerRaw: body.analyzeResult,
    };
  }
}
