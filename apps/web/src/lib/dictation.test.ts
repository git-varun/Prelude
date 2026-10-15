import { test, expect } from "bun:test";
import { formatDuration, microphoneMessage } from "./dictation";

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
