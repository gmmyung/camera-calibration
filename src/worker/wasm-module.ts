import type {
  CalibrationResultV1,
  DetectionResult,
  FrameObservation,
  ImageSize,
  LensModel,
  PatternConfig,
} from "../domain/types";

export interface NativeCalibrationResult {
  ok: boolean;
  error?: string;
  opencvVersion: string;
  cameraMatrix: number[];
  distortion: number[];
  rmsReprojectionError: number;
  perViewErrors: Record<string, number>;
  includedViewIds: string[];
  excludedViewIds: string[];
  poses: CalibrationResultV1["poses"];
}

export interface NativeUndistortedFrame {
  ok: boolean;
  error?: string;
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface CalibrationWasmModule {
  getExceptionMessage(error: unknown): readonly string[];
  decrementExceptionRefcount(error: unknown): void;
  getOpenCvVersion(): string;
  detectFrame(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    pattern: PatternConfig,
  ): DetectionResult;
  solveCalibration(
    observations: FrameObservation[],
    model: LensModel,
    width: number,
    height: number,
  ): NativeCalibrationResult;
  undistortFrame(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    calibration: CalibrationResultV1,
  ): NativeUndistortedFrame;
  generatePatternSvg(pattern: PatternConfig): string;
}

type CalibrationModuleFactory = (options: {
  locateFile: (path: string) => string;
  noInitialRun: boolean;
}) => Promise<CalibrationWasmModule>;

export async function loadCalibrationModule(moduleUrl: string): Promise<CalibrationWasmModule> {
  const imported = (await import(/* @vite-ignore */ moduleUrl)) as {
    default?: CalibrationModuleFactory;
  };
  if (typeof imported.default !== "function") {
    throw new Error("The generated OpenCV module has no default factory export.");
  }
  return imported.default({
    noInitialRun: true,
    locateFile: (path) => new URL(path, moduleUrl).href,
  });
}

export function calibrationResultFromNative(
  native: NativeCalibrationResult,
  model: LensModel,
  pattern: PatternConfig,
  imageSize: ImageSize,
  observations: FrameObservation[],
  captureSettings?: CalibrationResultV1["captureSettings"],
): CalibrationResultV1 {
  if (!native.ok) throw new Error(native.error || "OpenCV could not solve this calibration.");
  if (native.cameraMatrix.length !== 9) throw new Error("OpenCV returned an invalid camera matrix.");
  const expectedCoefficients = model === "pinhole-radtan5" ? 5 : 4;
  if (native.distortion.length !== expectedCoefficients) {
    throw new Error(`OpenCV returned ${native.distortion.length} distortion coefficients.`);
  }
  const included = new Set(native.includedViewIds);
  return {
    schemaVersion: 1,
    generator: {
      appVersion: __APP_VERSION__,
      opencvVersion: native.opencvVersion,
    },
    createdAt: new Date().toISOString(),
    model,
    imageSize,
    cameraMatrix: native.cameraMatrix as CalibrationResultV1["cameraMatrix"],
    distortion: native.distortion,
    rmsReprojectionError: native.rmsReprojectionError,
    perViewErrors: native.perViewErrors,
    includedViewIds: native.includedViewIds,
    excludedViewIds: observations
      .filter((observation) => !included.has(observation.id))
      .map((observation) => observation.id),
    board: pattern,
    captureSettings,
    poses: native.poses,
  };
}

declare const __APP_VERSION__: string;
