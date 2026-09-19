// TODO: replace with the oncologist's actual controlled list before pilot.
// This list was never locked during scoping — it's illustrative in the
// frozen spec's own field examples (Blueprint M5), seeded here only so M1's
// patient-creation-with-marker-selection flow has something real to select.
export const CONTROLLED_MARKERS = ["CEA", "CA-125", "CA 19-9", "PSA"] as const;

export function isControlledMarker(name: string): boolean {
  return (CONTROLLED_MARKERS as readonly string[]).includes(name);
}
