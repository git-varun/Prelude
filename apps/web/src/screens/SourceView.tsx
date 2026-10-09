import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type DocumentFileCheck, type DocumentOcr, type DocumentRecord, type ReviewFact } from "../api/client";
import { navigate } from "../router";

function pageText(ocr: DocumentOcr | null, pageNumber: number | null): string | null {
  if (!ocr) return null;
  if (pageNumber === null) return ocr.fullText;
  return ocr.pages.find((p) => p.pageNumber === pageNumber)?.text ?? ocr.fullText;
}

// Plain substring search against OCR text, per the Source view's stated constraint: no bounding
// box or geometry exists to highlight against, only a text match.
function HighlightedText({ text, snippet }: { text: string; snippet: string | null }) {
  const idx = snippet ? text.indexOf(snippet) : -1;
  if (idx === -1 || !snippet) {
    return <pre className="source-text">{text}</pre>;
  }
  return (
    <pre className="source-text">
      {text.slice(0, idx)}
      <mark data-testid="source-highlight">{text.slice(idx, idx + snippet.length)}</mark>
      {text.slice(idx + snippet.length)}
    </pre>
  );
}

export function OriginalDocument({ fileCheck, sourcePage }: { fileCheck: DocumentFileCheck; sourcePage: number | null }) {
  if (fileCheck.contentType?.startsWith("image/")) {
    return <img src={fileCheck.url} alt="Source document" data-testid="source-file-image" style={{ maxWidth: "100%" }} />;
  }
  const src = sourcePage !== null ? `${fileCheck.url}#page=${sourcePage}` : fileCheck.url;
  return (
    <iframe
      src={src}
      title="Source document"
      data-testid="source-file-pdf"
      style={{ width: "100%", height: 600, border: "1px solid var(--border, #ccc)" }}
    />
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; document: DocumentRecord; ocr: DocumentOcr | null; fact: ReviewFact; fileCheck: DocumentFileCheck };

export function SourceView({ documentId, factId }: { documentId: string; factId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const latestLoad = useRef(0);
  const currentKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    const key = `${documentId}:${factId}`;
    if (currentKey.current !== key) return;
    const token = ++latestLoad.current;
    try {
      const [docResult, factsResult, fileCheck] = await Promise.all([
        api.getDocument(documentId),
        api.getDocumentFacts(documentId),
        api.checkDocumentFile(documentId),
      ]);
      if (token !== latestLoad.current) return;

      const fact = factsResult.facts.find((f) => f.id === factId);
      if (!fact) {
        setState({ status: "error", message: "This fact could not be found on this document." });
        return;
      }
      setState({ status: "ready", document: docResult.document, ocr: docResult.ocr, fact, fileCheck });
    } catch (err) {
      if (token !== latestLoad.current) return;
      setState({ status: "error", message: err instanceof ApiError ? err.message : "Failed to load the source document." });
    }
  }, [documentId, factId]);

  useEffect(() => {
    currentKey.current = `${documentId}:${factId}`;
    setState({ status: "loading" });
    void load();
    return () => {
      currentKey.current = null;
      latestLoad.current++;
    };
  }, [load, documentId, factId]);

  if (state.status === "loading") return <p className="muted">Loading...</p>;
  if (state.status === "error") return <div className="error-banner">{state.message}</div>;

  const { document, ocr, fact, fileCheck } = state;
  const level = fact.fallback_level;
  const text = pageText(ocr, fact.source_page);

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Source document</h1>
          {document.imaging_modality && (
            <p className="muted" style={{ margin: 0 }}>{document.imaging_modality.replace(/_/g, " ")}</p>
          )}
        </div>
        <button className="btn btn--ghost" onClick={() => navigate(`/documents/${document.id}/review`)}>
          Back to review
        </button>
      </div>

      {level === "document" && <p className="muted">Source detail unavailable</p>}
      {level === "page" && <p className="muted">Exact location isn't available for this fact — showing page {fact.source_page}.</p>}

      {fileCheck.ok ? (
        <div className="card">
          <OriginalDocument fileCheck={fileCheck} sourcePage={fact.source_page} />
        </div>
      ) : (
        <div className="card">
          <p className="muted">The original document couldn't be rendered. Showing extracted text instead.</p>
          {text !== null ? (
            <HighlightedText text={text} snippet={level === "exact" ? fact.source_snippet : null} />
          ) : (
            <p className="muted">Source detail unavailable</p>
          )}
        </div>
      )}

      {fileCheck.ok && level === "exact" && text !== null && (
        <div className="card">
          <h2>Extracted text</h2>
          <HighlightedText text={text} snippet={fact.source_snippet} />
        </div>
      )}
    </div>
  );
}
