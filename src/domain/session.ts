import {
  DICTIONARY_NAMES,
  type CalibrationResultV1,
  type CalibrationSessionV1,
  type DetectionPoseFeatures,
  type DetectionQuality,
  type PatternConfig,
} from "./types";
import { validatePattern } from "./patterns";

const MAX_IMAGE_EDGE = 32_768;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_OBSERVATIONS = 100;
const MAX_POINTS_PER_VIEW = 1_000;
const STEPS = new Set(["setup", "capture", "review", "results"]);
const LENS_MODELS = new Set(["pinhole-radtan5", "fisheye-kb4"]);
const DICTIONARIES = new Set<string>(DICTIONARY_NAMES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= 1_024);
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isImageSize(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { width, height } = value;
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    (width as number) > 0 &&
    (height as number) > 0 &&
    (width as number) <= MAX_IMAGE_EDGE &&
    (height as number) <= MAX_IMAGE_EDGE &&
    (width as number) * (height as number) <= MAX_IMAGE_PIXELS
  );
}

function isPoint(value: unknown, dimensions: 2 | 3): boolean {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return false;
  return dimensions === 2 || isFiniteNumber(value.z);
}

function isPattern(value: unknown): value is PatternConfig {
  if (!isRecord(value) || !isFiniteNumber(value.squareLengthMm)) return false;
  if (value.kind === "charuco") {
    if (
      !isFiniteNumber(value.squaresX) ||
      !isFiniteNumber(value.squaresY) ||
      !isFiniteNumber(value.markerLengthMm) ||
      typeof value.dictionary !== "string" ||
      !DICTIONARIES.has(value.dictionary) ||
      typeof value.legacyPattern !== "boolean"
    ) {
      return false;
    }
  } else if (value.kind === "chessboard") {
    if (!isFiniteNumber(value.innerCornersX) || !isFiniteNumber(value.innerCornersY)) return false;
  } else {
    return false;
  }
  return validatePattern(value as unknown as PatternConfig).length === 0;
}

function isCaptureSettings(value: unknown): boolean {
  if (!isImageSize(value) || !isRecord(value)) return false;
  return (
    (value.frameRate === undefined || (isFiniteNumber(value.frameRate) && value.frameRate > 0)) &&
    (value.aspectRatio === undefined ||
      (isFiniteNumber(value.aspectRatio) && value.aspectRatio > 0)) &&
    (value.zoom === undefined || (isFiniteNumber(value.zoom) && value.zoom >= 0)) &&
    isOptionalString(value.deviceId) &&
    isOptionalString(value.facingMode) &&
    isOptionalString(value.resizeMode) &&
    isOptionalString(value.focusMode) &&
    isOptionalString(value.cameraLabel)
  );
}

function isQuality(value: unknown): value is DetectionQuality {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.sharpness) &&
    isNonNegativeNumber(value.boardAreaRatio) &&
    isNonNegativeNumber(value.minEdgeDistancePx) &&
    Number.isInteger(value.detectedCorners) &&
    (value.detectedCorners as number) >= 0 &&
    Number.isInteger(value.availableCorners) &&
    (value.availableCorners as number) >= 0 &&
    typeof value.basicValid === "boolean" &&
    Array.isArray(value.messages) &&
    value.messages.length <= 20 &&
    value.messages.every((message) => typeof message === "string" && message.length <= 500)
  );
}

function isPoseFeatures(value: unknown): value is DetectionPoseFeatures {
  return (
    isRecord(value) &&
    isFiniteNumber(value.centerX) &&
    isFiniteNumber(value.centerY) &&
    isNonNegativeNumber(value.areaRatio) &&
    isNonNegativeNumber(value.planeAngleDegrees) &&
    Number.isInteger(value.coverageCell) &&
    (value.coverageCell as number) >= 0 &&
    (value.coverageCell as number) <= 8
  );
}

function isObservation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.imagePoints)) return false;
  const imagePoints = value.imagePoints;
  const pointCount = imagePoints.length;
  if (pointCount < 4 || pointCount > MAX_POINTS_PER_VIEW) return false;
  if (
    !Array.isArray(value.objectPoints) ||
    !Array.isArray(value.pointIds) ||
    value.objectPoints.length !== pointCount ||
    value.pointIds.length !== pointCount
  ) {
    return false;
  }
  const ids = value.pointIds;
  const quality = value.quality;
  return (
    isNonEmptyString(value.id) &&
    (value.source === "live" || value.source === "upload") &&
    isOptionalString(value.sourceName) &&
    isTimestamp(value.createdAt) &&
    isImageSize(value.imageSize) &&
    imagePoints.every((point) => isPoint(point, 2)) &&
    value.objectPoints.every((point) => isPoint(point, 3)) &&
    ids.every((id) => Number.isInteger(id) && (id as number) >= 0) &&
    new Set(ids).size === ids.length &&
    isQuality(quality) &&
    quality.detectedCorners === pointCount &&
    quality.availableCorners >= pointCount &&
    isPoseFeatures(value.pose) &&
    isNonEmptyString(value.imageBlobKey) &&
    isNonEmptyString(value.thumbnailBlobKey) &&
    typeof value.included === "boolean" &&
    isOptionalString(value.autoExcludedReason) &&
    (value.perViewRms === undefined || isNonNegativeNumber(value.perViewRms))
  );
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function isUniqueStringArray(value: unknown, knownIds: Set<string>): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => isNonEmptyString(id) && knownIds.has(id)) &&
    new Set(value).size === value.length
  );
}

