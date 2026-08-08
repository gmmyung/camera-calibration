// @vitest-environment node

import { strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHARUCO_PRESET } from "../src/domain/patterns";
import type { CalibrationSessionV1, FrameObservation } from "../src/domain/types";

const storedBlobs = vi.hoisted(() => new Map<string, Blob>());

vi.mock("../src/lib/session-db", () => ({
  getSessionBlob: async (key: string) => storedBlobs.get(key),
}));

import { createSessionPackage, readSessionPackage } from "../src/lib/session-package";

const observation: FrameObservation = {
  id: "view-1",
  source: "upload",
  sourceName: "frame.png",
  createdAt: "2026-08-07T00:00:00.000Z",
  imageSize: { width: 640, height: 480 },
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
    coverageCell: 4,
  },
  imageBlobKey: "view-1-image",
  thumbnailBlobKey: "view-1-thumbnail",
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
  imageSize: { width: 640, height: 480 },
  observations: [observation],
};

describe("portable session packages", () => {
  beforeEach(() => {
    storedBlobs.clear();
    storedBlobs.set(observation.imageBlobKey, new Blob(["full frame"], { type: "image/png" }));
    storedBlobs.set(observation.thumbnailBlobKey, new Blob(["thumbnail"], { type: "image/webp" }));
  });

  it("round-trips session metadata and image blobs", async () => {
    const archive = await createSessionPackage(session);
    const imported = await readSessionPackage(archive);

    expect(imported.session).toEqual(session);
    expect(imported.blobs.map(([key]) => key)).toEqual([
      observation.imageBlobKey,
      observation.thumbnailBlobKey,
    ]);
    expect(await imported.blobs[0]![1].text()).toBe("full frame");
    expect(imported.blobs[0]![1].type).toBe("image/png");
    expect(await imported.blobs[1]![1].text()).toBe("thumbnail");
  });

  it("rejects non-ZIP and empty input", async () => {
    await expect(readSessionPackage(new Blob(["not a zip"]))).rejects.toThrow(
      "not a valid session package",
    );
    await expect(readSessionPackage(new Blob([]))).rejects.toThrow(
      "must be no larger than 350 MB",
    );
  });

  it("fails export when saved image data is missing", async () => {
    storedBlobs.delete(observation.imageBlobKey);
    await expect(createSessionPackage(session)).rejects.toThrow("Saved image data is missing");
  });

  it("rejects archive entries that are not declared by the manifest", async () => {
    const archive = await createSessionPackage(session);
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    entries["extra.txt"] = strToU8("extra");
    const zipped = zipSync(entries, { level: 0 });
    const owned = new Uint8Array(zipped.byteLength);
    owned.set(zipped);
    const modified = new Blob([owned.buffer]);

    await expect(readSessionPackage(modified)).rejects.toThrow("undeclared archive entries");
  });
});
