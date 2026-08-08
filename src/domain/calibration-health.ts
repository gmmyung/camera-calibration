import type {
  CalibrationResultV1,
  FrameObservation,
  Point2,
  ViewPose,
} from "./types";

export const HEALTH_GRID_COLUMNS = 12;
export const HEALTH_GRID_ROWS = 8;

export interface CalibrationHealth {
  errorMedian: number;
  errorP95: number;
  errorMaximum: number;
  pointGrid: number[];
  residualGrid: number[];
  residualGridCounts: number[];
  occupiedCellRatio: number;
  occupiedEdgeCellRatio: number;
  minimumTiltDegrees: number;
  maximumTiltDegrees: number;
  tiltDirections: string[];
  principalPointOffsetPx: number;
  focalLengthRatio: number;
  focalVariationPercent?: number;
  principalPointVariationPx?: number;
  warnings: string[];
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function gridIndex(point: Point2, width: number, height: number): number | undefined {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x > width ||
    point.y > height
  ) {
    return undefined;
  }
  const column = Math.min(
    HEALTH_GRID_COLUMNS - 1,
    Math.floor((point.x / width) * HEALTH_GRID_COLUMNS),
  );
  const row = Math.min(
    HEALTH_GRID_ROWS - 1,
    Math.floor((point.y / height) * HEALTH_GRID_ROWS),
  );
  return row * HEALTH_GRID_COLUMNS + column;
}

function boardNormal(pose: ViewPose): [number, number, number] {
  const [x, y, z] = pose.rotationVector;
  const angle = Math.hypot(x, y, z);
  if (angle < 1e-12) return [0, 0, 1];
  const ax = x / angle;
  const ay = y / angle;
  const az = z / angle;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const oneMinusCosine = 1 - cosine;
  return [
    ax * az * oneMinusCosine + ay * sine,
    ay * az * oneMinusCosine - ax * sine,
    cosine + az * az * oneMinusCosine,
  ];
}

function occupiedRatio(values: number[], indices: number[]): number {
  if (indices.length === 0) return 0;
  return indices.filter((index) => (values[index] ?? 0) > 0).length / indices.length;
}

