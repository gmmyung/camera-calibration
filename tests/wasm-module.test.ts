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
    imagePoints: [],
    objectPoints: [],
    pointIds: [],
    quality: {
      sharpness: 100,
      boardAreaRatio: 0.1,
      minEdgeDistancePx: 50,
      detectedCorners: 20,
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

  it("requires a finite full-field projection for fisheye previews", () => {
    const fisheye = nativeResult({
      distortion: [-0.1, 0.01, 0, 0],
      previewCameraMatrix: [500, 0, 640, 0, 500, 360, 0, 0, 1],
    });
    const result = calibrationResultFromNative(
      fisheye,
      "fisheye-kb4",
      CHARUCO_PRESET,
      { width: 1280, height: 720 },
      observations,
    );
    expect(result.previewCameraMatrix).toEqual(fisheye.previewCameraMatrix);

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
});
