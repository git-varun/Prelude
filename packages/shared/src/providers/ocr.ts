export interface OcrPage {
  pageNumber: number;
  text: string;
}

export interface OcrResult {
  fullText: string;
  pages: OcrPage[];
  providerName: string;
  providerRaw?: unknown;
}

export interface OcrProvider {
  readonly name: string;
  extractText(file: Buffer, mimeType: string): Promise<OcrResult>;
}
