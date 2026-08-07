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

  it("rejects fractional, non-finite, and oversized dimensions", () => {
    expect(validatePattern({ ...CHESSBOARD_PRESET, innerCornersX: 3.5 })).not.toEqual([]);
    expect(validatePattern({ ...CHESSBOARD_PRESET, innerCornersY: Number.NaN })).not.toEqual([]);
    expect(validatePattern({ ...CHARUCO_PRESET, squaresX: 31 })).not.toEqual([]);
    expect(validatePattern({ ...CHARUCO_PRESET, squareLengthMm: Number.POSITIVE_INFINITY })).not.toEqual(
      [],
    );
  });

  it("rejects boards with more markers than the dictionary contains", () => {
    expect(
      validatePattern({
        ...CHARUCO_PRESET,
        squaresX: 11,
        squaresY: 10,
        dictionary: "DICT_5X5_50",
      }),
    ).toContain("DICT_5X5_50 contains too few markers for this board (55 required).");
  });
});
