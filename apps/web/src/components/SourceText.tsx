import { locateSnippet } from "../lib/documentPane";

// Shared by the Source view and the document pane: the page text with the fact's snippet marked (the occurrence nearest its stored location when there are several).
export function HighlightedText({ text, snippet, location = null }: { text: string; snippet: string | null; location?: string | null }) {
  const hit = locateSnippet(text, snippet, location);
  if (!hit) {
    return <pre className="source-text">{text}</pre>;
  }
  return (
    <pre className="source-text">
      {text.slice(0, hit.start)}
      <mark data-testid="source-highlight">{text.slice(hit.start, hit.end)}</mark>
      {text.slice(hit.end)}
    </pre>
  );
}
