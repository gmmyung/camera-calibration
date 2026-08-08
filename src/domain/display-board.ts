import { validatePattern } from "./patterns";
import {
  DICTIONARY_NAMES,
  type DictionaryName,
  type PatternConfig,
} from "./types";

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

export function displayBoardUrl(pattern: PatternConfig, baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", "board");
  url.searchParams.set("type", pattern.kind);
  if (pattern.kind === "charuco") {
    url.searchParams.set("columns", String(pattern.squaresX));
    url.searchParams.set("rows", String(pattern.squaresY));
    url.searchParams.set("dictionary", pattern.dictionary);
    url.searchParams.set("legacy", pattern.legacyPattern ? "1" : "0");
  } else {
    url.searchParams.set("columns", String(pattern.innerCornersX));
    url.searchParams.set("rows", String(pattern.innerCornersY));
  }
  return url.href;
}

function wholeNumberParameter(parameters: URLSearchParams, name: string): number {
  const text = parameters.get(name);
  const value = text === null ? Number.NaN : Number(text);
  if (!Number.isInteger(value)) throw new Error("Invalid display board link.");
  return value;
}

export function patternFromDisplayBoardUrl(url: URL): PatternConfig {
  if (url.searchParams.get("view") !== "board") {
    throw new Error("Not a display board link.");
  }
  const kind = url.searchParams.get("type");
  const columns = wholeNumberParameter(url.searchParams, "columns");
  const rows = wholeNumberParameter(url.searchParams, "rows");
  let pattern: PatternConfig;
  if (kind === "charuco") {
    const dictionary = url.searchParams.get("dictionary");
    const legacy = url.searchParams.get("legacy");
    if (
      !dictionary ||
      !DICTIONARY_NAMES.includes(dictionary as DictionaryName) ||
      (legacy !== "0" && legacy !== "1")
    ) {
      throw new Error("Invalid display board link.");
    }
    pattern = {
      kind,
      squaresX: columns,
      squaresY: rows,
      dictionary: dictionary as DictionaryName,
      legacyPattern: legacy === "1",
    };
  } else if (kind === "chessboard") {
    pattern = {
      kind,
      innerCornersX: columns,
      innerCornersY: rows,
    };
  } else {
    throw new Error("Invalid display board link.");
  }
  if (validatePattern(pattern).length > 0) throw new Error("Invalid display board link.");
  return pattern;
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
