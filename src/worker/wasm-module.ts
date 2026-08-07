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
  previewCameraMatrix?: number[];
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

function finiteArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function validVector(value: unknown): value is [number, number, number] {
  return finiteArray(value, 3);
}

function uniqueKnownIds(value: unknown, knownIds: Set<string>): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === "string" && knownIds.has(id)) &&
    new Set(value).size === value.length
  );
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
  if (
    !Number.isInteger(imageSize.width) ||
    !Number.isInteger(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    throw new Error("Calibration image dimensions are invalid.");
  }
  if (
    !finiteArray(native.cameraMatrix, 9) ||
    native.cameraMatrix[0]! <= 0 ||
    native.cameraMatrix[4]! <= 0
  ) {
    throw new Error("OpenCV returned an invalid camera matrix.");
  }
  if (
    model === "fisheye-kb4" &&
    (!finiteArray(native.previewCameraMatrix, 9) ||
      native.previewCameraMatrix[0]! <= 0 ||
      native.previewCameraMatrix[4]! <= 0)
  ) {
    throw new Error("OpenCV returned an invalid fisheye preview matrix.");
  }
  const expectedCoefficients = model === "pinhole-radtan5" ? 5 : 4;
  const coefficientCount = native.distortion.length;
  if (!finiteArray(native.distortion, expectedCoefficients)) {
    throw new Error(`OpenCV returned ${coefficientCount} invalid distortion coefficients.`);
  }
  if (!Number.isFinite(native.rmsReprojectionError) || native.rmsReprojectionError < 0) {
    throw new Error("OpenCV returned an invalid reprojection error.");
  }
  if (typeof native.opencvVersion !== "string" || native.opencvVersion.length === 0) {
    throw new Error("OpenCV returned no version information.");
  }

  const allObservationIds = new Set(observations.map((observation) => observation.id));
  if (allObservationIds.size !== observations.length) {
    throw new Error("Calibration view identifiers must be unique.");
  }
  const eligibleObservations = observations.filter((observation) => observation.included);
  const eligibleIds = new Set(eligibleObservations.map((observation) => observation.id));
  if (
    eligibleIds.size !== eligibleObservations.length ||
    eligibleIds.size < 12 ||
    !uniqueKnownIds(native.includedViewIds, eligibleIds) ||
    native.includedViewIds.length < 12
  ) {
    throw new Error("OpenCV returned an invalid set of included views.");
  }
  if (
    !uniqueKnownIds(native.excludedViewIds, eligibleIds) ||
    native.excludedViewIds.some((id) => native.includedViewIds.includes(id)) ||
    native.includedViewIds.length + native.excludedViewIds.length !== eligibleIds.size
  ) {
    throw new Error("OpenCV returned an invalid set of excluded views.");
  }
  if (
    typeof native.perViewErrors !== "object" ||
    native.perViewErrors === null ||
    Array.isArray(native.perViewErrors) ||
    !Object.entries(native.perViewErrors).every(
      ([id, error]) =>
        eligibleIds.has(id) &&
        typeof error === "number" &&
        Number.isFinite(error) &&
        error >= 0,
    ) ||
    native.includedViewIds.some((id) => !Object.hasOwn(native.perViewErrors, id))
  ) {
    throw new Error("OpenCV returned invalid per-view errors.");
  }
  const poseIds = new Set<string>();
  const includedIds = new Set(native.includedViewIds);
  if (
    !Array.isArray(native.poses) ||
    native.poses.length !== native.includedViewIds.length ||
    !native.poses.every((pose) => {
      if (
        typeof pose?.viewId !== "string" ||
        !includedIds.has(pose.viewId) ||
        poseIds.has(pose.viewId) ||
        !validVector(pose.rotationVector) ||
        !validVector(pose.translationVector)
      ) {
        return false;
      }
      poseIds.add(pose.viewId);
      return true;
    })
  ) {
    throw new Error("OpenCV returned invalid camera poses.");
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
    previewCameraMatrix:
      model === "fisheye-kb4"
        ? (native.previewCameraMatrix as CalibrationResultV1["previewCameraMatrix"])
        : undefined,
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
