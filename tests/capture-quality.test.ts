import { describe, expect, it } from "vitest";
import { CaptureGate, captureProgress } from "../src/domain/capture-quality";
import type { DetectionResult, FrameObservation } from "../src/domain/types";

function detection(overrides: Partial<DetectionResult["pose"]> = {}): DetectionResult {
  const imagePoints = Array.from({ length: 20 }, (_, index) => ({
    x: 300 + (index % 5) * 50,
    y: 180 + Math.floor(index / 5) * 50,
  }));
  return {
    ok: true,
    imageSize: { width: 1280, height: 720 },
    imagePoints,
    objectPoints: imagePoints.map(({ x, y }) => ({ x, y, z: 0 })),
    pointIds: imagePoints.map((_, index) => index),
    quality: {
      sharpness: 180,
      boardAreaRatio: 0.18,
      minEdgeDistancePx: 100,
      detectedCorners: 20,
      availableCorners: 24,
      basicValid: true,
      messages: [],
    },
    pose: {
      centerX: 0.5,
      centerY: 0.5,
      areaRatio: 0.18,
      planeAngleDegrees: 18,
      coverageCell: 4,
      ...overrides,
    },
  };
}

function observation(index: number): FrameObservation {
  const viewDetection = detection({
    coverageCell: index % 9,
    areaRatio: index < 10 ? 0.05 : 0.2,
    planeAngleDegrees: index < 4 ? 20 : 5,
  });
  return {
    id: `view-${index}`,
    source: "upload",
    createdAt: new Date(0).toISOString(),
    imageSize: viewDetection.imageSize,
    imagePoints: viewDetection.imagePoints,
    objectPoints: viewDetection.objectPoints,
    pointIds: viewDetection.pointIds,
    quality: viewDetection.quality,
    pose: viewDetection.pose,
    imageBlobKey: `image-${index}`,
    thumbnailBlobKey: `thumb-${index}`,
    included: true,
  };
}

describe("CaptureGate", () => {
  it("waits for a stable detection before accepting it", () => {
    const gate = new CaptureGate();
    expect(gate.evaluate(detection(), [], 0).accept).toBe(false);
    expect(gate.evaluate(detection(), [], 200).accept).toBe(false);
    const decision = gate.evaluate(detection(), [], 450);
    expect(decision.stable).toBe(true);
    expect(decision.novel).toBe(true);
    expect(decision.accept).toBe(true);
  });

  it("enforces a cooldown after capture", () => {
    const gate = new CaptureGate();
    gate.evaluate(detection(), [], 0);
    gate.evaluate(detection(), [], 200);
    gate.evaluate(detection(), [], 450);
    gate.markCaptured(450);
    gate.evaluate(detection({ centerX: 0.1 }), [], 600);
    gate.evaluate(detection({ centerX: 0.1 }), [], 1050);
    expect(gate.evaluate(detection({ centerX: 0.1 }), [], 1100).accept).toBe(false);
  });
});

describe("captureProgress", () => {
  it("recognizes a geometrically diverse 20-view set", () => {
    const result = captureProgress(Array.from({ length: 20 }, (_, index) => observation(index)));
    expect(result.accepted).toBe(20);
    expect(result.occupiedCells).toBe(9);
    expect(result.tiltedViews).toBe(4);
    expect(result.scaleRatio).toBe(2);
    expect(result.targetReached).toBe(true);
  });
});
