import type {
  CaptureProgress,
  DetectionResult,
  FrameObservation,
  ImageSize,
  Point2,
} from "./types";

const MIN_STABLE_MS = 400;
const CAPTURE_COOLDOWN_MS = 800;
const MAX_NORMALIZED_MOTION = 0.003;
const NOVELTY_DISTANCE = 0.2;
const HORIZONTAL_RANGE_TARGET = 0.7;
const VERTICAL_RANGE_TARGET = 0.7;
const SIZE_TARGET = 0.4;
const SKEW_TARGET = 0.5;

export interface CaptureDecision {
  accept: boolean;
  basicValid: boolean;
  stable: boolean;
  novel: boolean;
  reasons: string[];
}

function isFinitePoint(point: Point2 | undefined): point is Point2 {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

export function isUsableDetection(detection: DetectionResult): boolean {
  const pointCount = detection.imagePoints.length;
  return (
    Number.isInteger(detection.imageSize.width) &&
    Number.isInteger(detection.imageSize.height) &&
    detection.imageSize.width > 0 &&
    detection.imageSize.height > 0 &&
    pointCount >= 4 &&
    detection.pointIds.length === pointCount &&
    detection.objectPoints.length === pointCount &&
    detection.imagePoints.every(isFinitePoint) &&
    detection.objectPoints.every(
      (point) => isFinitePoint(point) && Number.isFinite(point.z),
    ) &&
    detection.pointIds.every((id) => Number.isInteger(id) && id >= 0) &&
    new Set(detection.pointIds).size === pointCount &&
    Number.isFinite(detection.quality.sharpness) &&
    detection.quality.sharpness >= 0 &&
    Number.isFinite(detection.quality.boardAreaRatio) &&
    detection.quality.boardAreaRatio >= 0 &&
    Number.isFinite(detection.quality.minEdgeDistancePx) &&
    Number.isInteger(detection.quality.detectedCorners) &&
    detection.quality.detectedCorners === pointCount &&
    Number.isInteger(detection.quality.availableCorners) &&
    detection.quality.availableCorners >= pointCount &&
    Array.isArray(detection.quality.messages) &&
    detection.quality.messages.every((message) => typeof message === "string") &&
    Number.isFinite(detection.pose.centerX) &&
    detection.pose.centerX >= 0 &&
    detection.pose.centerX <= 1 &&
    Number.isFinite(detection.pose.centerY) &&
    detection.pose.centerY >= 0 &&
    detection.pose.centerY <= 1 &&
    Number.isFinite(detection.pose.areaRatio) &&
    detection.pose.areaRatio >= 0 &&
    Number.isFinite(detection.pose.planeAngleDegrees) &&
    detection.pose.planeAngleDegrees >= 0 &&
    (detection.pose.skew === undefined ||
      (Number.isFinite(detection.pose.skew) &&
        detection.pose.skew >= 0 &&
        detection.pose.skew <= 1)) &&
    Number.isInteger(detection.pose.coverageCell) &&
    detection.pose.coverageCell >= 0 &&
    detection.pose.coverageCell <= 8
  );
}

interface ViewParameters {
  x: number;
  y: number;
  size: number;
  skew: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function viewParameters(view: DetectionResult | FrameObservation): ViewParameters {
  return {
    x: clamp01(view.pose.centerX),
    y: clamp01(view.pose.centerY),
    size: clamp01(Math.sqrt(Math.max(0, view.pose.areaRatio))),
    skew: clamp01(
      view.pose.skew ?? (view.pose.planeAngleDegrees * Math.PI) / 90,
    ),
  };
}

function matchingMotion(
  previousPoints: Point2[],
  previousIds: number[],
  currentPoints: Point2[],
  currentIds: number[],
  imageSize: ImageSize,
): number {
  const previousById = new Map<number, Point2>();
  previousIds.forEach((id, index) => {
    const point = previousPoints[index];
    if (point) previousById.set(id, point);
  });
  let squaredDistance = 0;
  let matches = 0;
  currentIds.forEach((id, index) => {
    const previous = previousById.get(id);
    const current = currentPoints[index];
    if (!previous || !current) return;
    squaredDistance += (current.x - previous.x) ** 2 + (current.y - previous.y) ** 2;
    matches += 1;
  });
  if (matches < 4) return Number.POSITIVE_INFINITY;
  const diagonal = Math.hypot(imageSize.width, imageSize.height);
  if (!Number.isFinite(diagonal) || diagonal <= 0 || !Number.isFinite(squaredDistance)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt(squaredDistance / matches) / diagonal;
}

function isNovel(detection: DetectionResult, observations: FrameObservation[]): boolean {
  const included = observations.filter((observation) => observation.included);
  if (included.length === 0) return true;
  const candidate = viewParameters(detection);
  return included.every((observation) => {
    const previous = viewParameters(observation);
    const distance =
      Math.abs(candidate.x - previous.x) +
      Math.abs(candidate.y - previous.y) +
      Math.abs(candidate.size - previous.size) +
      Math.abs(candidate.skew - previous.skew);
    return distance > NOVELTY_DISTANCE;
  });
}

export class CaptureGate {
  private previous?: { detection: DetectionResult; time: number };
  private stableSince?: number;
  private lastCaptureAt = Number.NEGATIVE_INFINITY;

  evaluate(
    detection: DetectionResult,
    observations: FrameObservation[],
    now = performance.now(),
  ): CaptureDecision {
    const reasons = [...detection.quality.messages];
    const basicValid = detection.ok && detection.quality.basicValid && isUsableDetection(detection);
    if (!basicValid) {
      this.previous = { detection, time: now };
      this.stableSince = undefined;
      return { accept: false, basicValid, stable: false, novel: false, reasons };
    }

    const motion = this.previous
      ? matchingMotion(
          this.previous.detection.imagePoints,
          this.previous.detection.pointIds,
          detection.imagePoints,
          detection.pointIds,
          detection.imageSize,
        )
      : Number.POSITIVE_INFINITY;

    if (motion <= MAX_NORMALIZED_MOTION) {
      this.stableSince ??= this.previous?.time ?? now;
    } else {
      this.stableSince = undefined;
    }
    this.previous = { detection, time: now };

    const stable = this.stableSince !== undefined && now - this.stableSince >= MIN_STABLE_MS;
    const novel = isNovel(detection, observations);
    const cooldownComplete = now - this.lastCaptureAt >= CAPTURE_COOLDOWN_MS;
    if (!stable) reasons.push("Hold the board still.");
    if (!novel) reasons.push("Move the board to a new position or angle.");
    if (!cooldownComplete) reasons.push("Waiting before the next capture.");

    return {
      accept: basicValid && stable && novel && cooldownComplete,
      basicValid,
      stable,
      novel,
      reasons,
    };
  }

  markCaptured(now = performance.now()): void {
    this.lastCaptureAt = now;
    this.stableSince = undefined;
  }

  reset(): void {
    this.previous = undefined;
    this.stableSince = undefined;
    this.lastCaptureAt = Number.NEGATIVE_INFINITY;
  }
}

export function captureProgress(observations: FrameObservation[]): CaptureProgress {
  const included = observations.filter((observation) => observation.included);
  const parameters = included.map(viewParameters);
  const xs = parameters.map(({ x }) => x);
  const ys = parameters.map(({ y }) => y);
  const sizes = parameters.map(({ size }) => size);
  const skews = parameters.map(({ skew }) => skew);
  const range = (values: number[]): number =>
    values.length > 0 ? Math.max(...values) - Math.min(...values) : 0;
  const horizontal = clamp01(range(xs) / HORIZONTAL_RANGE_TARGET);
  const vertical = clamp01(range(ys) / VERTICAL_RANGE_TARGET);
  const size = clamp01((sizes.length > 0 ? Math.max(...sizes) : 0) / SIZE_TARGET);
  const skew = clamp01((skews.length > 0 ? Math.max(...skews) : 0) / SKEW_TARGET);
  return {
    accepted: included.length,
    minimumReached: included.length >= 12,
    horizontal,
    vertical,
    size,
    skew,
  };
}
