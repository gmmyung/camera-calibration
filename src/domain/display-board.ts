import type { DictionaryName, PatternConfig } from "./types";

export const MAX_DISPLAY_BOARD_EDGE = 32_768;

const MIN_SQUARE_PIXELS = 8;
const MAX_SQUARE_PIXELS = 8_192;
const HORIZONTAL_PADDING_CSS = 24;
const VERTICAL_PADDING_CSS = 72;
const CHARUCO_MARKER_NUMERATOR = 7;
const CHARUCO_MARKER_DENOMINATOR = 10;

export interface DisplayViewport {
  widthCss: number;
  heightCss: number;
  devicePixelRatio: number;
}

export interface DisplayBoardGeometry {
  squarePixels: number;
  markerPixels?: number;
  boardWidthPixels: number;
  boardHeightPixels: number;
  boardWidthCss: number;
  boardHeightCss: number;
}

export function dictionaryModuleCount(dictionary: DictionaryName): number {
  if (dictionary === "DICT_ARUCO_ORIGINAL") return 7;
  const bits = Number(dictionary.match(/^DICT_(\d)X\d_/)?.[1]);
  if (!Number.isInteger(bits) || bits < 4 || bits > 7) {
    throw new Error("Unsupported marker dictionary.");
  }
  return bits + 2;
}

export function boardGridDimensions(pattern: PatternConfig): {
  squaresX: number;
  squaresY: number;
} {
  return pattern.kind === "charuco"
    ? { squaresX: pattern.squaresX, squaresY: pattern.squaresY }
    : { squaresX: pattern.innerCornersX + 1, squaresY: pattern.innerCornersY + 1 };
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function charucoSquareStep(dictionary: DictionaryName): number {
  const modules = dictionaryModuleCount(dictionary);
  const product = CHARUCO_MARKER_DENOMINATOR * modules;
  return product / greatestCommonDivisor(CHARUCO_MARKER_NUMERATOR, product);
}

function charucoMarkerPixels(squarePixels: number, dictionary: DictionaryName): number {
  const markerPixels = squarePixels * CHARUCO_MARKER_NUMERATOR / CHARUCO_MARKER_DENOMINATOR;
  if (!Number.isInteger(markerPixels) || markerPixels % dictionaryModuleCount(dictionary) !== 0) {
    throw new Error("The window is too small to render this marker dictionary.");
  }
  return markerPixels;
}

export function displayBoardGeometry(
  pattern: PatternConfig,
  viewport: DisplayViewport,
): DisplayBoardGeometry {
  const { squaresX, squaresY } = boardGridDimensions(pattern);
  const ratio = Number.isFinite(viewport.devicePixelRatio) && viewport.devicePixelRatio > 0
    ? viewport.devicePixelRatio
    : 1;
  const availableWidth = Math.floor((viewport.widthCss - HORIZONTAL_PADDING_CSS) * ratio);
  const availableHeight = Math.floor((viewport.heightCss - VERTICAL_PADDING_CSS) * ratio);
  const edgeLimitedSquare = Math.min(
    Math.floor(MAX_DISPLAY_BOARD_EDGE / squaresX),
    Math.floor(MAX_DISPLAY_BOARD_EDGE / squaresY),
  );
  let squarePixels = Math.min(
    MAX_SQUARE_PIXELS,
    edgeLimitedSquare,
    Math.floor(availableWidth / squaresX),
    Math.floor(availableHeight / squaresY),
  );
  if (pattern.kind === "charuco") {
    const step = charucoSquareStep(pattern.dictionary);
    squarePixels = Math.floor(squarePixels / step) * step;
  }
  if (!Number.isFinite(squarePixels) || squarePixels < MIN_SQUARE_PIXELS) {
    throw new Error("The window is too small to display this board.");
  }

  const boardWidthPixels = squaresX * squarePixels;
  const boardHeightPixels = squaresY * squarePixels;
  return {
    squarePixels,
    markerPixels: pattern.kind === "charuco"
      ? charucoMarkerPixels(squarePixels, pattern.dictionary)
      : undefined,
    boardWidthPixels,
    boardHeightPixels,
    boardWidthCss: boardWidthPixels / ratio,
    boardHeightCss: boardHeightPixels / ratio,
  };
}
