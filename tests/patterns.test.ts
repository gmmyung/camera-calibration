import { describe, expect, it } from "vitest";
import {
  CHARUCO_PRESET,
  CHESSBOARD_PRESET,
  availableCornerCount,
  validatePattern,
} from "../src/domain/patterns";

describe("pattern definitions", () => {
  it("reports the correct number of available corners", () => {
    expect(availableCornerCount(CHARUCO_PRESET)).toBe(24);
    expect(availableCornerCount(CHESSBOARD_PRESET)).toBe(54);
  });

  it("accepts the supplied presets", () => {
    expect(validatePattern(CHARUCO_PRESET)).toEqual([]);
    expect(validatePattern(CHESSBOARD_PRESET)).toEqual([]);
  });

  it("rejects impossible marker geometry", () => {
    expect(
      validatePattern({
        ...CHARUCO_PRESET,
        markerLengthMm: CHARUCO_PRESET.kind === "charuco" ? 30 : 0,
      }),
    ).toContain("Marker length must be positive and smaller than the square length.");
  });
});
