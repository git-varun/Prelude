import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type DocumentFileCheck, type DocumentOcr, type PatientDocumentEntry, type ReviewFact } from "../api/client";
import { documentMetaLine, groupDocuments, HELD_NOTICE, isHeldIdentity, paneItemLabel, paneView } from "../lib/documentPane";
import { FileTextIcon } from "./icons";
import { HighlightedText } from "./SourceText";
import { useAuth } from "../auth/AuthContext";
import { OVERLAY_QUERY, useOverlayMode, usePane } from "./PaneContext";

export type DocsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; documents: PatientDocumentEntry[] };

export const NO_DOCUMENT_TEXT = "No document is available for this value.";
export const NO_TEXT_TEXT = "This document has no readable text; open the original file.";
const NOT_EXTRACTED_TEXT = "Not extracted in this version";

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "held" }
  | { status: "ready"; ocr: DocumentOcr | null; fact: ReviewFact | null; file: DocumentFileCheck; extractionStatus: string };

// A held document is not part of the record: its text, highlight, original file and full-page link are never shown.
function HeldNotice({ patientId }: { patientId: string }) {
  const { user } = useAuth();
  return (
    <div data-testid="pane-held">
      <p className="muted">{HELD_NOTICE}</p>
      {user?.role === "oncologist" && <a className="source-link" href={`#/patients/${patientId}/snapshot`}>Review on the Snapshot</a>}
    </div>
  );
}

// The selected document's text at the fact's page. The fact is looked up in this document's own facts, so the
// "Open full page" link below only ever points at a fact that exists there.
function PaneDetail({ documentId, factId, patientId, heldListed }: { documentId: string; factId: string | null; patientId: string; heldListed: boolean }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const latest = useRef(0);

  const load = useCallback(async () => {
    const token = ++latest.current;
    if (heldListed) { setState({ status: "held" }); return; } // nothing about a held document is requested
    setState({ status: "loading" });
    try {
      // The document first: if the server says it is held, neither its facts nor its file are requested.
      const doc = await api.getDocument(documentId);
      if (token !== latest.current) return;
      if (doc.held) { setState({ status: "held" }); return; }
      const [facts, file] = await Promise.all([
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
  }, [documentId, factId, heldListed]);

  useEffect(() => {
    void load();
    return () => { latest.current++; };
  }, [load]);

  const pageRef = useRef<HTMLDivElement>(null);
  // Open at the highlight: bring the marked text to the middle of the pane once the page is on screen.
  useEffect(() => {
    if (state.status === "ready") pageRef.current?.querySelector("mark")?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [state]);

  if (state.status === "held") return <HeldNotice patientId={patientId} />;
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
  const snippet = fact && fact.fallback_level === "exact" ? fact.source_snippet : null;
  const view = paneView({ ocr, page: fact?.source_page ?? null, snippet, location: fact?.source_location ?? null });
  const text = view.text;
  const readable = text !== null && text.trim() !== "";
  const fileLink = file.ok ? (
    <a className="source-link" href={file.url} target="_blank" rel="noreferrer">Open original file</a>
  ) : null;

  return (
    <div className="doc-pane__detail">
      <div className="doc-pane__actions">
        {view.tag && <span className="tag" data-testid="pane-provenance">{view.tag}</span>}
        {fact && <a className="source-link" href={`#/documents/${documentId}/source?fact=${fact.id}`}>Open full page</a>}
        {fileLink}
      </div>
      {extractionStatus === "not_extracted" && <p className="muted">{NOT_EXTRACTED_TEXT}</p>}
      {readable ? (
        <div ref={pageRef} className="doc-pane__page" data-testid="pane-page"><HighlightedText text={text} snippet={view.hit ? snippet : null} location={fact?.source_location ?? null} /></div>
      ) : (
        <p className="muted">{file.ok ? NO_TEXT_TEXT : "This document has no readable text."}</p>
      )}
    </div>
  );
}

export function DocumentPane({ patientId, docs, onRetry }: { patientId: string; docs: DocsState; onRetry: () => void }) {
  const pane = usePane()!;
  const { paneOpen, openSeq, opener, paneDocId, selectedFactId, noDocument, openList, openDocument, close } = pane;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const overlay = useOverlayMode();
  const modal = overlay && paneOpen;

  // While the overlay is open the rest of the shell is inert (and hidden from assistive tech). The cleanup runs
  // before the focus-return effect below in the same commit, so the opener is focusable again by then.
  useEffect(() => {
    if (!modal) return;
    const others = Array.from(asideRef.current?.parentElement?.children ?? []).filter((el) => el !== asideRef.current && el !== backdropRef.current);
    for (const el of others) { el.setAttribute("inert", ""); el.setAttribute("aria-hidden", "true"); }
    return () => { for (const el of others) { el.removeAttribute("inert"); el.removeAttribute("aria-hidden"); } };
  }, [modal]);

  // Tab and Shift+Tab cycle inside the overlay.
  const trapTab = (e: React.KeyboardEvent) => {
    if (!modal || e.key !== "Tab") return;
    const items = Array.from(asideRef.current!.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === titleRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

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
          <FileTextIcon size={20} />
        </button>
      </aside>
    );
  }

  const groups = docs.status === "ready" ? groupDocuments(docs.documents) : [];

  return (
    <>
      <div ref={backdropRef} className="doc-pane__backdrop" data-testid="doc-pane-backdrop" onClick={close} />
      <aside
        ref={asideRef} className="doc-pane doc-pane--open" aria-label="Documents" data-testid="doc-pane" data-open="true"
        role={modal ? "dialog" : undefined} aria-modal={modal ? "true" : undefined} onKeyDown={trapTab}
      >
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
                <span className="doc-pane__item-label">{paneItemLabel(d.document_type)}</span>
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
            <PaneDetail
              key={`${paneDocId}:${selectedFactId ?? ""}`} documentId={paneDocId} factId={selectedFactId} patientId={patientId}
              heldListed={isHeldIdentity(docs.status === "ready" ? docs.documents.find((d) => d.id === paneDocId)?.identity_status ?? null : null)}
            />
          ) : (
            <p className="muted">Select a document, or click a value to see where it was read from.</p>
          )}
        </div>
      </aside>
    </>
  );
}
