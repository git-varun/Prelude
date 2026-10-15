import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type DocumentFileCheck, type DocumentOcr, type PatientDocumentEntry, type ReviewFact } from "../api/client";
import { documentTypeLabel } from "../lib/documentTypeLabel";
import { documentMetaLine, groupDocuments, pageText, provenanceTag } from "../lib/documentPane";
import { HighlightedText } from "./SourceText";
import { usePane } from "./PaneContext";

export type DocsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; documents: PatientDocumentEntry[] };

const OVERLAY_QUERY = "(max-width: 1179.98px)";
export const NO_DOCUMENT_TEXT = "No document is available for this value.";
export const NO_TEXT_TEXT = "This document has no readable text; open the original file.";
const NOT_EXTRACTED_TEXT = "Not extracted in this version";

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; ocr: DocumentOcr | null; fact: ReviewFact | null; file: DocumentFileCheck; extractionStatus: string };

// The selected document's text at the fact's page. The fact is looked up in this document's own facts, so the
// "Open full page" link below only ever points at a fact that exists there.
function PaneDetail({ documentId, factId }: { documentId: string; factId: string | null }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const latest = useRef(0);

  const load = useCallback(async () => {
    const token = ++latest.current;
    setState({ status: "loading" });
    try {
      const [doc, facts, file] = await Promise.all([
        api.getDocument(documentId),
        factId ? api.getDocumentFacts(documentId) : Promise.resolve(null),
        api.checkDocumentFile(documentId),
      ]);
      if (token !== latest.current) return;
      const fact = facts?.facts.find((f) => f.id === factId) ?? null;
      setState({ status: "ready", ocr: doc.ocr, fact, file, extractionStatus: doc.document.extraction_status });
    } catch (err) {
      if (token !== latest.current) return;
      setState({ status: "error", message: err instanceof ApiError ? err.message : "Failed to load this document." });
    }
  }, [documentId, factId]);

  useEffect(() => {
    void load();
    return () => { latest.current++; };
  }, [load]);

  if (state.status === "loading") return <p className="muted" data-testid="pane-loading">Loading...</p>;
  if (state.status === "error") {
    return (
      <div className="error-banner">
        {state.message}{" "}
        <button className="btn btn--ghost" type="button" onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  const { ocr, fact, file, extractionStatus } = state;
  const page = fact?.source_page ?? null;
  const text = pageText(ocr, page);
  const readable = text !== null && text.trim() !== "";
  const snippet = fact && fact.fallback_level === "exact" ? fact.source_snippet : null;
  const fileLink = file.ok ? (
    <a className="source-link" href={file.url} target="_blank" rel="noreferrer">Open original file</a>
  ) : null;

  return (
    <div className="doc-pane__detail">
      <div className="doc-pane__actions">
        {readable && <span className="tag" data-testid="pane-provenance">{provenanceTag({ level: fact?.fallback_level ?? null, snippet, text, page })}</span>}
        {fact && <a className="source-link" href={`#/documents/${documentId}/source?fact=${fact.id}`}>Open full page</a>}
        {fileLink}
      </div>
      {extractionStatus === "not_extracted" && <p className="muted">{NOT_EXTRACTED_TEXT}</p>}
      {readable ? (
        <div className="doc-pane__page" data-testid="pane-page"><HighlightedText text={text} snippet={snippet} /></div>
      ) : (
        <p className="muted">{file.ok ? NO_TEXT_TEXT : "This document has no readable text."}</p>
      )}
    </div>
  );
}

export function DocumentPane({ docs, onRetry }: { docs: DocsState; onRetry: () => void }) {
  const pane = usePane()!;
  const { paneOpen, openSeq, opener, paneDocId, selectedFactId, noDocument, openList, openDocument, close } = pane;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Focus moves into the pane header on every open, and back to whatever opened it on close.
  useEffect(() => {
    if (paneOpen) titleRef.current?.focus();
  }, [paneOpen, openSeq]);
  useEffect(() => {
    if (!paneOpen && wasOpen.current) {
      const back = opener.current;
      (back && back.isConnected ? back : railRef.current)?.focus();
    }
    wasOpen.current = paneOpen;
  }, [paneOpen, opener]);

  // Escape closes the pane when it is an overlay.
  useEffect(() => {
    if (!paneOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && window.matchMedia(OVERLAY_QUERY).matches) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneOpen, close]);

  if (!paneOpen) {
    return (
      <aside className="doc-pane" aria-label="Documents" data-testid="doc-pane" data-open="false">
        <button ref={railRef} className="doc-pane__rail-btn" type="button" aria-label="Open documents panel" title="Documents" onClick={openList}>
          <span aria-hidden="true">📄</span>
        </button>
      </aside>
    );
  }

  const groups = docs.status === "ready" ? groupDocuments(docs.documents) : [];

  return (
    <>
      <div className="doc-pane__backdrop" data-testid="doc-pane-backdrop" onClick={close} />
      <aside className="doc-pane doc-pane--open" aria-label="Documents" data-testid="doc-pane" data-open="true">
        <div className="doc-pane__header">
          <h2 ref={titleRef} tabIndex={-1} className="doc-pane__title">Documents · all</h2>
          <button className="btn btn--ghost" type="button" aria-label="Close documents panel" onClick={close}>Close</button>
        </div>

        {docs.status === "loading" && <p className="muted">Loading...</p>}
        {docs.status === "error" && (
          <div className="error-banner">
            {docs.message}{" "}
            <button className="btn btn--ghost" type="button" onClick={onRetry}>Retry</button>
          </div>
        )}
        {docs.status === "ready" && groups.length === 0 && <p className="muted">No documents yet.</p>}
        {groups.map(({ group, docs: items }) => (
          <section key={group} className="doc-pane__group" aria-label={group}>
            <h3 className="doc-pane__group-label">{group}</h3>
            {items.map((d) => (
              <button
                key={d.id} type="button" className={`doc-pane__item${d.id === paneDocId ? " doc-pane__item--selected" : ""}`}
                aria-current={d.id === paneDocId ? "true" : undefined} data-testid="pane-item" onClick={() => openDocument(d.id)}
              >
                <span className="doc-pane__item-label">{documentTypeLabel(d.document_type)}</span>
                <span className="doc-pane__item-meta">
                  {documentMetaLine(d)}
                  {(d.identity_status === "mismatch" || d.identity_status === "awaiting_oncologist") && " · held for identity"}
                </span>
              </button>
            ))}
          </section>
        ))}

        <div className="doc-pane__body">
          {noDocument ? (
            <p className="muted" data-testid="pane-no-document">{NO_DOCUMENT_TEXT}</p>
          ) : paneDocId ? (
            <PaneDetail key={`${paneDocId}:${selectedFactId ?? ""}`} documentId={paneDocId} factId={selectedFactId} />
          ) : (
            <p className="muted">Select a document, or click a value to see where it was read from.</p>
          )}
        </div>
      </aside>
    </>
  );
}
