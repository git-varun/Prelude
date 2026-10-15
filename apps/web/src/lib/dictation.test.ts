import { test, expect } from "bun:test";
import { formatDuration, microphoneMessage, reachedSizeLimit, DICTATION_SOFT_LIMIT_BYTES, DICTATION_BITS_PER_SECOND, MAX_DICTATION_SECONDS } from "./dictation";

test("formatDuration is m:ss", () => {
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(5)).toBe("0:05");
  expect(formatDuration(75)).toBe("1:15");
  expect(formatDuration(600)).toBe("10:00");
  expect(formatDuration(1800)).toBe("30:00");
  expect(formatDuration(59.9)).toBe("0:59");
  expect(formatDuration(-3)).toBe("0:00");
});

test("microphoneMessage names the cause in plain words", () => {
  expect(microphoneMessage({ name: "NotAllowedError" })).toContain("denied");
  expect(microphoneMessage({ name: "NotFoundError" })).toContain("No microphone");
  expect(microphoneMessage(new Error("x"))).toContain("could not be started");
});

test("reachedSizeLimit trips at the soft limit, below the 25 MB server cap", () => {
  expect(reachedSizeLimit(0)).toBe(false);
  expect(reachedSizeLimit(DICTATION_SOFT_LIMIT_BYTES - 1)).toBe(false);
  expect(reachedSizeLimit(DICTATION_SOFT_LIMIT_BYTES)).toBe(true);
  expect(DICTATION_SOFT_LIMIT_BYTES).toBeLessThan(25 * 1024 * 1024);
  expect(reachedSizeLimit(5, 4)).toBe(true);
});

test("a full 30-minute take at the chosen bitrate stays under the soft limit", () => {
  expect((DICTATION_BITS_PER_SECOND / 8) * MAX_DICTATION_SECONDS).toBeLessThan(DICTATION_SOFT_LIMIT_BYTES);
});
