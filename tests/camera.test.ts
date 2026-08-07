import { beforeEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../src/lib/camera";

function fakeTrack(options: { capabilities?: MediaTrackCapabilities } = {}) {
  const track = {
    label: "Test camera",
    readyState: "live",
    stop: vi.fn(),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn(() => ({
      width: 1280,
      height: 720,
      deviceId: "camera-1",
      frameRate: 30,
      resizeMode: "none",
    })),
    ...(options.capabilities
      ? { getCapabilities: vi.fn(() => options.capabilities) }
      : {}),
  };
  return track;
}

function fakeStream(track: ReturnType<typeof fakeTrack>): MediaStream {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

describe("CameraController", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn() },
      configurable: true,
    });
  });

  it("requests exact dimensions, then falls back to ideal dimensions", async () => {
    const track = fakeTrack({ capabilities: { width: { min: 320, max: 1920 } } });
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce({ name: "OverconstrainedError" })
      .mockResolvedValueOnce(fakeStream(track));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });

    const controller = new CameraController();
    await controller.open({ width: 1920, height: 1080, deviceId: "camera-1" });

    const exact = getUserMedia.mock.calls[0][0].video;
    const fallback = getUserMedia.mock.calls[1][0].video;
    expect(exact.width).toEqual({ exact: 1920 });
    expect(exact.height).toEqual({ exact: 1080 });
    expect(exact.resizeMode).toEqual({ ideal: "none" });
    expect(fallback.width).toEqual({ ideal: 1920 });
    expect(fallback.height).toEqual({ ideal: 1080 });
    expect(controller.settings()).toMatchObject({
      width: 1280,
      height: 720,
      deviceId: "camera-1",
      cameraLabel: "Test camera",
    });
    expect(controller.capabilities()?.width?.max).toBe(1920);
  });

  it("falls back when applying an unsupported exact resolution", async () => {
    const track = fakeTrack();
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream(track));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const controller = new CameraController();
    await controller.open({ width: 1280, height: 720 });
    track.applyConstraints
      .mockRejectedValueOnce(new DOMException("unsupported", "OverconstrainedError"))
      .mockResolvedValueOnce(undefined);

    await controller.applyResolution({ width: 3840, height: 2160 });

    expect(track.applyConstraints.mock.calls[0][0].width).toEqual({ exact: 3840 });
    expect(track.applyConstraints.mock.calls[1][0].width).toEqual({ ideal: 3840 });
    expect(controller.capabilities()).toBeUndefined();
  });
});
