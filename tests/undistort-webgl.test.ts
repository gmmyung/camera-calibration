import { describe, expect, it } from "vitest";
import type { CalibrationResultV1 } from "../src/domain/types";
import { frameCalibrationUniforms } from "../src/lib/undistort-webgl";

function calibration(
  model: CalibrationResultV1["model"],
  distortion: number[],
): CalibrationResultV1 {
  return {
    schemaVersion: 1,
    generator: { appVersion: "test", opencvVersion: "test" },
    createdAt: new Date(0).toISOString(),
    model,
    imageSize: { width: 1280, height: 720 },
    cameraMatrix: [1000, 2, 640, 0, 900, 360, 0, 0, 1],
    distortion,
    rmsReprojectionError: 0.2,
    perViewErrors: {},
    includedViewIds: [],
    excludedViewIds: [],
    board: {
      kind: "chessboard",
      innerCornersX: 9,
      innerCornersY: 6,
      squareLengthMm: 24,
    },
    poses: [],
  };
}

describe("WebGL undistortion uniforms", () => {
  it("scales standard-lens intrinsics to the active stream", () => {
    const uniforms = frameCalibrationUniforms(
      calibration("pinhole-radtan5", [0.1, -0.2, 0.003, -0.004, 0.05]),
      1920,
      1080,
    );

    expect(uniforms).toEqual({
      focalLength: [1500, 1350],
      principalPoint: [960, 540],
      skew: 3,
      distortion: [0.1, -0.2, 0.003, -0.004],
      radialK3: 0.05,
      lensModel: 0,
    });
  });

  it("passes all four fisheye coefficients to the shader", () => {
    const uniforms = frameCalibrationUniforms(
      calibration("fisheye-kb4", [0.01, -0.02, 0.003, -0.0004]),
      640,
      360,
    );

    expect(uniforms).toMatchObject({
      focalLength: [500, 450],
      principalPoint: [320, 180],
      distortion: [0.01, -0.02, 0.003, -0.0004],
      radialK3: 0,
      lensModel: 1,
    });
  });

  it("rejects coefficient counts that do not match the model", () => {
    expect(() =>
      frameCalibrationUniforms(calibration("pinhole-radtan5", [0.1, 0.2]), 1280, 720),
    ).toThrow("five distortion coefficients");
    expect(() =>
      frameCalibrationUniforms(calibration("fisheye-kb4", [0.1, 0.2, 0.3]), 1280, 720),
    ).toThrow("four distortion coefficients");
  });

  it("rejects non-positive focal lengths and non-finite values", () => {
    const invalidFocal = calibration("pinhole-radtan5", [0, 0, 0, 0, 0]);
    invalidFocal.cameraMatrix[0] = 0;
    expect(() => frameCalibrationUniforms(invalidFocal, 1280, 720)).toThrow(
      "invalid focal lengths",
    );

    const invalidDistortion = calibration("fisheye-kb4", [0, 0, Number.NaN, 0]);
    expect(() => frameCalibrationUniforms(invalidDistortion, 1280, 720)).toThrow(
      "non-finite values",
    );
  });
});
