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

export interface CaptureDecision {
  accept: boolean;
  basicValid: boolean;
  stable: boolean;
  novel: boolean;
  reasons: string[];
}

function matchingMotion(
  previousPoints: Point2[],
  previousIds: number[],
  currentPoints: Point2[],
  currentIds: number[],
  imageSize: ImageSize,
): number {
  const previousById = new Map(previousIds.map((id, index) => [id, previousPoints[index]]));
  let squaredDistance = 0;
  let matches = 0;
  currentIds.forEach((id, index) => {
    const previous = previousById.get(id);
    if (!previous) return;
    const current = currentPoints[index];
    squaredDistance += (current.x - previous.x) ** 2 + (current.y - previous.y) ** 2;
    matches += 1;
  });
  if (matches < 4) return Number.POSITIVE_INFINITY;
  const diagonal = Math.hypot(imageSize.width, imageSize.height);
  return Math.sqrt(squaredDistance / matches) / diagonal;
}

function isNovel(detection: DetectionResult, observations: FrameObservation[]): boolean {
  const included = observations.filter((observation) => observation.included);
  if (included.length === 0) return true;
  return included.every((observation) => {
    const centerDistance = Math.hypot(
      detection.pose.centerX - observation.pose.centerX,
      detection.pose.centerY - observation.pose.centerY,
    );
    const areaChange =
      Math.abs(detection.pose.areaRatio - observation.pose.areaRatio) /
      Math.max(observation.pose.areaRatio, 0.001);
    const angleChange = Math.abs(
      detection.pose.planeAngleDegrees - observation.pose.planeAngleDegrees,
    );
    const fillsNewCell = !included.some(
      (candidate) => candidate.pose.coverageCell === detection.pose.coverageCell,
    );
    return centerDistance >= 0.12 || areaChange >= 0.2 || angleChange >= 10 || fillsNewCell;
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
    const basicValid = detection.ok && detection.quality.basicValid;
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
  const occupiedCells = new Set(included.map((observation) => observation.pose.coverageCell)).size;
  const tiltedViews = included.filter(
    (observation) => observation.pose.planeAngleDegrees >= 15,
  ).length;
  const areas = included
    .map((observation) => observation.pose.areaRatio)
    .filter((area) => area > 0);
  const scaleRatio =
    areas.length > 1 ? Math.sqrt(Math.max(...areas) / Math.min(...areas)) : 1;
  const targetReached =
    included.length >= 20 && occupiedCells >= 6 && tiltedViews >= 4 && scaleRatio >= 1.8;
  return {
    accepted: included.length,
    minimumReached: included.length >= 12,
    targetReached,
    occupiedCells,
    tiltedViews,
    scaleRatio,
  };
}
