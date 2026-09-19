import { mkdir } from "node:fs/promises";
import path from "node:path";

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

export function resolveLocalPath(fileRef: string): string {
  if (!fileRef.startsWith("local://")) {
    throw new Error(`Cannot resolve non-local file_ref: ${fileRef}`);
  }
  return path.join(localBasePath, fileRef.slice("local://".length));
}
