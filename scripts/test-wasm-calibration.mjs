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
    imagePoints: objectPoints.map((point) => project(point, rotation, translation)),
  };
});

const compressedSource = validViews[4].imagePoints;
const illConditionedView = {
  id: "ill-conditioned",
  objectPoints,
  imagePoints: compressedSource.map((point) => ({
    x: intrinsics.cx + (point.x - intrinsics.cx) * 1e-6,
    y: intrinsics.cy + (point.y - intrinsics.cy) * 1e-6,
  })),
};
const observations = [...validViews];
observations.splice(20, 0, illConditionedView);

const wasmBinary = await readFile(new URL("../public/wasm/calibration.wasm", import.meta.url));
const module = await createCalibrationModule({ wasmBinary, noInitialRun: true });
const result = module.solveCalibration(observations, "fisheye-kb4", width, height);

assert.equal(result.includedViewIds.length, validViews.length);
assert.deepEqual(result.excludedViewIds, [illConditionedView.id]);
assert.equal(Object.hasOwn(result.perViewErrors, illConditionedView.id), false);
assert.equal(Number.isFinite(result.rmsReprojectionError), true);
assert.ok(result.rmsReprojectionError < 0.01);

console.log("Fisheye calibration recovered from an ill-conditioned view.");
