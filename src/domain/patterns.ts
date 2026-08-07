import type {
  CharucoPatternConfig,
  ChessboardPatternConfig,
  DictionaryName,
  PatternConfig,
} from "./types";

export const MIN_PATTERN_GRID_SIZE = 3;
export const MAX_PATTERN_GRID_SIZE = 30;
export const MAX_PATTERN_LENGTH_MM = 10_000;

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

export function charucoMarkerCount(pattern: CharucoPatternConfig): number {
  return Math.floor((pattern.squaresX * pattern.squaresY) / 2);
}

export function dictionaryMarkerCapacity(dictionary: DictionaryName): number {
  if (dictionary === "DICT_ARUCO_ORIGINAL") return 1_024;
  const suffix = dictionary.match(/_(50|100|250|1000)$/)?.[1];
  return suffix ? Number(suffix) : 0;
}

export function patternLabel(pattern: PatternConfig): string {
  return pattern.kind === "charuco"
    ? `ChArUco ${pattern.squaresX}×${pattern.squaresY}`
    : `Chessboard ${pattern.innerCornersX}×${pattern.innerCornersY}`;
}

export function validatePattern(pattern: PatternConfig): string[] {
  const errors: string[] = [];
  if (
    !Number.isFinite(pattern.squareLengthMm) ||
    pattern.squareLengthMm <= 0 ||
    pattern.squareLengthMm > MAX_PATTERN_LENGTH_MM
  ) {
    errors.push(`Square length must be between 0 and ${MAX_PATTERN_LENGTH_MM} mm.`);
  }
  if (pattern.kind === "charuco") {
    if (
      !Number.isInteger(pattern.squaresX) ||
      !Number.isInteger(pattern.squaresY) ||
      pattern.squaresX < MIN_PATTERN_GRID_SIZE ||
      pattern.squaresY < MIN_PATTERN_GRID_SIZE ||
      pattern.squaresX > MAX_PATTERN_GRID_SIZE ||
      pattern.squaresY > MAX_PATTERN_GRID_SIZE
    ) {
      errors.push(
        `ChArUco dimensions must be whole numbers from ${MIN_PATTERN_GRID_SIZE} to ${MAX_PATTERN_GRID_SIZE}.`,
      );
    }
    if (
      !Number.isFinite(pattern.markerLengthMm) ||
      pattern.markerLengthMm <= 0 ||
      pattern.markerLengthMm > MAX_PATTERN_LENGTH_MM ||
      pattern.markerLengthMm >= pattern.squareLengthMm
    ) {
      errors.push("Marker length must be positive and smaller than the square length.");
    }
    if (
      Number.isInteger(pattern.squaresX) &&
      Number.isInteger(pattern.squaresY) &&
      charucoMarkerCount(pattern) > dictionaryMarkerCapacity(pattern.dictionary)
    ) {
      errors.push(
        `${pattern.dictionary} contains too few markers for this board (${charucoMarkerCount(pattern)} required).`,
      );
    }
  } else if (
    !Number.isInteger(pattern.innerCornersX) ||
    !Number.isInteger(pattern.innerCornersY) ||
    pattern.innerCornersX < MIN_PATTERN_GRID_SIZE ||
    pattern.innerCornersY < MIN_PATTERN_GRID_SIZE ||
    pattern.innerCornersX > MAX_PATTERN_GRID_SIZE ||
    pattern.innerCornersY > MAX_PATTERN_GRID_SIZE
  ) {
    errors.push(
      `Chessboard dimensions must be whole numbers from ${MIN_PATTERN_GRID_SIZE} to ${MAX_PATTERN_GRID_SIZE}.`,
    );
  }
  return errors;
}

export function clonePattern(pattern: PatternConfig): PatternConfig {
  return { ...pattern };
}
