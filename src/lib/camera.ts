import type { CameraSettingsSnapshot, ImageSize } from "../domain/types";

export interface CameraRequest extends ImageSize {
  deviceId?: string;
  frameRate?: number;
}

export interface NumericCapability {
  min: number;
  max: number;
  step?: number;
}

export type ExtendedCapabilities = MediaTrackCapabilities & {
  zoom?: NumericCapability;
  focusMode?: string[];
};

interface ExtendedConstraintSet extends MediaTrackConstraintSet {
  zoom?: ConstrainDouble;
  focusMode?: ConstrainDOMString;
}

interface ExtendedConstraints extends MediaTrackConstraints {
  resizeMode?: ConstrainDOMString;
  advanced?: ExtendedConstraintSet[];
}

type ExtendedSettings = MediaTrackSettings & {
  zoom?: number;
  focusMode?: string;
  resizeMode?: string;
};

function videoConstraints(request: CameraRequest, exact: boolean): ExtendedConstraints {
  const dimension = (value: number): ConstrainULong =>
    exact ? { exact: value } : { ideal: value };
  return {
    deviceId: request.deviceId ? { exact: request.deviceId } : undefined,
    width: dimension(request.width),
    height: dimension(request.height),
    frameRate: request.frameRate ? { ideal: request.frameRate } : undefined,
    resizeMode: { ideal: "none" },
  };
}

function validateImageSize(size: ImageSize): void {
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > 32_768 ||
    size.height > 32_768
  ) {
    throw new Error("Camera dimensions must be positive whole numbers no larger than 32768.");
  }
}

function validateRequest(request: CameraRequest): void {
  validateImageSize(request);
  if (
    request.frameRate !== undefined &&
    (!Number.isFinite(request.frameRate) || request.frameRate <= 0 || request.frameRate > 240)
  ) {
    throw new Error("Camera frame rate must be between 0 and 240 fps.");
  }
}

function isOverconstrained(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "OverconstrainedError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "OverconstrainedError")
  );
}

const CAMERA_RELEASE_DELAY_MS = 300;
const CAPTURE_RETRY_DELAY_MS = 500;
const TRACK_STARTUP_GRACE_MS = 100;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function errorProperty(error: unknown, property: "name" | "message"): string {
  if (typeof error !== "object" || error === null || !(property in error)) return "";
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : "";
}

function isTransientCaptureFailure(error: unknown): boolean {
  const name = errorProperty(error, "name");
  const message = errorProperty(error, "message");
  return (
    name === "NotReadableError" ||
    name === "AbortError" ||
    /capture failure|could not start (?:the )?video source|starting video failed/i.test(message)
  );
}

function captureFailure(message: string): Error {
  const error = new Error(message);
  error.name = "NotReadableError";
  return error;
}

function stopStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

class CameraOperationCancelledError extends Error {
  constructor() {
    super("The camera operation was cancelled.");
    this.name = "CameraOperationCancelledError";
  }
}

export class CameraController {
  private stream?: MediaStream;
  private track?: MediaStreamTrack;
  private operationId = 0;

