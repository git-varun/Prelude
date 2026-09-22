import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { OcrResult } from "@opd/shared";

// Local filesystem for dev, per your instruction: file_ref is an abstracted
// pointer ("local://<patient>/<name>") so swapping to a real S3-compatible
// bucket for staging/production is a config change (OBJECT_STORAGE_DRIVER),
// not a code change to every call site that handles a document.
const driver = process.env.OBJECT_STORAGE_DRIVER ?? "local";
const localBasePath = process.env.OBJECT_STORAGE_LOCAL_PATH ?? "./apps/api/.data/documents";

export interface StoredFile {
  file_ref: string;
}

export async function saveDocumentFile(patientId: string, filename: string, data: Blob): Promise<StoredFile> {
  if (driver !== "local") {
    throw new Error(`Unsupported OBJECT_STORAGE_DRIVER: ${driver}`);
  }

  const dir = path.join(localBasePath, patientId);
  await mkdir(dir, { recursive: true });

  const safeName = `${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const filePath = path.join(dir, safeName);
  await Bun.write(filePath, data);

  return { file_ref: `local://${patientId}/${safeName}` };
}

// The OCR pass (M2) persists its raw page/text output here, referenced by
// documents.ocr_text_ref, so downstream extraction can read it without
// re-running OCR. Same "abstracted pointer" contract as saveDocumentFile.
export async function saveOcrResult(patientId: string, documentId: string, result: OcrResult): Promise<StoredFile> {
  if (driver !== "local") {
    throw new Error(`Unsupported OBJECT_STORAGE_DRIVER: ${driver}`);
  }

  const dir = path.join(localBasePath, patientId, "ocr");
  await mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${documentId}.json`);
  await Bun.write(filePath, JSON.stringify(result));

  return { file_ref: `local://${patientId}/ocr/${documentId}.json` };
}

export function resolveLocalPath(fileRef: string): string {
  if (!fileRef.startsWith("local://")) {
    throw new Error(`Cannot resolve non-local file_ref: ${fileRef}`);
  }
  return path.join(localBasePath, fileRef.slice("local://".length));
}

// Used to clean up a file already written to storage when the DB insert that
// was meant to reference it fails (m1-backlog B4) — best-effort, since the
// upload should still surface the original DB error either way.
export async function deleteDocumentFile(fileRef: string): Promise<void> {
  try {
    await unlink(resolveLocalPath(fileRef));
  } catch {
    // Nothing to clean up, or cleanup itself failed — not worth failing the request over.
  }
}
