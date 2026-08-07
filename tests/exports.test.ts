import { describe, expect, it } from "vitest";
import { CHARUCO_PRESET } from "../src/domain/patterns";
import type { CalibrationResultV1 } from "../src/domain/types";
import { resultJson, toOpenCvYaml } from "../src/lib/exports";

const result: CalibrationResultV1 = {
  schemaVersion: 1,
  generator: { appVersion: "0.1.0", opencvVersion: "4.13.0" },
  createdAt: "2026-08-07T00:00:00.000Z",
  model: "pinhole-radtan5",
  imageSize: { width: 1280, height: 720 },
  cameraMatrix: [900, 0, 640, 0, 901, 360, 0, 0, 1],
  distortion: [-0.1, 0.02, 0.001, -0.001, 0],
  rmsReprojectionError: 0.31,
  perViewErrors: { "view-1": 0.31 },
  includedViewIds: ["view-1"],
  excludedViewIds: [],
  board: CHARUCO_PRESET,
  poses: [],
};

describe("calibration exports", () => {
  it("writes OpenCV matrix YAML", () => {
    const yaml = toOpenCvYaml(result);
    expect(yaml).toContain("%YAML:1.0");
    expect(yaml).toContain("camera_matrix: !!opencv-matrix");
    expect(yaml).toContain("rows: 3");
    expect(yaml).toContain("distortion_coefficients: !!opencv-matrix");
    expect(yaml).toContain("image_width: 1280");
  });

  it("round-trips the versioned JSON", () => {
    expect(JSON.parse(resultJson(result))).toEqual(result);
  });

  it("preserves small values written in scientific notation", () => {
    const yaml = toOpenCvYaml({
      ...result,
      distortion: [1e-10, -2.5e-12, 1.25e20, 0, 0],
    });
    expect(yaml).toContain("1e-10");
    expect(yaml).toContain("-2.5e-12");
    expect(yaml).toContain("1.25e+20");
    expect(yaml).not.toContain("e-1,");
  });
});
