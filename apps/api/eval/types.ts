import { z } from "zod";

export const ExpectedFactSchema = z.object({
  fieldType: z.enum(["marker_value", "reference_range", "treatment_regimen", "radiology_impression", "disease_status_trend"]),
  // Label as printed in the document; null for fact types without a label.
  markerLabel: z.string().nullable(),
  // Expected matchMarker(markerLabel) result; null when the label is not in the controlled list.
  canonicalMarker: z.string().nullable(),
  value: z.string().nullable(),
  unit: z.string().nullable(),
  referenceRange: z.string().nullable(),
  asOfDate: z.string().nullable(),
  // Other dates also accepted as correct (e.g. report date when asOfDate is the collection date).
  altDates: z.array(z.string()).optional(),
  // Other printed labels for the same test; merged with the shared table in aliases.ts.
  aliases: z.array(z.string()).optional(),
  sourcePage: z.number().int().nullable(),
});

export const ExpectedDocSchema = z.object({
  documentType: z.enum(["prescription", "blood", "radiology"]),
  source: z.enum(["real", "synthetic"]).default("real"),
  // Optional header expectations (compared loosely for names, exactly for dates).
  header: z
    .object({
      labName: z.string().nullable().optional(),
      collectedOn: z.string().nullable().optional(),
      patientName: z.string().nullable().optional(),
      labPatientRef: z.string().nullable().optional(),
    })
    .optional(),
  // "scripted" keys were generated from the document text by a script (not read by hand), so scoring a parser against them is circular. "spot_check" keys are exported from staff-checked extractions: they hold only rows the extractor found, so they cannot measure recall.
  keyOrigin: z.enum(["hand", "scripted", "spot_check"]).default("hand"),
  facts: z.array(ExpectedFactSchema),
});

export type ExpectedFact = z.infer<typeof ExpectedFactSchema>;
export type ExpectedDoc = z.infer<typeof ExpectedDocSchema>;
