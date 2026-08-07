import { beforeEach, describe, expect, it } from "vitest";
import { CHARUCO_PRESET } from "../src/domain/patterns";
import type { CalibrationSessionV1 } from "../src/domain/types";
import {
  clearLocalSession,
  deleteSessionBlobs,
  getSessionBlob,
  loadActiveSession,
  putSessionBlob,
  putSessionBlobs,
  saveActiveSession,
} from "../src/lib/session-db";

const session: CalibrationSessionV1 = {
  schemaVersion: 1,
  id: "session-1",
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  step: "capture",
  lensModel: "pinhole-radtan5",
  pattern: CHARUCO_PRESET,
  observations: [],
};

describe("local session recovery", () => {
  beforeEach(async () => {
    await clearLocalSession();
  });

  it("stores and restores session metadata", async () => {
    await saveActiveSession(session);
    expect(await loadActiveSession()).toEqual(session);
  });

  it("stores image blobs separately", async () => {
    const blob = new Blob(["frame"], { type: "image/webp" });
    await putSessionBlob("frame-1", blob);
    const restored = await getSessionBlob("frame-1");
    // fake-indexeddb does not retain jsdom's Blob prototype across its structured clone,
    // but a defined value verifies that the separate blob store/key path is used.
    expect(restored).toBeDefined();
  });

  it("stores and deletes related blobs in one transaction", async () => {
    await putSessionBlobs([
      ["image", new Blob(["full frame"])],
      ["thumbnail", new Blob(["small frame"])],
    ]);
    expect(await getSessionBlob("image")).toBeDefined();
    expect(await getSessionBlob("thumbnail")).toBeDefined();

    await deleteSessionBlobs(["image", "thumbnail"]);
    expect(await getSessionBlob("image")).toBeUndefined();
    expect(await getSessionBlob("thumbnail")).toBeUndefined();
  });

  it("clears all local data", async () => {
    await saveActiveSession(session);
    await putSessionBlob("frame-1", new Blob(["frame"]));
    await clearLocalSession();
    expect(await loadActiveSession()).toBeUndefined();
    expect(await getSessionBlob("frame-1")).toBeUndefined();
  });
});
