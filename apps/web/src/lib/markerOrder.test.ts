import { test, expect } from "bun:test";
import { withThyroglobulinAdjacency } from "./markerOrder";

function field(markerName: string | null) {
  return { marker_name: markerName } as { marker_name: string | null };
}

test("moves Anti-Tg to immediately after Thyroglobulin when both are tracked", () => {
  const fields = [field("CEA"), field("Anti-Tg (TgAb)"), field("Calcitonin"), field("Thyroglobulin (Tg)")];
  const result = withThyroglobulinAdjacency(fields);
  const names = result.map((f) => f.marker_name);
  const tgIndex = names.indexOf("Thyroglobulin (Tg)");
  expect(names[tgIndex + 1]).toBe("Anti-Tg (TgAb)");
});

test("leaves order unchanged when only one of the pair is tracked", () => {
  const fields = [field("CEA"), field("Thyroglobulin (Tg)"), field("Calcitonin")];
  expect(withThyroglobulinAdjacency(fields)).toEqual(fields);
});

test("leaves order unchanged when neither is tracked", () => {
  const fields = [field("CEA"), field("CA 19-9")];
  expect(withThyroglobulinAdjacency(fields)).toEqual(fields);
});

test("preserves every other field and does not drop or duplicate entries", () => {
  const fields = [field("Anti-Tg (TgAb)"), field("CEA"), field("Thyroglobulin (Tg)"), field("Calcitonin")];
  const result = withThyroglobulinAdjacency(fields);
  expect(result).toHaveLength(fields.length);
  expect(result.map((f) => f.marker_name).sort()).toEqual(fields.map((f) => f.marker_name).sort());
});
