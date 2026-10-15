import { locateSnippet } from "../lib/documentPane";

// Shared by the Source view and the document pane: the page text with the first match of the fact's snippet marked.
export function HighlightedText({ text, snippet }: { text: string; snippet: string | null }) {
  const hit = locateSnippet(text, snippet);
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
