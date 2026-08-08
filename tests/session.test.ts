import { describe, expect, it } from "vitest";
import { CHARUCO_PRESET } from "../src/domain/patterns";
import { parseStoredSession } from "../src/domain/session";
import type { CalibrationSessionV1, FrameObservation } from "../src/domain/types";

const observation: FrameObservation = {
  id: "view-1",
  source: "upload",
  sourceName: "frame.webp",
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
    minEdgeDistancePx: 100,
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
    coverageCell: 4,
  },
  imageBlobKey: "image-1",
  thumbnailBlobKey: "thumbnail-1",
  included: true,
};

const session: CalibrationSessionV1 = {
  schemaVersion: 1,
  id: "session-1",
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  step: "review",
  lensModel: "pinhole-radtan5",
  pattern: CHARUCO_PRESET,
  imageSize: { width: 1280, height: 720 },
  observations: [observation],
};

describe("stored session validation", () => {
  it("accepts a valid session", () => {
    expect(parseStoredSession(session)).toEqual(session);
  });

  it("converts legacy physical coordinates to board-square units", () => {
    const legacy = {
      ...session,
      pattern: { ...CHARUCO_PRESET, squareLengthMm: 30, markerLengthMm: 21 },
      observations: [{
        ...observation,
        objectPoints: observation.objectPoints.map((point) => ({
          x: point.x * 30,
          y: point.y * 30,
          z: point.z * 30,
        })),
      }],
    };
    const parsed = parseStoredSession(legacy);
    expect(parsed?.pattern).toEqual(CHARUCO_PRESET);
    expect(parsed?.observations[0]?.objectPoints).toEqual(observation.objectPoints);
    expect(parsed?.pattern).not.toHaveProperty("squareLengthMm");
  });

  it("rejects mismatched point arrays and duplicate IDs", () => {
    expect(
      parseStoredSession({
        ...session,
        observations: [{ ...observation, pointIds: [0, 1, 2] }],
      }),
    ).toBeUndefined();
    expect(
      parseStoredSession({
        ...session,
        observations: [observation, { ...observation }],
      }),
    ).toBeUndefined();
    expect(
      parseStoredSession({
        ...session,
        observations: [{ ...observation, thumbnailBlobKey: observation.imageBlobKey }],
      }),
    ).toBeUndefined();
  });

  it("rejects non-finite values, invalid patterns, and inconsistent image sizes", () => {
    expect(
      parseStoredSession({
        ...session,
        observations: [
          {
            ...observation,
            imagePoints: [{ x: Number.NaN, y: 0 }, ...observation.imagePoints.slice(1)],
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      parseStoredSession({
        ...session,
        observations: [{ ...observation, pose: { ...observation.pose, centerX: 2 } }],
      }),
    ).toBeUndefined();
    expect(
      parseStoredSession({
        ...session,
        observations: [
          {
            ...observation,
            imagePoints: [{ x: 10_000, y: 100 }, ...observation.imagePoints.slice(1)],
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      parseStoredSession({ ...session, pattern: { ...CHARUCO_PRESET, squaresX: 3.5 } }),
    ).toBeUndefined();
    expect(
      parseStoredSession({
        ...session,
        observations: [{ ...observation, imageSize: { width: 640, height: 480 } }],
      }),
    ).toBeUndefined();
  });

  it("rejects a results step without a calibration result", () => {
    expect(parseStoredSession({ ...session, step: "results" })).toBeUndefined();
    expect(parseStoredSession({ ...session, imageSize: undefined })).toBeUndefined();
  });

  it("accepts a complete result and rejects inconsistent result metadata", () => {
    const observations = Array.from({ length: 12 }, (_, index) => ({
      ...observation,
      id: `view-${index}`,
      imageBlobKey: `image-${index}`,
      thumbnailBlobKey: `thumbnail-${index}`,
    }));
    const includedViewIds = observations.map(({ id }) => id);
    const result = {
      schemaVersion: 1 as const,
      generator: { appVersion: "test", opencvVersion: "4.13.0" },
      createdAt: "2026-08-07T00:00:00.000Z",
      model: "pinhole-radtan5" as const,
      imageSize: { width: 1280, height: 720 },
      cameraMatrix: [900, 0, 640, 0, 900, 360, 0, 0, 1],
      distortion: [0, 0, 0, 0, 0],
      rmsReprojectionError: 0.3,
      perViewErrors: Object.fromEntries(includedViewIds.map((id) => [id, 0.3])),
      includedViewIds,
      excludedViewIds: [],
      board: CHARUCO_PRESET,
      poses: includedViewIds.map((viewId) => ({
        viewId,
        rotationVector: [0, 0, 0],
        translationVector: [0, 0, 1],
      })),
      residuals: Object.fromEntries(observations.map((view) => [
        view.id,
        view.imagePoints.map((observed, pointIndex) => ({
          pointId: view.pointIds[pointIndex],
          observed,
          projected: { x: observed.x + 0.25, y: observed.y },
          magnitude: 0.25,
        })),
      ])),
      stability: {
        method: "leave-one-view-out" as const,
        attemptedSamples: 12,
        successfulSamples: 12,
        standardDeviations: [1, 1, 0.5, 0.5, 0.001, 0.001, 0.001, 0.001, 0.001],
        maxAbsoluteDeltas: [2, 2, 1, 1, 0.002, 0.002, 0.002, 0.002, 0.002],
      },
    };
    const completed = { ...session, step: "results", observations, result };
    expect(parseStoredSession(completed)).toEqual(completed);
    const legacyCompleted = {
      ...completed,
      pattern: { ...CHARUCO_PRESET, squareLengthMm: 30, markerLengthMm: 21 },
      observations: observations.map((view) => ({
        ...view,
        objectPoints: view.objectPoints.map((point) => ({
          x: point.x * 30,
          y: point.y * 30,
          z: point.z * 30,
        })),
      })),
      result: {
        ...result,
        board: { ...CHARUCO_PRESET, squareLengthMm: 30, markerLengthMm: 21 },
        poses: result.poses.map((pose) => ({
          ...pose,
          translationVector: [0, 0, 30],
        })),
      },
    };
    const normalizedLegacy = parseStoredSession(legacyCompleted);
    expect(normalizedLegacy?.result?.poses[0]?.translationVector).toEqual([0, 0, 1]);
    expect(normalizedLegacy?.result?.board).toEqual(CHARUCO_PRESET);
    expect(
      parseStoredSession({
        ...completed,
        result: { ...result, board: { ...CHARUCO_PRESET, squaresX: 6 } },
      }),
    ).toBeUndefined();
    expect(
      parseStoredSession({
        ...completed,
        result: {
          ...result,
          perViewErrors: Object.fromEntries(includedViewIds.slice(1).map((id) => [id, 0.3])),
        },
      }),
    ).toBeUndefined();
    expect(
      parseStoredSession({
        ...completed,
        result: {
          ...result,
          residuals: {
            ...result.residuals,
            [includedViewIds[0]!]: result.residuals[includedViewIds[0]!]!.map((residual) => ({
              ...residual,
              observed: { x: residual.observed.x + 10, y: residual.observed.y },
              projected: { x: residual.projected.x + 10, y: residual.projected.y },
            })),
          },
        },
      }),
    ).toBeUndefined();
  });
});
