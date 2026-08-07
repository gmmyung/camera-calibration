import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraController } from "../src/lib/camera";

function fakeTrack(
  options: {
    capabilities?: MediaTrackCapabilities;
    settings?: Partial<MediaTrackSettings & { resizeMode: string }>;
  } = {},
) {
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
      ...options.settings,
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
      value: {
        getUserMedia: vi.fn(),
        enumerateDevices: vi.fn(),
        getSupportedConstraints: vi.fn(() => ({ resizeMode: true })),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests exact dimensions without browser cropping or scaling", async () => {
    const track = fakeTrack({
      capabilities: { width: { min: 320, max: 1920 } },
      settings: { width: 1920, height: 1080 },
    });
    const getUserMedia = vi.fn().mockResolvedValueOnce(fakeStream(track));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });

    const controller = new CameraController();
    await controller.open({ width: 1920, height: 1080, deviceId: "camera-1" });

    const exact = getUserMedia.mock.calls[0]![0].video;
    expect(exact.width).toEqual({ exact: 1920 });
    expect(exact.height).toEqual({ exact: 1080 });
    expect(exact.resizeMode).toEqual({ exact: "none" });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(controller.settings()).toMatchObject({
      width: 1920,
      height: 1080,
      deviceId: "camera-1",
      cameraLabel: "Test camera",
    });
    expect(controller.capabilities()?.width?.max).toBe(1920);
  });

  it("does not fall back when an exact resolution is unsupported", async () => {
    const track = fakeTrack();
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream(track));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const controller = new CameraController();
    await controller.open({ width: 1280, height: 720 });
    track.applyConstraints.mockRejectedValueOnce(
      new DOMException("unsupported", "OverconstrainedError"),
    );

    await expect(controller.applyResolution({ width: 3840, height: 2160 })).rejects.toThrow(
      "unsupported",
    );

    expect(track.applyConstraints.mock.calls[0]![0].width).toEqual({ exact: 3840 });
    expect(track.applyConstraints.mock.calls[0]![0].resizeMode).toEqual({ exact: "none" });
    expect(track.applyConstraints).toHaveBeenCalledOnce();
    expect(controller.capabilities()).toBeUndefined();
  });

  it("lets the camera choose its native default when dimensions are omitted", async () => {
    const track = fakeTrack();
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream(track));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });

    await new CameraController().open({ deviceId: "camera-1" });

    const constraints = getUserMedia.mock.calls[0]![0].video;
    expect(constraints.width).toBeUndefined();
    expect(constraints.height).toBeUndefined();
    expect(constraints.resizeMode).toEqual({ exact: "none" });
  });

  it("rejects browsers that cannot guarantee an unscaled stream", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    Object.defineProperty(navigator.mediaDevices, "getSupportedConstraints", {
      value: vi.fn(() => ({ resizeMode: false })),
    });

    await expect(new CameraController().open({})).rejects.toThrow("resizeMode is unsupported");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("retries a transient camera capture failure once", async () => {
    vi.useFakeTimers();
    const track = fakeTrack();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce({
        name: "NotReadableError",
        message: "A MediaStreamTrack ended due to a capture failure",
      })
      .mockResolvedValueOnce(fakeStream(track));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });

    const opening = new CameraController().open({ width: 1280, height: 720 });
    await vi.runAllTimersAsync();
    await opening;

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1]![0].video.width).toEqual({ exact: 1280 });
  });

  it("stops the previous track before opening another camera", async () => {
    vi.useFakeTimers();
    const firstTrack = fakeTrack();
    const secondTrack = fakeTrack({ settings: { width: 1920, height: 1080 } });
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(fakeStream(firstTrack))
      .mockResolvedValueOnce(fakeStream(secondTrack));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const controller = new CameraController();

    const firstOpening = controller.open({ width: 1280, height: 720 });
    await vi.runAllTimersAsync();
    await firstOpening;
    const secondOpening = controller.open({ width: 1920, height: 1080 });

    expect(firstTrack.stop).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await secondOpening;
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("does not retry after stop cancels a pending recovery", async () => {
    vi.useFakeTimers();
    const getUserMedia = vi.fn().mockRejectedValue({
      name: "NotReadableError",
      message: "A MediaStreamTrack ended due to a capture failure",
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const controller = new CameraController();
    const opening = controller.open({ width: 1280, height: 720 });
    const rejection = expect(opening).rejects.toThrow("cancelled");

    await Promise.resolve();
    controller.stop();
    await vi.runAllTimersAsync();

    await rejection;
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("stops a stream that arrives after the operation was cancelled", async () => {
    vi.useFakeTimers();
    const track = fakeTrack();
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const controller = new CameraController();
    const opening = controller.open({ width: 1280, height: 720 });
    const rejection = expect(opening).rejects.toThrow("cancelled");

    controller.stop();
    resolveStream?.(fakeStream(track));
    await vi.runAllTimersAsync();

    await rejection;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(controller.currentStream()).toBeUndefined();
  });

  it("ignores a camera adjustment that completes after stop", async () => {
    vi.useFakeTimers();
    const track = fakeTrack();
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream(track));
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const controller = new CameraController();
    const opening = controller.open({ width: 1280, height: 720 });
    await vi.runAllTimersAsync();
    await opening;

    let finishAdjustment: (() => void) | undefined;
    track.applyConstraints.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishAdjustment = resolve;
        }),
    );
    const adjustment = controller.applyZoom(2);
    const rejection = expect(adjustment).rejects.toThrow("cancelled");
    controller.stop();
    finishAdjustment?.();

    await rejection;
  });
});