export function calibrationHealth(
  result: CalibrationResultV1,
  observations: FrameObservation[],
): CalibrationHealth {
  const includedIds = new Set(result.includedViewIds);
  const included = observations.filter((observation) => includedIds.has(observation.id));
  const errors = result.includedViewIds
    .map((viewId) => result.perViewErrors[viewId])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const cellCount = HEALTH_GRID_COLUMNS * HEALTH_GRID_ROWS;
  const pointGrid = Array<number>(cellCount).fill(0);
  const residualSums = Array<number>(cellCount).fill(0);
  const residualGridCounts = Array<number>(cellCount).fill(0);

  included.forEach((observation) => {
    observation.imagePoints.forEach((point) => {
      const index = gridIndex(point, result.imageSize.width, result.imageSize.height);
      if (index !== undefined) pointGrid[index] = (pointGrid[index] ?? 0) + 1;
    });
  });
  Object.values(result.residuals ?? {}).flat().forEach((residual) => {
    const index = gridIndex(residual.observed, result.imageSize.width, result.imageSize.height);
    if (index === undefined) return;
    residualSums[index] = (residualSums[index] ?? 0) + residual.magnitude;
    residualGridCounts[index] = (residualGridCounts[index] ?? 0) + 1;
  });
  const residualGrid = residualSums.map((sum, index) => {
    const count = residualGridCounts[index] ?? 0;
    return count > 0 ? sum / count : 0;
  });

  const allIndices = Array.from({ length: cellCount }, (_, index) => index);
  const edgeIndices = allIndices.filter((index) => {
    const row = Math.floor(index / HEALTH_GRID_COLUMNS);
    const column = index % HEALTH_GRID_COLUMNS;
    return (
      row === 0 ||
      row === HEALTH_GRID_ROWS - 1 ||
      column === 0 ||
      column === HEALTH_GRID_COLUMNS - 1
    );
  });
  const occupiedCellRatio = occupiedRatio(pointGrid, allIndices);
  const occupiedEdgeCellRatio = occupiedRatio(pointGrid, edgeIndices);

  const normals = result.poses.map(boardNormal);
  const tilts = normals.map(([, , normalZ]) =>
    (Math.acos(Math.min(1, Math.max(0, Math.abs(normalZ)))) * 180) / Math.PI,
  );
  const minimumTiltDegrees = tilts.length > 0 ? Math.min(...tilts) : 0;
  const maximumTiltDegrees = tilts.length > 0 ? Math.max(...tilts) : 0;
  const tiltDirectionSet = new Set<string>();
  normals.forEach(([normalX, normalY]) => {
    if (normalX < -0.12) tiltDirectionSet.add("left");
    if (normalX > 0.12) tiltDirectionSet.add("right");
    if (normalY < -0.12) tiltDirectionSet.add("up");
    if (normalY > 0.12) tiltDirectionSet.add("down");
  });
  const tiltDirections = ["left", "right", "up", "down"].filter((direction) =>
    tiltDirectionSet.has(direction),
  );

  const fx = result.cameraMatrix[0];
  const fy = result.cameraMatrix[4];
  const cx = result.cameraMatrix[2];
  const cy = result.cameraMatrix[5];
  const principalPointOffsetPx = Math.hypot(
    cx - result.imageSize.width / 2,
    cy - result.imageSize.height / 2,
  );
  const focalLengthRatio = fx / fy;

  const stability = result.stability;
  const stabilityReady =
    stability !== undefined &&
    stability.successfulSamples >= 3 &&
    stability.standardDeviations.length >= 4;
  const focalVariationPercent = stabilityReady
    ? Math.max(
        (stability.standardDeviations[0]! / Math.abs(fx)) * 100,
        (stability.standardDeviations[1]! / Math.abs(fy)) * 100,
      )
    : undefined;
  const principalPointVariationPx = stabilityReady
    ? Math.hypot(stability.standardDeviations[2]!, stability.standardDeviations[3]!)
    : undefined;

  const errorMedian = quantile(errors, 0.5);
  const errorP95 = quantile(errors, 0.95);
  const errorMaximum = errors.length > 0 ? Math.max(...errors) : 0;
  const warnings: string[] = [];
  if (occupiedCellRatio < 0.5) {
    warnings.push("Detected points leave much of the image unobserved.");
  }
  if (occupiedEdgeCellRatio < 0.3) {
    warnings.push("Few detected points reach the image boundary.");
  }
  if (maximumTiltDegrees < 20) {
    warnings.push("Board tilt is limited; add views angled toward the image edges.");
  }
  if (tiltDirections.length < 3) {
    warnings.push("Tilt directions are concentrated on too few sides of the image.");
  }
  if (errorP95 > Math.max(0.5, errorMedian * 2.5)) {
    warnings.push("Reprojection error is concentrated in a subset of views.");
  }
  const imageDiagonal = Math.hypot(result.imageSize.width, result.imageSize.height);
  if (principalPointOffsetPx > imageDiagonal * 0.15) {
    warnings.push("The estimated principal point is far from the image center.");
  }
  if (focalLengthRatio < 0.85 || focalLengthRatio > 1.15) {
    warnings.push("The estimated horizontal and vertical focal lengths differ substantially.");
  }
  if (focalVariationPercent !== undefined && focalVariationPercent > 1) {
    warnings.push("Focal length changes noticeably when individual views are removed.");
  }
  if (
    principalPointVariationPx !== undefined &&
    principalPointVariationPx > imageDiagonal * 0.01
  ) {
    warnings.push("Principal-point position changes noticeably when individual views are removed.");
  }
  if (stability && stability.successfulSamples < 3) {
    warnings.push("Too few leave-one-view-out subsets produced a stable solution.");
  }

  return {
    errorMedian,
    errorP95,
    errorMaximum,
    pointGrid,
    residualGrid,
    residualGridCounts,
    occupiedCellRatio,
    occupiedEdgeCellRatio,
    minimumTiltDegrees,
    maximumTiltDegrees,
    tiltDirections,
    principalPointOffsetPx,
    focalLengthRatio,
    focalVariationPercent,
    principalPointVariationPx,
    warnings,
  };
}