  async open(request: CameraRequest): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support camera capture. You can still import images.");
    }

    validateRequest(request);
    const operationId = ++this.operationId;
    const releasedActiveStream = this.releaseActiveStream();
    if (releasedActiveStream) await wait(CAMERA_RELEASE_DELAY_MS);
    this.assertCurrent(operationId);

    let capture: { stream: MediaStream; track: MediaStreamTrack };
    try {
      capture = await this.acquireWithRetry(request, true, operationId);
    } catch (error) {
      if (!isOverconstrained(error)) throw error;
      capture = await this.acquireWithRetry(request, false, operationId);
    }

    this.assertCurrent(operationId, capture.stream);
    this.stream = capture.stream;
    this.track = capture.track;
    return capture.stream;
  }

  async applyResolution(size: ImageSize): Promise<CameraSettingsSnapshot> {
    validateImageSize(size);
    const track = this.requireTrack();
    const operationId = this.operationId;
    try {
      await track.applyConstraints({
        width: { exact: size.width },
        height: { exact: size.height },
        resizeMode: { ideal: "none" },
      } as ExtendedConstraints);
    } catch (error) {
      if (!isOverconstrained(error)) throw error;
      this.assertActiveTrack(operationId, track);
      await track.applyConstraints({
        width: { ideal: size.width },
        height: { ideal: size.height },
        resizeMode: { ideal: "none" },
      } as ExtendedConstraints);
    }
    this.assertActiveTrack(operationId, track);
    return this.settings();
  }

  async applyZoom(zoom: number): Promise<CameraSettingsSnapshot> {
    if (!Number.isFinite(zoom)) throw new Error("Camera zoom must be a finite number.");
    const track = this.requireTrack();
    const operationId = this.operationId;
    await track.applyConstraints({ advanced: [{ zoom }] } as ExtendedConstraints);
    this.assertActiveTrack(operationId, track);
    return this.settings();
  }

  async applyFocusMode(focusMode: string): Promise<CameraSettingsSnapshot> {
    if (!focusMode) throw new Error("Camera focus mode is required.");
    const track = this.requireTrack();
    const operationId = this.operationId;
    await track.applyConstraints({ advanced: [{ focusMode }] } as ExtendedConstraints);
    this.assertActiveTrack(operationId, track);
    return this.settings();
  }

  capabilities(): ExtendedCapabilities | undefined {
    if (!this.track || typeof this.track.getCapabilities !== "function") return undefined;
    return this.track.getCapabilities() as ExtendedCapabilities;
  }

  settings(): CameraSettingsSnapshot {
    const track = this.requireTrack();
    const settings = track.getSettings() as ExtendedSettings;
    if (!settings.width || !settings.height) {
      throw new Error("The browser did not report the active camera dimensions.");
    }
    return {
      width: settings.width,
      height: settings.height,
      deviceId: settings.deviceId,
      frameRate: settings.frameRate,
      aspectRatio: settings.aspectRatio,
      facingMode: settings.facingMode,
      resizeMode: settings.resizeMode,
      zoom: settings.zoom,
      focusMode: settings.focusMode,
      cameraLabel: track.label || undefined,
    };
  }

  currentStream(): MediaStream | undefined {
    return this.stream;
  }

  stop(): boolean {
    this.operationId += 1;
    return this.releaseActiveStream();
  }

  private releaseActiveStream(): boolean {
    const activeStream = this.stream;
    this.stream = undefined;
    this.track = undefined;
    stopStream(activeStream);
    return Boolean(activeStream);
  }

  private async acquireWithRetry(
    request: CameraRequest,
    exact: boolean,
    operationId: number,
  ): Promise<{ stream: MediaStream; track: MediaStreamTrack }> {
    try {
      return await this.acquire(request, exact, operationId);
    } catch (error) {
      if (!isTransientCaptureFailure(error)) throw error;
      await wait(CAPTURE_RETRY_DELAY_MS);
      this.assertCurrent(operationId);
      return this.acquire(request, exact, operationId);
    }
  }

  private async acquire(
    request: CameraRequest,
    exact: boolean,
    operationId: number,
  ): Promise<{ stream: MediaStream; track: MediaStreamTrack }> {
    this.assertCurrent(operationId);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints(request, exact),
    });
    this.assertCurrent(operationId, stream);
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stopStream(stream);
      throw captureFailure("The camera returned no video track.");
    }

    await wait(TRACK_STARTUP_GRACE_MS);
    this.assertCurrent(operationId, stream);
    if (track.readyState === "ended") {
      stopStream(stream);
      throw captureFailure("The camera video track ended while starting.");
    }
    return { stream, track };
  }

  private assertCurrent(operationId: number, stream?: MediaStream): void {
    if (operationId === this.operationId) return;
    stopStream(stream);
    throw new CameraOperationCancelledError();
  }

  private assertActiveTrack(operationId: number, track: MediaStreamTrack): void {
    if (
      operationId === this.operationId &&
      track === this.track &&
      track.readyState !== "ended"
    ) {
      return;
    }
    throw new CameraOperationCancelledError();
  }

  private requireTrack(): MediaStreamTrack {
    if (!this.track || this.track.readyState === "ended") {
      throw new Error("No active camera stream.");
    }
    return this.track;
  }
}

export async function listVideoDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}

export const RESOLUTION_PRESETS: ReadonlyArray<ImageSize & { label: string }> = [
  { width: 640, height: 480, label: "640 × 480" },
  { width: 1280, height: 720, label: "1280 × 720" },
  { width: 1920, height: 1080, label: "1920 × 1080" },
  { width: 3840, height: 2160, label: "3840 × 2160" },
];
