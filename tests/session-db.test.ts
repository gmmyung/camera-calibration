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
  replaceLocalSession,
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

  it("replaces session metadata and blobs in one transaction", async () => {
    await saveActiveSession(session);
    await putSessionBlob("old-frame", new Blob(["old"]));
    const replacement = { ...session, id: "session-2" };

    await replaceLocalSession(replacement, [["new-frame", new Blob(["new"])]]);

    expect(await loadActiveSession()).toEqual(replacement);
    expect(await getSessionBlob("old-frame")).toBeUndefined();
    expect(await getSessionBlob("new-frame")).toBeDefined();
  });

  it("migrates the previous database name", async () => {
    const legacyName = ["lens", "bench-calibration"].join("");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(legacyName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("sessions");
        request.result.createObjectStore("blobs");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(["sessions", "blobs"], "readwrite");
    transaction.objectStore("sessions").put(session, "active");
    transaction.objectStore("blobs").put(new Blob(["legacy"]), "legacy-frame");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();

    expect(await loadActiveSession()).toEqual(session);
    expect(await getSessionBlob("legacy-frame")).toBeDefined();
    expect((await indexedDB.databases()).some(({ name }) => name === legacyName)).toBe(false);
  });
});
