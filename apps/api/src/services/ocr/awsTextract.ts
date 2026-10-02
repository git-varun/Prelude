import { TextractClient, DetectDocumentTextCommand, type Block } from "@aws-sdk/client-textract";
import type { OcrProvider, OcrResult, OcrPage } from "@prelude/shared";

function toPages(blocks: Block[]): OcrPage[] {
  const pageNumbers = [...new Set(blocks.map((block) => block.Page ?? 1))].sort((a, b) => a - b);
  return pageNumbers.map((pageNumber) => ({
    pageNumber,
    text: blocks
      .filter((block) => block.BlockType === "LINE" && (block.Page ?? 1) === pageNumber)
      .map((block) => block.Text ?? "")
      .join("\n"),
  }));
}

export class AwsTextractProvider implements OcrProvider {
  readonly name = "aws_textract";

  constructor(
    private readonly region: string,
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
  ) {}

  // Uses the synchronous DetectDocumentText API — supports JPEG/PNG/TIFF and
  // single-page PDF only. Multi-page PDFs require Textract's async
  // StartDocumentTextDetection + S3 flow, not implemented here; a
  // multi-page PDF upload will surface whatever error Textract itself
  // returns for that case rather than being silently mishandled.
  async extractText(file: Buffer, _mimeType: string): Promise<OcrResult> {
    const client = new TextractClient({
      region: this.region,
      credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
    });

    const response = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: file } }));
    const blocks = response.Blocks ?? [];
    const pages = toPages(blocks);

    return {
      fullText: pages.map((p) => p.text).join("\n\n"),
      pages,
      providerName: this.name,
      providerRaw: response,
    };
  }
}
