import type { OutsideEncounterRef, SummaryItem } from "../api/client";
import { navigate } from "../router";

export const NOT_FOUND_TEXT = "Not found in documents";
export const NOT_EXTRACTED_TEXT = "Not extracted yet";

const TRUST_LABELS: Record<string, string> = {
  unverified: "unverified",
  staff_corrected: "staff corrected",
  oncologist_signed_off: "signed off",
  reopened_by_oncologist: "reopened",
};

export function trustLabel(state: string): string {
  return TRUST_LABELS[state] ?? state.replace(/_/g, " ");
}

export const elsewhereLabel = (facility: string) => `visit elsewhere · ${facility}`;

export function ElsewhereTag({ encounter }: { encounter: OutsideEncounterRef | null | undefined }) {
  if (!encounter) return null;
  return <span className="tag tag--elsewhere" data-testid="elsewhere-tag">{elsewhereLabel(encounter.facility)}</span>;
}

export function sourceHref(item: SummaryItem): string {
  return `/documents/${item.document_id}/source?fact=${item.fact_id}`;
}

export function SourceLink({ item }: { item: SummaryItem }) {
  return (
    <a
      className="source-link"
      href={`#${sourceHref(item)}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(sourceHref(item));
      }}
    >
      Source
    </a>
  );
}

// "13 Oct 2026 · unverified" -- the fact's own date (if any) and its trust state, as plain text.
export function sourceLine(item: SummaryItem): string {
  return [item.as_of_date, item.facility, item.outside_encounter ? elsewhereLabel(item.outside_encounter.facility) : null, trustLabel(item.verification_state)]
    .filter(Boolean).join(" · ");
}
