import {
  DICTIONARY_NAMES,
  type CalibrationResultV1,
  type CalibrationSessionV1,
  type DetectionPoseFeatures,
  type DetectionQuality,
  type PatternConfig,
  type Point2,
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
  if (!isRecord(value)) return false;
  if (value.kind === "charuco") {
    if (
      !isFiniteNumber(value.squaresX) ||
      !isFiniteNumber(value.squaresY) ||
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
    value.boardAreaRatio <= 1 &&
    isNonNegativeNumber(value.minEdgeDistancePx) &&
    Number.isInteger(value.detectedCorners) &&
    (value.detectedCorners as number) >= 0 &&
    Number.isInteger(value.availableCorners) &&
    (value.availableCorners as number) >= 0 &&
    (value.availableCorners as number) <= MAX_POINTS_PER_VIEW &&
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
    value.centerX >= 0 &&
    value.centerX <= 1 &&
    isFiniteNumber(value.centerY) &&
    value.centerY >= 0 &&
    value.centerY <= 1 &&
    isNonNegativeNumber(value.areaRatio) &&
    value.areaRatio <= 1 &&
    isNonNegativeNumber(value.planeAngleDegrees) &&
    value.planeAngleDegrees <= 90 &&
    (value.skew === undefined ||
      (isNonNegativeNumber(value.skew) && value.skew <= 1)) &&
    Number.isInteger(value.coverageCell) &&
    (value.coverageCell as number) >= 0 &&
    (value.coverageCell as number) <= 8
  );
}

function isObservation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.imagePoints)) return false;
  if (!isImageSize(value.imageSize)) return false;
  const imageSize = value.imageSize as UnknownRecord;
  const width = imageSize.width as number;
  const height = imageSize.height as number;
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
    imagePoints.every(
      (point) =>
        isPoint(point, 2) &&
        point.x >= -width &&
        point.x <= width * 2 &&
        point.y >= -height &&
        point.y <= height * 2,
    ) &&
    value.objectPoints.every(
      (point) =>
        isPoint(point, 3) &&
        Math.abs(point.x) <= 10_000_000 &&
        Math.abs(point.y) <= 10_000_000 &&
        Math.abs(point.z) <= 10_000_000,
    ) &&
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

function isResidualRecord(
  value: unknown,
  includedIds: Set<string>,
  observations: Map<string, UnknownRecord>,
): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== includedIds.size || entries.some(([id]) => !includedIds.has(id))) {
    return false;
  }
  return entries.every(([viewId, residuals]) => {
    const observation = observations.get(viewId);
    const pointIds = observation?.pointIds;
    const imagePoints = observation?.imagePoints;
    if (
      !observation ||
      !Array.isArray(pointIds) ||
      !Array.isArray(imagePoints) ||
      !Array.isArray(residuals)
    ) {
      return false;
    }
    if (residuals.length !== pointIds.length) return false;
    const knownIds = new Set(pointIds);
    const seenIds = new Set<number>();
    return residuals.every((residual) => {
      if (
        !isRecord(residual) ||
        !Number.isInteger(residual.pointId) ||
        !knownIds.has(residual.pointId) ||
        seenIds.has(residual.pointId as number) ||
        !isPoint(residual.observed, 2) ||
        !isPoint(residual.projected, 2) ||
        !isNonNegativeNumber(residual.magnitude)
      ) {
        return false;
      }
      const observed = residual.observed as Point2;
      const projected = residual.projected as Point2;
      const pointIndex = pointIds.indexOf(residual.pointId);
      const sourcePoint = imagePoints[pointIndex];
      if (pointIndex < 0 || !isPoint(sourcePoint, 2)) return false;
      const sourceTolerance = Math.max(
        1e-3,
        Math.max(Math.abs(sourcePoint.x), Math.abs(sourcePoint.y)) * 1e-6,
      );
      if (
        Math.abs(sourcePoint.x - observed.x) > sourceTolerance ||
        Math.abs(sourcePoint.y - observed.y) > sourceTolerance
      ) {
        return false;
      }
      const measured = Math.hypot(
        projected.x - observed.x,
        projected.y - observed.y,
      );
      if (Math.abs(measured - residual.magnitude) > Math.max(1e-3, measured * 1e-5)) {
        return false;
      }
      seenIds.add(residual.pointId as number);
      return true;
    });
  });
}

