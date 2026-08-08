import { describe, expect, it } from "vitest";
import { calibrationHealth } from "../src/domain/calibration-health";
import { CHARUCO_PRESET } from "../src/domain/patterns";
import type { CalibrationResultV1, FrameObservation, Point2 } from "../src/domain/types";

const width = 1200;
const height = 800;
const points: Point2[] = Array.from({ length: 8 }, (_, row) =>
  Array.from({ length: 12 }, (_, column) => ({
    x: ((column + 0.5) / 12) * width,
    y: ((row + 0.5) / 8) * height,
  })),
).flat();

function observation(index: number): FrameObservation {
  return {
    id: `view-${index}`,
    source: "upload",
    sourceName: `view-${index}.png`,
    createdAt: "2026-08-07T00:00:00.000Z",
    imageSize: { width, height },
    imagePoints: points,
    objectPoints: points.map(({ x, y }) => ({ x, y, z: 0 })),
    pointIds: points.map((_, pointIndex) => pointIndex),
    quality: {
      sharpness: 100,
      boardAreaRatio: 0.2,
      minEdgeDistancePx: 20,
      detectedCorners: points.length,
      availableCorners: points.length,
      basicValid: true,
      messages: [],
    },
    pose: {
      centerX: 0.5,
      centerY: 0.5,
      areaRatio: 0.2,
      planeAngleDegrees: 10 + index * 2,
      coverageCell: 4,
    },
    imageBlobKey: `image-${index}`,
    thumbnailBlobKey: `thumbnail-${index}`,
    included: true,
  };
}

const observations = Array.from({ length: 12 }, (_, index) => observation(index));
const viewIds = observations.map(({ id }) => id);
const rotations: Array<[number, number, number]> = [
  [0, 0.45, 0],
  [0, -0.45, 0],
  [0.45, 0, 0],
  [-0.45, 0, 0],
];

function result(changes: Partial<CalibrationResultV1> = {}): CalibrationResultV1 {
  return {
    schemaVersion: 1,
    generator: { appVersion: "test", opencvVersion: "4.13.0" },
    createdAt: "2026-08-07T00:00:00.000Z",
    model: "pinhole-radtan5",
    imageSize: { width, height },
    cameraMatrix: [900, 0, width / 2, 0, 900, height / 2, 0, 0, 1],
    distortion: [0, 0, 0, 0, 0],
    rmsReprojectionError: 0.31,
    perViewErrors: Object.fromEntries(viewIds.map((id, index) => [id, 0.3 + (index % 3) * 0.01])),
    includedViewIds: viewIds,
    excludedViewIds: [],
    board: CHARUCO_PRESET,
    poses: viewIds.map((viewId, index) => ({
      viewId,
      rotationVector: rotations[index % rotations.length]!,
      translationVector: [0, 0, 1],
    })),
    residuals: Object.fromEntries(observations.map((view) => [
      view.id,
      view.imagePoints.map((observed, pointIndex) => ({
        pointId: pointIndex,
        observed,
        projected: { x: observed.x + 0.2, y: observed.y },
        magnitude: 0.2,
      })),
    ])),
    stability: {
      method: "leave-one-view-out",
      attemptedSamples: 12,
      successfulSamples: 12,
      standardDeviations: [4.5, 3, 2, 3, 0.001, 0.001, 0.001, 0.001, 0.001],
      maxAbsoluteDeltas: [8, 7, 4, 5, 0.002, 0.002, 0.002, 0.002, 0.002],
    },
    ...changes,
  };
}

describe("calibration health diagnostics", () => {
  it("summarizes spatial coverage, residuals, tilt, and stability", () => {
    const health = calibrationHealth(result(), observations);

    expect(health.errorMedian).toBeCloseTo(0.31);
    expect(health.errorP95).toBeCloseTo(0.32);
    expect(health.errorMaximum).toBeCloseTo(0.32);
    expect(health.occupiedCellRatio).toBe(1);
    expect(health.occupiedEdgeCellRatio).toBe(1);
    expect(health.residualGrid.every((value) => Math.abs(value - 0.2) < 1e-5)).toBe(true);
    expect(health.tiltDirections).toEqual(["left", "right", "up", "down"]);
    expect(health.minimumTiltDegrees).toBeCloseTo((0.45 * 180) / Math.PI);
    expect(health.maximumTiltDegrees).toBeCloseTo((0.45 * 180) / Math.PI);
    expect(health.focalVariationPercent).toBeCloseTo(0.5);
    expect(health.principalPointVariationPx).toBeCloseTo(Math.hypot(2, 3));
    expect(health.warnings).toEqual([]);
  });

  it("reports factual warnings for concentrated observations", () => {
    const sparse = observations.map((view) => ({
      ...view,
      imagePoints: view.imagePoints.slice(40, 44),
      pose: { ...view.pose, planeAngleDegrees: 5 },
    }));
    const health = calibrationHealth(
      result({
        poses: viewIds.map((viewId) => ({
          viewId,
          rotationVector: [0, 0, 0],
          translationVector: [0, 0, 1],
        })),
        residuals: undefined,
      }),
      sparse,
    );

    expect(health.occupiedCellRatio).toBeLessThan(0.5);
    expect(health.occupiedEdgeCellRatio).toBe(0);
    expect(health.tiltDirections).toEqual([]);
    expect(health.warnings).toContain("Detected points leave much of the image unobserved.");
    expect(health.warnings).toContain("Few detected points reach the image boundary.");
    expect(health.warnings).toContain("Board tilt is limited; add views angled toward the image edges.");
  });
});
