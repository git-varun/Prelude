const THYROGLOBULIN = "Thyroglobulin (Tg)";
const ANTI_TG = "Anti-Tg (TgAb)";

// Thyroglobulin always displays alongside Anti-Tg when both are tracked
// (Decisions Log, clinical input) — moves Anti-Tg to immediately after
// Thyroglobulin, leaving every other field's relative order untouched.
export function withThyroglobulinAdjacency<T extends { marker_name: string | null }>(fields: T[]): T[] {
  const tgIndex = fields.findIndex((f) => f.marker_name === THYROGLOBULIN);
  const antiTgIndex = fields.findIndex((f) => f.marker_name === ANTI_TG);
  if (tgIndex === -1 || antiTgIndex === -1 || antiTgIndex === tgIndex + 1) {
    return fields;
  }

  const result = fields.filter((_, i) => i !== antiTgIndex);
  const insertAt = result.indexOf(fields[tgIndex]!) + 1;
  result.splice(insertAt, 0, fields[antiTgIndex]!);
  return result;
}
