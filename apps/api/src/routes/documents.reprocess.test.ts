import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import * as providerFactory from "../services/providerFactory";
import { reprocessDocument } from "./documents";
import { saveDocumentFile, saveOcrResult } from "../services/storage";
import type { ExtractionProvider, OcrProvider, OcrResult } from "@prelude/shared";
import { sql } from "../db/client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

delete process.env.OCR_PROVIDER;
delete process.env.EXTRACTION_PROVIDER;

let staff: TestUser;
let patientId: string;
let visitId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "reprocess-test-staff");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id) VALUES (${patientId}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id);
});

const OCR: OcrResult = { fullText: "CEA 4.2 ng/mL", pages: [{ pageNumber: 1, text: "CEA 4.2 ng/mL" }], providerName: "fake-ocr", providerRaw: null };

const fakeOcr = (calls: { n: number }): OcrProvider => ({
  name: "fake-ocr",
  async extractText() {
    calls.n++;
    return OCR;
  },
});

const fakeExtraction = (): ExtractionProvider => ({
  name: "fake-extraction",
  extractFacts: async () => ({
    candidates: [
      {
        fieldType: "radiology_impression", value: "Stable disease", unit: null, referenceRange: null, asOfDate: "2026-01-01",
        coverageStatus: "value_found", sourcePage: 1, sourceLocation: null, sourceSnippet: null, confidence: 0.9,
      },
    ],
    failedFieldTypes: [],
  }),
});

async function documentWith(opts: { ocr: "failed" | "done"; extraction: string; type?: string; withFile?: boolean; withOcrText?: boolean; identity?: string }) {
  const fileRef = opts.withFile === false ? "local://missing/none.pdf" : (await saveDocumentFile(patientId, "report.pdf", new Blob(["%PDF-1.4 test"]))).file_ref;
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, extraction_status, identity_status)
    VALUES (${patientId}, ${visitId}, ${fileRef}, ${opts.type ?? "radiology"}, 'own_hospital', ${staff.id}, ${opts.ocr}, ${opts.extraction}::extraction_status, ${opts.identity ?? null}::identity_status)
    RETURNING id`;
  if (opts.withOcrText) {
    const { file_ref } = await saveOcrResult(patientId, doc.id, OCR);
    await sql`UPDATE documents SET ocr_text_ref = ${file_ref} WHERE id = ${doc.id}`;
  }
  return doc.id as string;
}

function call(id: string) {
  const req = new Request(`http://localhost/documents/${id}/reprocess`, { method: "POST" }) as Request & { params: { id: string } };
  req.params = { id };
  return reprocessDocument(req, asAuthedUser(staff));
}

async function withProviders<T>(ocrCalls: { n: number }, fn: () => Promise<T>): Promise<T> {
  const o = spyOn(providerFactory, "getOcrProvider").mockImplementation(() => fakeOcr(ocrCalls));
  const e = spyOn(providerFactory, "getExtractionProvider").mockImplementation(() => fakeExtraction());
  try {
    return await fn();
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

test("reprocess after an OCR failure re-runs OCR from the stored file, then extraction, and audits it", async () => {
  const id = await documentWith({ ocr: "failed", extraction: "pending", type: "radiology" });
  const ocr = { n: 0 };
  const res = await withProviders(ocr, () => call(id));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body).toMatchObject({ id, ocr_status: "done", extraction_status: "done" });
  expect(ocr.n).toBe(1);
  const [{ n: facts }] = await sql`SELECT count(*)::int AS n FROM facts WHERE document_id = ${id}`;
  expect(facts).toBe(1);
  const [audit] = await sql`SELECT actor_id, after_value FROM audit_log WHERE entity_id = ${id} AND action = 'reprocess'`;
  expect(audit.actor_id).toBe(staff.id);
});

test("reprocess after an extraction failure keeps the stored OCR text and does not call OCR again", async () => {
  const id = await documentWith({ ocr: "done", extraction: "failed", withOcrText: true });
  const ocr = { n: 0 };
  const res = await withProviders(ocr, () => call(id));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ocr_status: "done", extraction_status: "done" });
  expect(ocr.n).toBe(0);
});

test("reprocess when the stored OCR text is unreadable falls back to running OCR again", async () => {
  const id = await documentWith({ ocr: "done", extraction: "failed", withOcrText: false });
  await sql`UPDATE documents SET ocr_text_ref = 'local://missing/ocr/none.json' WHERE id = ${id}`;
  const ocr = { n: 0 };
  const res = await withProviders(ocr, () => call(id));
  expect(res.status).toBe(200);
  expect(ocr.n).toBe(1);
  expect(await res.json()).toMatchObject({ ocr_status: "done", extraction_status: "done" });
});

test("a reprocess that fails again leaves the document failed (and can be tried again)", async () => {
  const id = await documentWith({ ocr: "failed", extraction: "pending" });
  const o = spyOn(providerFactory, "getOcrProvider").mockImplementation(() => {
    throw new Error("OCR_PROVIDER is not set.");
  });
  try {
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ocr_status: "failed" });
  } finally {
    o.mockRestore();
  }
  const res2 = await withProviders({ n: 0 }, () => call(id));
  expect(await res2.json()).toMatchObject({ ocr_status: "done", extraction_status: "done" });
});

test("only a failed document can be reprocessed: done, partial, 'other' and rejected ones are refused (409)", async () => {
  for (const opts of [
    { ocr: "done" as const, extraction: "done" },
    { ocr: "done" as const, extraction: "partial" },
    { ocr: "done" as const, extraction: "not_extracted", type: "other" },
    { ocr: "failed" as const, extraction: "pending", identity: "rejected" },
  ]) {
    const id = await documentWith(opts);
    const ocr = { n: 0 };
    const res = await withProviders(ocr, () => call(id));
    expect(res.status).toBe(409);
    expect(ocr.n).toBe(0);
  }
});

test("a second reprocess while one is running is refused (the claim is atomic)", async () => {
  const id = await documentWith({ ocr: "failed", extraction: "pending" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: OcrProvider = { name: "slow", async extractText() { await gate; return OCR; } };
  const o = spyOn(providerFactory, "getOcrProvider").mockImplementation(() => slow);
  const e = spyOn(providerFactory, "getExtractionProvider").mockImplementation(() => fakeExtraction());
  try {
    const first = call(id);
    await new Promise((r) => setTimeout(r, 100));
    expect((await call(id)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
});

test("when the original file is no longer stored, it says so and the document stays failed", async () => {
  const id = await documentWith({ ocr: "failed", extraction: "pending", withFile: false });
  const res = await withProviders({ n: 0 }, () => call(id));
  expect(res.status).toBe(404);
  expect(((await res.json()) as any).message).toContain("original file");
  const [row] = await sql`SELECT ocr_status FROM documents WHERE id = ${id}`;
  expect(row.ocr_status).toBe("failed");
});

test("unknown and malformed ids are 404", async () => {
  expect((await call("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  expect((await call("not-a-uuid")).status).toBe(404);
});