function isCalibrationResult(
  value: unknown,
  observations: UnknownRecord[],
): value is CalibrationResultV1 {
  if (
    !isRecord(value) ||
    typeof value.model !== "string" ||
    !LENS_MODELS.has(value.model)
  ) {
    return false;
  }
  const observationIds = new Set(observations.map(({ id }) => String(id)));
  const expectedDistortion = value.model === "pinhole-radtan5" ? 5 : 4;
  const includedViewIds = value.includedViewIds;
  const excludedViewIds = value.excludedViewIds;
  if (
    value.schemaVersion !== 1 ||
    !isRecord(value.generator) ||
    !isNonEmptyString(value.generator.appVersion) ||
    !isNonEmptyString(value.generator.opencvVersion) ||
    !isTimestamp(value.createdAt) ||
    !isImageSize(value.imageSize) ||
    !isNumberArray(value.cameraMatrix, 9) ||
    !isFiniteNumber(value.cameraMatrix[0]) ||
    value.cameraMatrix[0] <= 0 ||
    !isFiniteNumber(value.cameraMatrix[4]) ||
    value.cameraMatrix[4] <= 0 ||
    !isNumberArray(value.distortion, expectedDistortion) ||
    !isNonNegativeNumber(value.rmsReprojectionError) ||
    !isRecord(value.perViewErrors) ||
    !Object.entries(value.perViewErrors).every(
      ([id, error]) => observationIds.has(id) && isNonNegativeNumber(error),
    ) ||
    !isUniqueStringArray(includedViewIds, observationIds) ||
    !isUniqueStringArray(excludedViewIds, observationIds) ||
    includedViewIds.some((id) => excludedViewIds.includes(id)) ||
    !isPattern(value.board) ||
    (value.captureSettings !== undefined && !isCaptureSettings(value.captureSettings)) ||
    !Array.isArray(value.poses)
  ) {
    return false;
  }
  const includedIds = new Set(includedViewIds);
  const poseIds = new Set<string>();
  return (
    includedViewIds.length >= 12 &&
    includedViewIds.length + excludedViewIds.length === observationIds.size &&
    observations.every(({ id, included }) => includedIds.has(String(id)) === included) &&
    value.poses.length === includedViewIds.length &&
    value.poses.every((pose) => {
      if (
        !isRecord(pose) ||
        !isNonEmptyString(pose.viewId) ||
        !includedIds.has(pose.viewId) ||
        poseIds.has(pose.viewId) ||
        !isNumberArray(pose.rotationVector, 3) ||
        !isNumberArray(pose.translationVector, 3)
      ) {
        return false;
      }
      poseIds.add(pose.viewId);
      return true;
    })
  );
}

function sameImageSize(left: unknown, right: unknown): boolean {
  return (
    isRecord(left) &&
    isRecord(right) &&
    left.width === right.width &&
    left.height === right.height
  );
}

function samePattern(left: unknown, right: unknown): boolean {
  if (!isPattern(left) || !isPattern(right) || left.kind !== right.kind) return false;
  if (left.kind === "chessboard" && right.kind === "chessboard") {
    return (
      left.innerCornersX === right.innerCornersX &&
      left.innerCornersY === right.innerCornersY &&
      left.squareLengthMm === right.squareLengthMm
    );
  }
  if (left.kind === "charuco" && right.kind === "charuco") {
    return (
      left.squaresX === right.squaresX &&
      left.squaresY === right.squaresY &&
      left.squareLengthMm === right.squareLengthMm &&
      left.markerLengthMm === right.markerLengthMm &&
      left.dictionary === right.dictionary &&
      left.legacyPattern === right.legacyPattern
    );
  }
  return false;
}

/** Validates untrusted IndexedDB data before the application uses it. */
export function parseStoredSession(value: unknown): CalibrationSessionV1 | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.id) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    typeof value.step !== "string" ||
    !STEPS.has(value.step) ||
    typeof value.lensModel !== "string" ||
    !LENS_MODELS.has(value.lensModel) ||
    !isPattern(value.pattern) ||
    (value.imageSize !== undefined && !isImageSize(value.imageSize)) ||
    (value.captureSettings !== undefined && !isCaptureSettings(value.captureSettings)) ||
    !Array.isArray(value.observations) ||
    value.observations.length > MAX_OBSERVATIONS ||
    !value.observations.every(isObservation)
  ) {
    return undefined;
  }

  const observations = value.observations as UnknownRecord[];
  const ids = observations.map(({ id }) => String(id));
  if (new Set(ids).size !== ids.length) return undefined;
  if (
    value.imageSize !== undefined &&
    observations.some(({ imageSize }) => !sameImageSize(imageSize, value.imageSize))
  ) {
    return undefined;
  }
  if (value.result !== undefined && !isCalibrationResult(value.result, observations)) {
    return undefined;
  }
  if (
    isRecord(value.result) &&
    (value.result.model !== value.lensModel ||
      (value.imageSize !== undefined && !sameImageSize(value.result.imageSize, value.imageSize)) ||
      !samePattern(value.result.board, value.pattern))
  ) {
    return undefined;
  }
  if (value.step === "results" && value.result === undefined) return undefined;
  return value as unknown as CalibrationSessionV1;
}
