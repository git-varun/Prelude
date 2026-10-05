// Fixed verbatim (Decisions Log, clinical input — tooltip and footer copy are supplied,
// not ours to paraphrase). Rendered on every screen that shows marker values.
export function MarkerDisclaimerFooter() {
  return (
    <p className="app-footer-disclaimer">
      For clinical information aggregation only. Does not replace professional clinical
      evaluation or verified laboratory source documents. Tumor marker kinetics must be
      interpreted alongside histopathological, clinical, and radiological findings.
    </p>
  );
}