function isStability(value: unknown, parameterCount: number): boolean {
  if (!isRecord(value)) return false;
  if (
    value.method !== "leave-one-view-out" ||
    !Number.isInteger(value.attemptedSamples) ||
    (value.attemptedSamples as number) < 1 ||
    (value.attemptedSamples as number) > 12 ||
    !Number.isInteger(value.successfulSamples) ||
    (value.successfulSamples as number) < 0 ||
    (value.successfulSamples as number) > (value.attemptedSamples as number)
  ) {
    return false;
  }
  const expectedLength = (value.successfulSamples as number) >= 3 ? parameterCount : 0;
  return (
    Array.isArray(value.standardDeviations) &&
    value.standardDeviations.length === expectedLength &&
    value.standardDeviations.every(isNonNegativeNumber) &&
    Array.isArray(value.maxAbsoluteDeltas) &&
    value.maxAbsoluteDeltas.length === expectedLength &&
    value.maxAbsoluteDeltas.every(isNonNegativeNumber)
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
    (value.previewCameraMatrix !== undefined &&
      (!isNumberArray(value.previewCameraMatrix, 9) ||
        value.previewCameraMatrix[0]! <= 0 ||
        value.previewCameraMatrix[4]! <= 0)) ||
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
  const perViewErrors = value.perViewErrors as UnknownRecord;
  const observationsById = new Map(observations.map((observation) => [String(observation.id), observation]));
  if (
    includedViewIds.some((id) => !Object.hasOwn(perViewErrors, id)) ||
    (value.residuals !== undefined &&
      !isResidualRecord(value.residuals, includedIds, observationsById)) ||
    (value.stability !== undefined &&
      !isStability(value.stability, 4 + expectedDistortion))
  ) {
    return false;
  }
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
      left.innerCornersY === right.innerCornersY
    );
  }
  if (left.kind === "charuco" && right.kind === "charuco") {
    return (
      left.squaresX === right.squaresX &&
      left.squaresY === right.squaresY &&
      left.dictionary === right.dictionary &&
      left.legacyPattern === right.legacyPattern
    );
  }
  return false;
}

function cleanPattern(pattern: PatternConfig): PatternConfig {
  return pattern.kind === "charuco"
    ? {
        kind: "charuco",
        squaresX: pattern.squaresX,
        squaresY: pattern.squaresY,
        dictionary: pattern.dictionary,
        legacyPattern: pattern.legacyPattern,
      }
    : {
        kind: "chessboard",
        innerCornersX: pattern.innerCornersX,
        innerCornersY: pattern.innerCornersY,
      };
}

function legacySquareScale(pattern: unknown): number {
  if (!isRecord(pattern) || !isFiniteNumber(pattern.squareLengthMm) || pattern.squareLengthMm <= 0) {
    return 1;
  }
  return pattern.squareLengthMm;
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
  const blobKeys = observations.flatMap(({ imageBlobKey, thumbnailBlobKey }) => [
    String(imageBlobKey),
    String(thumbnailBlobKey),
  ]);
  if (new Set(blobKeys).size !== blobKeys.length) return undefined;
  if (observations.length > 0 && value.imageSize === undefined) return undefined;
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

  const session = value as unknown as CalibrationSessionV1;
  const scale = legacySquareScale(value.pattern);
  const normalizedObservations = session.observations.map((observation) => ({
    ...observation,
    objectPoints: scale === 1
      ? observation.objectPoints
      : observation.objectPoints.map((point) => ({
          x: point.x / scale,
          y: point.y / scale,
          z: point.z / scale,
        })),
  }));
  const normalizedResult = session.result
    ? {
        ...session.result,
        board: cleanPattern(session.result.board),
        poses: scale === 1
          ? session.result.poses
          : session.result.poses.map((pose) => ({
              ...pose,
              translationVector: pose.translationVector.map((value) => value / scale) as [
                number,
                number,
                number,
              ],
            })),
      }
    : undefined;
  return {
    ...session,
    pattern: cleanPattern(session.pattern),
    observations: normalizedObservations,
    result: normalizedResult,
  };
}
