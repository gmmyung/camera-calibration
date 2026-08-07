import { afterEach, describe, expect, it, vi } from "vitest";
import { groupImageFiles, thumbnailBlob, videoFrameBlob } from "../src/lib/images";

describe("image input validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes decoded images that exceed the pixel limit", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 20_000, height: 3_000, close }),
    );
    const file = new File(["image"], "large.webp", { type: "image/webp" });

    await expect(groupImageFiles([file])).rejects.toThrow("40-megapixel limit");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects video frames without active dimensions", async () => {
    const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    await expect(videoFrameBlob(video)).rejects.toThrow("image dimensions are invalid");
  });

  it("rejects invalid thumbnail sizes before decoding", async () => {
    const createBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createBitmap);
    await expect(thumbnailBlob(new Blob(["image"]), 0)).rejects.toThrow(
      "Thumbnail size must be greater than zero",
    );
    expect(createBitmap).not.toHaveBeenCalled();
  });
});
