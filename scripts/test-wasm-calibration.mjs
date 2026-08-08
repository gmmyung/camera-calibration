import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import createCalibrationModule from "../public/wasm/calibration.js";

const width = 1280;
const height = 720;
const intrinsics = { fx: 610, fy: 605, cx: 640, cy: 360 };
const distortion = [-0.04, 0.006, -0.0005, 0.00005];

const objectPoints = [];
for (let row = 0; row < 6; row += 1) {
  for (let column = 0; column < 9; column += 1) {
    objectPoints.push({
      x: (column - 4) * 0.035,
      y: (row - 2.5) * 0.035,
      z: 0,
    });
  }
}
const pointIds = objectPoints.map((_, index) => index);

function rotationMatrix(x, y, z) {
  const sx = Math.sin(x);
  const cx = Math.cos(x);
  const sy = Math.sin(y);
  const cy = Math.cos(y);
  const sz = Math.sin(z);
  const cz = Math.cos(z);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

function project(point, rotation, translation) {
  const cameraX =
    rotation[0][0] * point.x + rotation[0][1] * point.y + translation[0];
  const cameraY =
    rotation[1][0] * point.x + rotation[1][1] * point.y + translation[1];
  const cameraZ =
    rotation[2][0] * point.x + rotation[2][1] * point.y + translation[2];
  const normalizedX = cameraX / cameraZ;
  const normalizedY = cameraY / cameraZ;
  const radius = Math.hypot(normalizedX, normalizedY);
  const theta = Math.atan(radius);
  const theta2 = theta ** 2;
  const distortedTheta =
    theta *
    (1 +
      distortion[0] * theta2 +
      distortion[1] * theta2 ** 2 +
      distortion[2] * theta2 ** 3 +
      distortion[3] * theta2 ** 4);
  const scale = radius > 0 ? distortedTheta / radius : 1;
  return {
    x: intrinsics.fx * normalizedX * scale + intrinsics.cx,
    y: intrinsics.fy * normalizedY * scale + intrinsics.cy,
  };
}

const validViews = Array.from({ length: 22 }, (_, index) => {
  const rotation = rotationMatrix(
    -0.35 + (index % 4) * 0.22,
    -0.4 + (index % 5) * 0.18,
    -0.12 + (index % 3) * 0.1,
  );
  const translation = [
    ((index % 3) - 1) * 0.065,
    ((index % 4) - 1.5) * 0.035,
    0.55 + (index % 4) * 0.08,
  ];
  return {
    id: `valid-${index}`,
    objectPoints,
    pointIds,
    imagePoints: objectPoints.map((point) => project(point, rotation, translation)),
  };
});

const compressedSource = validViews[4].imagePoints;
const illConditionedView = {
  id: "ill-conditioned",
  objectPoints,
  pointIds,
  imagePoints: compressedSource.map((point) => ({
    x: intrinsics.cx + (point.x - intrinsics.cx) * 1e-6,
    y: intrinsics.cy + (point.y - intrinsics.cy) * 1e-6,
  })),
};
const initExtrinsicsFailureView = {
  id: "init-extrinsics-failure",
  objectPoints,
  pointIds,
  imagePoints: objectPoints.map(() => ({ x: intrinsics.cx, y: intrinsics.cy })),
};
const observations = [...validViews];
observations.splice(3, 0, initExtrinsicsFailureView);
observations.splice(20, 0, illConditionedView);

const wasmBinary = await readFile(new URL("../public/wasm/calibration.wasm", import.meta.url));
const module = await createCalibrationModule({ wasmBinary, noInitialRun: true });

function callNative(operation) {
  try {
    return operation();
  } catch (error) {
    if (typeof error === "number") {
      try {
        throw new Error(module.getExceptionMessage(error).at(-1) ?? "Native operation failed.");
      } finally {
        module.decrementExceptionRefcount(error);
      }
    }
    throw error;
  }
}

function nativeError(operation) {
  try {
    callNative(operation);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("Expected the native operation to fail.");
}

const result = callNative(() =>
  module.solveCalibration(observations, "fisheye-kb4", width, height),
);

assert.equal(result.includedViewIds.length, validViews.length);
assert.deepEqual(result.excludedViewIds, [initExtrinsicsFailureView.id, illConditionedView.id]);
assert.equal(Object.hasOwn(result.perViewErrors, initExtrinsicsFailureView.id), false);
assert.equal(Object.hasOwn(result.perViewErrors, illConditionedView.id), false);
assert.equal(Number.isFinite(result.rmsReprojectionError), true);
assert.ok(result.rmsReprojectionError < 0.01);
assert.equal(result.previewCameraMatrix.length, 9);
assert.equal(result.previewCameraMatrix.every(Number.isFinite), true);
assert.ok(result.previewCameraMatrix[0] > 0);
assert.ok(result.previewCameraMatrix[4] > 0);
assert.equal(Object.keys(result.residuals).length, validViews.length);
for (const view of validViews) {
  assert.equal(result.residuals[view.id].length, objectPoints.length);
  assert.equal(result.residuals[view.id].every((residual) => Number.isFinite(residual.magnitude)), true);
}
assert.equal(result.stability.method, "leave-one-view-out");
assert.equal(result.stability.attemptedSamples, 12);
assert.ok(result.stability.successfulSamples >= 3);
assert.equal(result.stability.standardDeviations.length, 8);
assert.equal(result.stability.maxAbsoluteDeltas.length, 8);

assert.match(
  nativeError(() =>
    module.solveCalibration(
      [...validViews.slice(0, 11), initExtrinsicsFailureView],
      "fisheye-kb4",
      width,
      height,
    ),
  ),
  /cannot use view "init-extrinsics-failure"/,
);

const preview = callNative(() =>
  module.undistortFrame(new Uint8Array(width * height * 4), width, height, {
    model: "fisheye-kb4",
    imageSize: { width, height },
    cameraMatrix: result.cameraMatrix,
    distortion: result.distortion,
  }),
);
assert.equal(preview.ok, true);
assert.equal(preview.width, width);
assert.equal(preview.height, height);
assert.equal(preview.rgba.byteLength, width * height * 4);

const duplicateIds = validViews.slice(0, 12).map((view) => ({ ...view, id: "duplicate" }));
assert.match(
  nativeError(() => module.solveCalibration(duplicateIds, "pinhole-radtan5", width, height)),
  /identifiers must be non-empty and unique/,
);
assert.match(
  nativeError(() => module.solveCalibration(validViews.slice(0, 12), "pinhole-radtan5", 0, height)),
  /Invalid image dimensions/,
);
assert.match(
  nativeError(() =>
    module.generatePatternSvg({
      kind: "chessboard",
      innerCornersX: 3.5,
      innerCornersY: 6,
      squareLengthMm: 24,
    }),
  ),
  /whole number between 3 and 30/,
);
const displayPattern = callNative(() =>
  module.generateDisplayPatternSvg({
    kind: "charuco",
    squaresX: 5,
    squaresY: 7,
    squareLengthMm: 30,
    markerLengthMm: 21,
    dictionary: "DICT_5X5_100",
    legacyPattern: false,
  }, 150, 105),
);
assert.match(displayPattern, /width="750" height="1050"/);
assert.doesNotMatch(displayPattern, /print at actual size/);
assert.match(
  nativeError(() =>
    module.generateDisplayPatternSvg({
      kind: "charuco",
      squaresX: 5,
      squaresY: 7,
      squareLengthMm: 30,
      markerLengthMm: 21,
      dictionary: "DICT_5X5_100",
      legacyPattern: false,
    }, 150, 150),
  ),
  /smaller than a square/,
);
assert.match(
  nativeError(() =>
    module.generateDisplayPatternSvg({
      kind: "charuco",
      squaresX: 5,
      squaresY: 7,
      squareLengthMm: 30,
      markerLengthMm: 21,
      dictionary: "DICT_5X5_100",
      legacyPattern: false,
    }, 150, 106),
  ),
  /complete marker modules/,
);
assert.match(
  nativeError(() =>
    module.detectFrame(new Uint8Array(4), 10_000, 10_000, {
      kind: "chessboard",
      innerCornersX: 9,
      innerCornersY: 6,
      squareLengthMm: 24,
    }),
  ),
  /20-megapixel native processing limit/,
);

console.log("WASM calibration and native input guards passed.");
