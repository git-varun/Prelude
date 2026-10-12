// Controlled marker list + disease-site panels, per the partner oncologist's
// clinical input (Decisions Log, "Clinical input — partner oncologist (Oct
// 2026)"). Replaces the M2-era 4-marker placeholder.

export interface MarkerDefinition {
  canonical: string;
  // Synonym labels an LLM extraction pass might emit for this marker.
  // Matched case/whitespace-insensitively, never by substring/fuzzy
  // comparison — see matchMarker's hard-negative tests.
  aliases: readonly string[];
  units: readonly string[];
  // Labels that are ambiguous across lab panels (bare "Tg" vs a lipid-panel "TG"). They match only when the
  // row's unit is one of `units`; with no unit or any other unit they stay unmapped (staff map them by hand).
  unitGatedAliases?: readonly string[];
}

export const MARKER_REGISTRY: readonly MarkerDefinition[] = [
  { canonical: "CEA", aliases: ["CEA", "Carcinoembryonic Antigen"], units: ["ng/mL", "µg/L"] },
  { canonical: "CA 19-9", aliases: ["CA 19-9", "CA19-9"], units: ["U/mL", "kU/L"] },
  { canonical: "CA-125", aliases: ["CA-125", "CA 125"], units: ["U/mL", "kU/L"] },
  { canonical: "CA 15-3", aliases: ["CA 15-3", "CA15-3"], units: ["U/mL", "kU/L"] },
  { canonical: "AFP", aliases: ["AFP", "Alpha-Fetoprotein", "Alpha Fetoprotein"], units: ["ng/mL"] },
  {
    canonical: "Total PSA",
    aliases: ["Total PSA", "PSA", "tPSA", "Total Prostate Specific Antigen"],
    units: ["ng/mL"],
  },
  {
    canonical: "Beta-hCG",
    // Quantitative serum assay only (Decisions Log hard rule) — deliberately
    // excludes bare "hCG" and anything naming a qualitative/urine test.
    aliases: ["Beta-hCG", "Beta hCG", "b-hCG", "Quantitative Beta-hCG", "Serum Beta-hCG", "Quantitative hCG"],
    units: ["mIU/mL"],
  },
  { canonical: "LDH", aliases: ["LDH", "Lactate Dehydrogenase"], units: ["U/L"] },
  { canonical: "HE4", aliases: ["HE4", "Human Epididymis Protein 4"], units: ["pmol/L"] },
  { canonical: "CA 72-4", aliases: ["CA 72-4", "CA72-4"], units: ["U/mL", "kU/L"] },
  {
    canonical: "Thyroglobulin (Tg)",
    aliases: ["Thyroglobulin (Tg)", "Thyroglobulin"],
    unitGatedAliases: ["Tg"],
    units: ["ng/mL", "µg/L"],
  },
  {
    canonical: "Anti-Tg (TgAb)",
    aliases: ["Anti-Tg (TgAb)", "Anti-Tg", "TgAb", "Anti-Thyroglobulin", "Anti-Thyroglobulin Antibody"],
    units: ["IU/mL"],
  },
  { canonical: "Calcitonin", aliases: ["Calcitonin"], units: ["pg/mL"] },
] as const;

export const CONTROLLED_MARKERS = MARKER_REGISTRY.map((m) => m.canonical) as readonly string[];

export function isControlledMarker(name: string): boolean {
  return (CONTROLLED_MARKERS as readonly string[]).includes(name);
}

function normalize(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

// Deterministic, case/space-tolerant exact match — never substring/fuzzy, so
// "Free PSA" never absorbs into "Total PSA", "CEACAM" never absorbs into
// "CEA", "CA 27-29" never absorbs into "CA 15-3", and a qualitative/urine hCG
// label never matches Beta-hCG. No match -> null (the existing
// unmapped-marker / extraction_uncertain path).
export function matchMarker(rawLabel: string, unit?: string | null): string | null {
  const normalized = normalize(rawLabel);
  const normalizedUnit = unit ? normalize(unit) : null;
  for (const marker of MARKER_REGISTRY) {
    if (marker.aliases.some((alias) => normalize(alias) === normalized)) {
      return marker.canonical;
    }
    if (
      normalizedUnit !== null &&
      marker.unitGatedAliases?.some((alias) => normalize(alias) === normalized) &&
      marker.units.some((u) => normalize(u) === normalizedUnit)
    ) {
      return marker.canonical;
    }
  }
  return null;
}

// Selecting a disease site at patient creation pre-checks the union of its
// panel(s) (frozen spec's "default marker set based on cancer type", Journey B).
export const DISEASE_SITE_PANELS: Readonly<Record<string, readonly string[]>> = {
  "Colorectal/Lower GI": ["CEA", "CA 19-9"],
  "HPB": ["CA 19-9", "AFP", "CEA"],
  "Breast": ["CA 15-3", "CEA"],
  "Gynecologic": ["CA-125", "HE4", "CEA"],
  "Urologic": ["Total PSA", "AFP", "Beta-hCG", "LDH"],
  "Upper GI": ["CEA", "CA 19-9", "CA 72-4"],
  "Endocrine/Thyroid": ["Thyroglobulin (Tg)", "Anti-Tg (TgAb)", "Calcitonin", "CEA"],
};

export const DISEASE_SITES = Object.keys(DISEASE_SITE_PANELS) as readonly string[];

// No site selected yet.
export const FALLBACK_MARKER_SET: readonly string[] = ["CEA", "CA 19-9", "CA-125", "CA 15-3", "AFP", "Total PSA"];
