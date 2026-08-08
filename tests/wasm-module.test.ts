import { describe, expect, it } from "vitest";
import { CHARUCO_PRESET } from "../src/domain/patterns";
import type { FrameObservation } from "../src/domain/types";
import {
  calibrationResultFromNative,
  type NativeCalibrationResult,
} from "../src/worker/wasm-module";

function observation(index: number): FrameObservation {
  const id = `view-${index}`;
  return {
    id,
    source: "live",
    createdAt: "2026-08-07T00:00:00.000Z",
    imageSize: { width: 1280, height: 720 },
    imagePoints: [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ],
    objectPoints: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
    pointIds: [0, 1, 2, 3],
    quality: {
      sharpness: 100,
      boardAreaRatio: 0.1,
      minEdgeDistancePx: 50,
      detectedCorners: 4,
      availableCorners: 24,
      basicValid: true,
      messages: [],
    },
    pose: {
      centerX: 0.5,
      centerY: 0.5,
      areaRatio: 0.1,
      planeAngleDegrees: 15,
      coverageCell: index % 9,
    },
    imageBlobKey: `${id}-image`,
    thumbnailBlobKey: `${id}-thumbnail`,
    included: true,
  };
}

const observations = Array.from({ length: 12 }, (_, index) => observation(index));
const ids = observations.map(({ id }) => id);

function nativeResult(changes: Partial<NativeCalibrationResult> = {}): NativeCalibrationResult {
  return {
    ok: true,
    opencvVersion: "4.13.0",
    cameraMatrix: [900, 0, 640, 0, 900, 360, 0, 0, 1],
    distortion: [-0.1, 0.01, 0, 0, 0],
    rmsReprojectionError: 0.3,
    perViewErrors: Object.fromEntries(ids.map((id) => [id, 0.3])),
    includedViewIds: ids,
    excludedViewIds: [],
    poses: ids.map((viewId) => ({
      viewId,
      rotationVector: [0, 0, 0],
      translationVector: [0, 0, 1],
    })),
    residuals: Object.fromEntries(observations.map((observation) => [
      observation.id,
      observation.imagePoints.map((observed, pointIndex) => ({
        pointId: observation.pointIds[pointIndex]!,
        observed,
        projected: { x: observed.x + 0.25, y: observed.y },
        magnitude: 0.25,
      })),
    ])),
    stability: {
      method: "leave-one-view-out",
      attemptedSamples: 12,
      successfulSamples: 12,
      standardDeviations: [1, 1, 0.5, 0.5, 0.001, 0.001, 0.001, 0.001, 0.001],
      maxAbsoluteDeltas: [2, 2, 1, 1, 0.002, 0.002, 0.002, 0.002, 0.002],
    },
    ...changes,
  };
}

describe("native calibration result validation", () => {
  it("accepts a complete finite result", () => {
    const result = calibrationResultFromNative(
      nativeResult(),
      "pinhole-radtan5",
      CHARUCO_PRESET,
      { width: 1280, height: 720 },
      observations,
    );
    expect(result.includedViewIds).toEqual(ids);
    expect(result.cameraMatrix[0]).toBe(900);
    expect(result.residuals?.[ids[0]!] ?? []).toHaveLength(4);
    expect(result.stability?.successfulSamples).toBe(12);
  });

  it("rejects non-finite matrices and errors", () => {
    expect(() =>
      calibrationResultFromNative(
        nativeResult({ cameraMatrix: [Number.NaN, 0, 640, 0, 900, 360, 0, 0, 1] }),
        "pinhole-radtan5",
        CHARUCO_PRESET,
        { width: 1280, height: 720 },
        observations,
      ),
    ).toThrow("invalid camera matrix");
    expect(() =>
      calibrationResultFromNative(
        nativeResult({ rmsReprojectionError: Number.POSITIVE_INFINITY }),
        "pinhole-radtan5",
        CHARUCO_PRESET,
        { width: 1280, height: 720 },
        observations,
      ),
    ).toThrow("invalid reprojection error");
  });

  it("requires finite full and fill projections for fisheye previews", () => {
    const fisheye = nativeResult({
      distortion: [-0.1, 0.01, 0, 0],
      previewCameraMatrix: [500, 0, 640, 0, 500, 360, 0, 0, 1],
      previewFillCameraMatrix: [700, 0, 640, 0, 700, 360, 0, 0, 1],
      stability: undefined,
    });
    const result = calibrationResultFromNative(
      fisheye,
      "fisheye-kb4",
      CHARUCO_PRESET,
      { width: 1280, height: 720 },
      observations,
    );
    expect(result.previewCameraMatrix).toEqual(fisheye.previewCameraMatrix);
    expect(result.previewFillCameraMatrix).toEqual(fisheye.previewFillCameraMatrix);

    expect(() =>
      calibrationResultFromNative(
        nativeResult({ distortion: [-0.1, 0.01, 0, 0] }),
        "fisheye-kb4",
        CHARUCO_PRESET,
        { width: 1280, height: 720 },
        observations,
      ),
    ).toThrow("invalid fisheye preview matrix");
  });

  it("rejects unknown or duplicate included views and malformed poses", () => {
    expect(() =>
      calibrationResultFromNative(
        nativeResult({ includedViewIds: [...ids.slice(0, 11), ids[0]!] }),
        "pinhole-radtan5",
        CHARUCO_PRESET,
        { width: 1280, height: 720 },
        observations,
      ),
    ).toThrow("invalid set of included views");
    expect(() =>
      calibrationResultFromNative(
        nativeResult({ poses: nativeResult().poses.slice(0, 11) }),
        "pinhole-radtan5",
        CHARUCO_PRESET,
        { width: 1280, height: 720 },
        observations,
      ),
    ).toThrow("invalid camera poses");
  });

  it("rejects malformed residual and stability diagnostics", () => {
    const badResiduals = nativeResult().residuals;
    badResiduals[ids[0]!]![0] = {
      ...badResiduals[ids[0]!]![0]!,
      magnitude: 5,
    };
    expect(() =>
      calibrationResultFromNative(
        nativeResult({ residuals: badResiduals }),
        "pinhole-radtan5",
        CHARUCO_PRESET,
        { width: 1280, height: 720 },
        observations,
      ),
    ).toThrow("invalid reprojection residuals");

    expect(() =>
      calibrationResultFromNative(
        nativeResult({
          stability: {
            method: "leave-one-view-out",
            attemptedSamples: 12,
            successfulSamples: 12,
            standardDeviations: [1, 1],
            maxAbsoluteDeltas: [1, 1],
          },
        }),
        "pinhole-radtan5",
        CHARUCO_PRESET,
        { width: 1280, height: 720 },
        observations,
      ),
    ).toThrow("invalid calibration stability data");
  });
});
