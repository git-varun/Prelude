// Groups of printed labels that name the same test across labs. Compared after
// squashing (lowercase alphanumerics only). Free T3/T4 and total T3/T4 are
// deliberately separate groups: they are different tests.
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const GROUPS: string[][] = [
  ["Haemoglobin", "Hemoglobin", "Haemoglobin (Hb)", "Hb", "Hgb", "HAEMOGLOBIN (Hb)"],
  ["RBC", "RBC Count", "Red Blood Cells", "RED BLOOD CELLS- RBC COUNT", "Red Cell Count"],
  ["PCV", "Hematocrit", "HCT", "PACKED CELL VOLUME (PCV)", "PACKED CELL VOLUME (PCV) - HEMATOCRIT"],
  ["WBC", "TLC", "Total Leucocyte Count", "TOTAL LEUKOCYTE COUNT (TLC)", "White Blood Cells", "WBC Count"],
  ["Platelets", "Platelet Count", "PLT"],
  ["Neutrophils", "Neutrophils %", "Neutrophil %", "Neutrophils (%)"],
  ["Lymphocytes", "Lymphocytes %", "Lymphocyte %", "Lymphocytes (%)"],
  ["Monocytes", "Monocytes %", "Monocyte %", "Monocytes (%)"],
  ["Eosinophils", "Eosinophils %", "Eosinophil %", "Eosinophils (%)"],
  ["Basophils", "Basophils %", "Basophil %", "Basophils (%)"],
  ["SGPT (ALT)", "SGPT", "ALT", "Alanine Aminotransferase"],
  ["SGOT (AST)", "SGOT", "AST", "Aspartate Aminotransferase"],
  ["ALKALINE PHOSPHATASE", "ALP", "Alk Phos"],
  ["GAMMA GLUTAMYL TRANSFERASE (GGT)", "GGT", "Gamma GT"],
  ["BILIRUBIN TOTAL", "Total Bilirubin", "Bilirubin, Total", "T. Bilirubin"],
  ["BILIRUBIN (Direct)", "Direct Bilirubin", "Bilirubin, Direct", "D. Bilirubin"],
  ["CREATININE", "Serum Creatinine", "CREATININE-SERUM", "S. Creatinine"],
  ["UREA", "Serum Urea", "Blood Urea", "UREA - SERUM"],
  ["BLOOD UREA NITROGEN (BUN)", "BUN"],
  ["URIC ACID", "Serum Uric Acid", "URIC ACID - SERUM"],
  ["CALCIUM", "Serum Calcium", "CALCIUM , Serum"],
  ["SODIUM", "Serum Sodium", "SODIUM (SERUM)", "Na"],
  ["POTASSIUM", "Serum Potassium", "POTASSIUM-SERUM", "K"],
  ["BLOOD GLUCOSE FASTING", "Fasting Glucose", "Glucose Fasting", "FBS", "Fasting Blood Sugar"],
  ["Hb A1C", "HbA1c", "Glycosylated Hemoglobin", "Hb A1C, GLYCOSYLATED Hb", "Glycated Hemoglobin"],
  ["ESR", "ESR [WESTERGREN]", "Erythrocyte Sedimentation Rate"],
  ["CHOLESTEROL TOTAL", "Total Cholesterol", "Cholesterol, Total"],
  ["CHOLESTEROL - HDL (DIRECT)", "HDL Cholesterol", "HDL"],
  ["CHOLESTEROL-LDL (DIRECT)", "LDL Cholesterol", "LDL"],
  ["TRIGLYCERIDES", "Triglyceride", "TG"],
  ["VITAMIN B12", "Vit B12", "Cyanocobalamin"],
  ["VITAMIN D(25 OH)", "Vitamin D", "25-OH Vitamin D", "Vitamin D 25-Hydroxy"],
  ["APTT", "aPTT", "Activated Partial Thromboplastin Time", "APTT Test"],
  ["PROTHROMBIN TIME", "PT", "PT Test", "Prothrombin Time (PT)"],
  ["INR", "INR (Ratio)"],
  // Thyroid: total and free are different tests.
  ["T3 Total", "T3, Total", "TRIODOTHYRONINE TOTAL (T3)", "Triiodothyronine Total (T3)", "Total T3", "T3"],
  ["T4 Total", "T4, Total", "THYROXINE TOTAL (T4)", "Total T4", "T4"],
  ["Free T3", "FT3", "Free Triiodothyronine (FT3)", "FREE TRIIODOTHYRONINE (FT3)"],
  ["Free T4", "FT4", "Free Thyroxine (FT4)", "FREE THYROXINE (FT4)"],
  ["TSH", "Thyroid Stimulating Hormone", "THYROID STIMULATING HORMONE (TSH)", "TSH (Ultra Sensitive)", "TSH - Ultrasensitive", "Thyroid Stimulating Hormone - Ultrasensitive", "TSH Ultrasensitive"],
  ["TACROLIMUS", "Tacrolimus Level", "TACROLIMUS - DRUG", "FK506"],
];

const SQUASHED = GROUPS.map((g) => new Set(g.map(squash)));

// Every squashed label that names the same test as `label` (empty if unknown).
export function aliasKeys(label: string | null | undefined, extra: readonly string[] = []): Set<string> {
  const keys = new Set(extra.map(squash));
  if (!label) return keys;
  const key = squash(label);
  if (key) keys.add(key);
  for (const g of SQUASHED) if (g.has(key)) for (const k of g) keys.add(k);
  return keys;
}
