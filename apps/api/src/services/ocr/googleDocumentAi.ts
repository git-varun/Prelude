import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import type { google } from "@google-cloud/documentai/build/protos/protos";
import type { OcrProvider, OcrResult, OcrPage } from "@opd/shared";

type Document = google.cloud.documentai.v1.IDocument;

// Document AI's non-'us' locations are served from a regional endpoint, not
// the global default — see
// https://cloud.google.com/document-ai/docs/regions.
function apiEndpointFor(location: string): string | undefined {
  return location === "us" ? undefined : `${location}-documentai.googleapis.com`;
}

function toPages(document: Document): OcrPage[] {
  const text = document.text ?? "";
  return (document.pages ?? []).map((page, index) => ({
    pageNumber: page.pageNumber ?? index + 1,
    text: (page.layout?.textAnchor?.textSegments ?? [])
      .map((segment) => text.slice(Number(segment.startIndex ?? 0), Number(segment.endIndex ?? 0)))
      .join(""),
  }));
}

export class GoogleDocumentAiProvider implements OcrProvider {
  readonly name = "google_document_ai";

  constructor(
    private readonly projectId: string,
    private readonly location: string,
    private readonly processorId: string,
    private readonly credentials: { client_email: string; private_key: string },
  ) {}

  async extractText(file: Buffer, mimeType: string): Promise<OcrResult> {
    const client = new DocumentProcessorServiceClient({
      projectId: this.projectId,
      credentials: this.credentials,
      apiEndpoint: apiEndpointFor(this.location),
    });

    const name = `projects/${this.projectId}/locations/${this.location}/processors/${this.processorId}`;
    const [response] = await client.processDocument({
      name,
      rawDocument: { content: file, mimeType },
    });

    const document = response.document ?? {};
    const pages = toPages(document);

    return {
      fullText: document.text ?? "",
      pages,
      providerName: this.name,
      providerRaw: document,
    };
  }
}
