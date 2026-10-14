const LABELS: Record<string, string> = {
  prescription: "Prescription", blood: "Blood", radiology: "Radiology", pathology: "Pathology", discharge: "Discharge", other: "Other",
};

export function documentTypeLabel(type: string): string {
  return LABELS[type] ?? type;
}
