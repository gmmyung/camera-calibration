import type { CharucoPatternConfig, ChessboardPatternConfig, PatternConfig } from "./types";

export const CHARUCO_PRESET: CharucoPatternConfig = {
  kind: "charuco",
  squaresX: 5,
  squaresY: 7,
  squareLengthMm: 30,
  markerLengthMm: 21,
  dictionary: "DICT_5X5_100",
  legacyPattern: false,
};

export const CHESSBOARD_PRESET: ChessboardPatternConfig = {
  kind: "chessboard",
  innerCornersX: 9,
  innerCornersY: 6,
  squareLengthMm: 24,
};

export function availableCornerCount(pattern: PatternConfig): number {
  if (pattern.kind === "charuco") {
    return Math.max(0, (pattern.squaresX - 1) * (pattern.squaresY - 1));
  }
  return pattern.innerCornersX * pattern.innerCornersY;
}

export function patternLabel(pattern: PatternConfig): string {
  return pattern.kind === "charuco"
    ? `ChArUco ${pattern.squaresX}×${pattern.squaresY}`
    : `Chessboard ${pattern.innerCornersX}×${pattern.innerCornersY}`;
}

export function validatePattern(pattern: PatternConfig): string[] {
  const errors: string[] = [];
  if (pattern.squareLengthMm <= 0 || !Number.isFinite(pattern.squareLengthMm)) {
    errors.push("Square length must be greater than zero.");
  }
  if (pattern.kind === "charuco") {
    if (pattern.squaresX < 3 || pattern.squaresY < 3) {
      errors.push("A ChArUco board needs at least 3×3 squares.");
    }
    if (pattern.markerLengthMm <= 0 || pattern.markerLengthMm >= pattern.squareLengthMm) {
      errors.push("Marker length must be positive and smaller than the square length.");
    }
  } else if (pattern.innerCornersX < 3 || pattern.innerCornersY < 3) {
    errors.push("A chessboard needs at least 3×3 inner corners.");
  }
  return errors;
}

export function clonePattern(pattern: PatternConfig): PatternConfig {
  return { ...pattern };
}
