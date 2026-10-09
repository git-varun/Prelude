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
  sourcePage: z.number().int().nullable(),
});

export const ExpectedDocSchema = z.object({
  documentType: z.enum(["prescription", "blood", "radiology"]),
  facts: z.array(ExpectedFactSchema),
});

export type ExpectedFact = z.infer<typeof ExpectedFactSchema>;
export type ExpectedDoc = z.infer<typeof ExpectedDocSchema>;
