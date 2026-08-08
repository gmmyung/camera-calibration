import type { DictionaryName, PatternConfig } from "./types";

export const DISPLAY_PROFILE_SCHEMA_VERSION = 1;
export const MAX_DISPLAY_PROFILES = 32;
export const MAX_DISPLAY_PATTERN_EDGE = 32_768;

export type DisplaySizeSource = "diagonal" | "active-area";

export interface DisplaySpecification {
  nativeWidthPixels: number;
  nativeHeightPixels: number;
  sizeSource: DisplaySizeSource;
  diagonalInches?: number;
  activeWidthMm?: number;
  activeHeightMm?: number;
}

export interface DisplayEnvironment {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface DisplayVerification {
  measuredLengthMm: number;
  renderedLengthPixels: number;
  mmPerPixel: number;
  environmentKey: string;
  verifiedAt: string;
}

export interface DisplayProfile {
  schemaVersion: typeof DISPLAY_PROFILE_SCHEMA_VERSION;
  id: string;
  name: string;
  specification: DisplaySpecification;
  verification?: DisplayVerification;
}

export interface DisplayScale {
  mmPerPixel: number;
  source: "verified" | "estimated";
  verificationCurrent: boolean;
}

export interface DisplayTargetGeometry {
  pattern: PatternConfig;
  squarePixels: number;
  markerPixels?: number;
  boardWidthPixels: number;
  boardHeightPixels: number;
  boardWidthMm: number;
  boardHeightMm: number;
}

export interface DisplaySpecificationPreset {
  id: string;
  label: string;
  specification: DisplaySpecification;
}

export const DISPLAY_SPECIFICATION_PRESETS: readonly DisplaySpecificationPreset[] = [
  { id: "13.3-1920x1080", label: "13.3 in · 1920 × 1080", specification: { nativeWidthPixels: 1920, nativeHeightPixels: 1080, sizeSource: "diagonal", diagonalInches: 13.3 } },
  { id: "13.3-2560x1600", label: "13.3 in · 2560 × 1600", specification: { nativeWidthPixels: 2560, nativeHeightPixels: 1600, sizeSource: "diagonal", diagonalInches: 13.3 } },
  { id: "14-1920x1200", label: "14 in · 1920 × 1200", specification: { nativeWidthPixels: 1920, nativeHeightPixels: 1200, sizeSource: "diagonal", diagonalInches: 14 } },
  { id: "14-2880x1800", label: "14 in · 2880 × 1800", specification: { nativeWidthPixels: 2880, nativeHeightPixels: 1800, sizeSource: "diagonal", diagonalInches: 14 } },
  { id: "15.6-1920x1080", label: "15.6 in · 1920 × 1080", specification: { nativeWidthPixels: 1920, nativeHeightPixels: 1080, sizeSource: "diagonal", diagonalInches: 15.6 } },
  { id: "16-2560x1600", label: "16 in · 2560 × 1600", specification: { nativeWidthPixels: 2560, nativeHeightPixels: 1600, sizeSource: "diagonal", diagonalInches: 16 } },
  { id: "24-1920x1080", label: "24 in · 1920 × 1080", specification: { nativeWidthPixels: 1920, nativeHeightPixels: 1080, sizeSource: "diagonal", diagonalInches: 24 } },
  { id: "27-2560x1440", label: "27 in · 2560 × 1440", specification: { nativeWidthPixels: 2560, nativeHeightPixels: 1440, sizeSource: "diagonal", diagonalInches: 27 } },
  { id: "27-3840x2160", label: "27 in · 3840 × 2160", specification: { nativeWidthPixels: 3840, nativeHeightPixels: 2160, sizeSource: "diagonal", diagonalInches: 27 } },
  { id: "32-3840x2160", label: "32 in · 3840 × 2160", specification: { nativeWidthPixels: 3840, nativeHeightPixels: 2160, sizeSource: "diagonal", diagonalInches: 32 } },
] as const;

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function displayEnvironment(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): DisplayEnvironment {
  const safeWidth = finiteInRange(cssWidth, 1, MAX_DISPLAY_PATTERN_EDGE) ? cssWidth : 1;
  const safeHeight = finiteInRange(cssHeight, 1, MAX_DISPLAY_PATTERN_EDGE) ? cssHeight : 1;
  const safeRatio = finiteInRange(devicePixelRatio, 0.1, 16) ? devicePixelRatio : 1;
  return {
    cssWidth: safeWidth,
    cssHeight: safeHeight,
    devicePixelRatio: safeRatio,
    pixelWidth: Math.max(1, Math.round(safeWidth * safeRatio)),
    pixelHeight: Math.max(1, Math.round(safeHeight * safeRatio)),
  };
}

export function displayEnvironmentKey(environment: DisplayEnvironment): string {
  return `${environment.pixelWidth}x${environment.pixelHeight}@${environment.devicePixelRatio.toFixed(4)}`;
}

export function validateDisplaySpecification(specification: DisplaySpecification): string[] {
  const errors: string[] = [];
  if (
    !Number.isInteger(specification.nativeWidthPixels) ||
    !Number.isInteger(specification.nativeHeightPixels) ||
    specification.nativeWidthPixels < 320 ||
    specification.nativeHeightPixels < 200 ||
    specification.nativeWidthPixels > MAX_DISPLAY_PATTERN_EDGE ||
    specification.nativeHeightPixels > MAX_DISPLAY_PATTERN_EDGE
  ) {
    errors.push("Native resolution must contain valid whole-pixel dimensions.");
  }
  if (specification.sizeSource === "diagonal") {
    if (!finiteInRange(specification.diagonalInches, 2, 300)) {
      errors.push("Display diagonal must be between 2 and 300 inches.");
    }
  } else if (
    !finiteInRange(specification.activeWidthMm, 10, 10_000) ||
    !finiteInRange(specification.activeHeightMm, 10, 10_000)
  ) {
    errors.push("Enter the active panel width and height in millimetres.");
  } else {
    const pixelAspect = specification.nativeWidthPixels / specification.nativeHeightPixels;
    const physicalAspect = specification.activeWidthMm / specification.activeHeightMm;
    if (
      Number.isFinite(pixelAspect) &&
      Number.isFinite(physicalAspect) &&
      Math.abs(pixelAspect / physicalAspect - 1) > 0.02
    ) {
      errors.push("Active panel dimensions do not match the native-resolution aspect ratio.");
    }
  }
  return errors;
}

export function estimatedMmPerPixel(specification: DisplaySpecification): number {
  const errors = validateDisplaySpecification(specification);
  if (errors.length > 0) throw new Error(errors[0]);
  const pixelDiagonal = Math.hypot(
    specification.nativeWidthPixels,
    specification.nativeHeightPixels,
  );
  const physicalDiagonalMm = specification.sizeSource === "active-area"
    ? Math.hypot(specification.activeWidthMm!, specification.activeHeightMm!)
    : specification.diagonalInches! * 25.4;
  return physicalDiagonalMm / pixelDiagonal;
}

export function displayProfileScale(
  profile: DisplayProfile,
  environment: DisplayEnvironment,
): DisplayScale {
  const currentKey = displayEnvironmentKey(environment);
  if (
    profile.verification &&
    profile.verification.environmentKey === currentKey &&
    finiteInRange(profile.verification.mmPerPixel, 0.001, 10)
  ) {
    return {
      mmPerPixel: profile.verification.mmPerPixel,
      source: "verified",
      verificationCurrent: true,
    };
  }
  return {
    mmPerPixel: estimatedMmPerPixel(profile.specification),
    source: "estimated",
    verificationCurrent: !profile.verification,
  };
}

export function displayRasterMatchesSpecification(
  environment: DisplayEnvironment,
  specification: DisplaySpecification,
): boolean {
  const direct =
    environment.pixelWidth === specification.nativeWidthPixels &&
    environment.pixelHeight === specification.nativeHeightPixels;
  const rotated =
    environment.pixelWidth === specification.nativeHeightPixels &&
    environment.pixelHeight === specification.nativeWidthPixels;
  return direct || rotated;
}

export function dictionaryModuleCount(dictionary: DictionaryName): number {
  if (dictionary === "DICT_ARUCO_ORIGINAL") return 7;
  const bits = Number(dictionary.match(/^DICT_(\d)X\d_/)?.[1]);
  if (!Number.isInteger(bits) || bits < 4 || bits > 7) {
    throw new Error("Unsupported marker dictionary.");
  }
  return bits + 2;
}

function roundedMm(value: number): number {
  return Number(value.toFixed(6));
}

function bestCharucoPixels(
  pattern: Extract<PatternConfig, { kind: "charuco" }>,
  mmPerPixel: number,
): { squarePixels: number; markerPixels: number } {
  const modules = dictionaryModuleCount(pattern.dictionary);
  const targetSquare = pattern.squareLengthMm / mmPerPixel;
  const targetMarker = pattern.markerLengthMm / mmPerPixel;
  const ratio = pattern.markerLengthMm / pattern.squareLengthMm;
  const targetModule = targetMarker / modules;
  let best: { squarePixels: number; markerPixels: number; score: number } | undefined;
  const firstModule = Math.max(2, Math.floor(targetModule) - 64);
  const lastModule = Math.max(firstModule, Math.ceil(targetModule) + 64);
  for (let modulePixels = firstModule; modulePixels <= lastModule; modulePixels += 1) {
    const markerPixels = modulePixels * modules;
    const squareCandidates = new Set([
      Math.floor(targetSquare),
      Math.round(targetSquare),
      Math.ceil(targetSquare),
      Math.floor(markerPixels / ratio),
      Math.round(markerPixels / ratio),
      Math.ceil(markerPixels / ratio),
    ]);
    for (const squarePixels of squareCandidates) {
      if (squarePixels <= markerPixels || squarePixels < 8) continue;
      const squareError = Math.abs(squarePixels - targetSquare) / targetSquare;
      const markerError = Math.abs(markerPixels - targetMarker) / targetMarker;
      const centeringPenalty = (squarePixels - markerPixels) % 2 === 0 ? 0 : 0.00001;
      const score = squareError + markerError + centeringPenalty;
      if (!best || score < best.score) best = { squarePixels, markerPixels, score };
    }
  }
  if (!best) throw new Error("The requested marker geometry cannot be rendered on this display.");
  return best;
}

export function displayTargetGeometry(
  pattern: PatternConfig,
  mmPerPixel: number,
): DisplayTargetGeometry {
  if (!finiteInRange(mmPerPixel, 0.001, 10)) {
    throw new Error("Display scale is invalid.");
  }
  let squarePixels: number;
  let markerPixels: number | undefined;
  let adjustedPattern: PatternConfig;
  let squaresX: number;
  let squaresY: number;
  if (pattern.kind === "charuco") {
    ({ squarePixels, markerPixels } = bestCharucoPixels(pattern, mmPerPixel));
    adjustedPattern = {
      ...pattern,
      squareLengthMm: roundedMm(squarePixels * mmPerPixel),
      markerLengthMm: roundedMm(markerPixels * mmPerPixel),
    };
    squaresX = pattern.squaresX;
    squaresY = pattern.squaresY;
  } else {
    squarePixels = Math.max(8, Math.round(pattern.squareLengthMm / mmPerPixel));
    adjustedPattern = {
      ...pattern,
      squareLengthMm: roundedMm(squarePixels * mmPerPixel),
    };
    squaresX = pattern.innerCornersX + 1;
    squaresY = pattern.innerCornersY + 1;
  }
  const boardWidthPixels = squaresX * squarePixels;
  const boardHeightPixels = squaresY * squarePixels;
  if (
    boardWidthPixels > MAX_DISPLAY_PATTERN_EDGE ||
    boardHeightPixels > MAX_DISPLAY_PATTERN_EDGE
  ) {
    throw new Error(`The rendered board exceeds the ${MAX_DISPLAY_PATTERN_EDGE}-pixel limit.`);
  }
  return {
    pattern: adjustedPattern,
    squarePixels,
    markerPixels,
    boardWidthPixels,
    boardHeightPixels,
    boardWidthMm: roundedMm(boardWidthPixels * mmPerPixel),
    boardHeightMm: roundedMm(boardHeightPixels * mmPerPixel),
  };
}

export function isDisplayProfile(value: unknown): value is DisplayProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<DisplayProfile>;
  if (
    profile.schemaVersion !== DISPLAY_PROFILE_SCHEMA_VERSION ||
    typeof profile.id !== "string" ||
    profile.id.length < 1 ||
    profile.id.length > 200 ||
    typeof profile.name !== "string" ||
    profile.name.trim().length < 1 ||
    profile.name.length > 100 ||
    !profile.specification ||
    validateDisplaySpecification(profile.specification).length > 0
  ) {
    return false;
  }
  if (!profile.verification) return true;
  return (
    finiteInRange(profile.verification.measuredLengthMm, 1, 10_000) &&
    finiteInRange(profile.verification.renderedLengthPixels, 1, MAX_DISPLAY_PATTERN_EDGE) &&
    finiteInRange(profile.verification.mmPerPixel, 0.001, 10) &&
    typeof profile.verification.environmentKey === "string" &&
    profile.verification.environmentKey.length > 0 &&
    profile.verification.environmentKey.length <= 100 &&
    typeof profile.verification.verifiedAt === "string" &&
    Number.isFinite(Date.parse(profile.verification.verifiedAt))
  );
}
