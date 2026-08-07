import type { CameraSettingsSnapshot, ImageSize } from "../domain/types";

export interface CameraRequest {
  width?: number;
  height?: number;
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

interface ExtendedSupportedConstraints extends MediaTrackSupportedConstraints {
  resizeMode?: boolean;
}

type ExtendedSettings = MediaTrackSettings & {
  zoom?: number;
  focusMode?: string;
  resizeMode?: string;
};

function supportsResizeMode(): boolean {
  const supported = navigator.mediaDevices.getSupportedConstraints?.() as
    | ExtendedSupportedConstraints
    | undefined;
  return supported?.resizeMode === true;
}

function unscaledCaptureConstraint(supported: boolean): ExtendedConstraints {
  return supported ? { resizeMode: { exact: "none" } } : {};
}

function videoConstraints(
  request: CameraRequest,
  resizeModeSupported: boolean,
): ExtendedConstraints {
  return {
    deviceId: request.deviceId ? { exact: request.deviceId } : undefined,
    width: request.width === undefined ? undefined : { exact: request.width },
    height: request.height === undefined ? undefined : { exact: request.height },
    frameRate: request.frameRate ? { ideal: request.frameRate } : undefined,
    ...unscaledCaptureConstraint(resizeModeSupported),
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
  if ((request.width === undefined) !== (request.height === undefined)) {
    throw new Error("Camera width and height must be provided together.");
  }
  if (request.width !== undefined && request.height !== undefined) {
    validateImageSize({ width: request.width, height: request.height });
  }
  if (
    request.frameRate !== undefined &&
    (!Number.isFinite(request.frameRate) || request.frameRate <= 0 || request.frameRate > 240)
  ) {
    throw new Error("Camera frame rate must be between 0 and 240 fps.");
  }
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
    const resizeModeSupported = supportsResizeMode();
    const operationId = ++this.operationId;
    const releasedActiveStream = this.releaseActiveStream();
    if (releasedActiveStream) await wait(CAMERA_RELEASE_DELAY_MS);
    this.assertCurrent(operationId);

    const capture = await this.acquireWithRetry(request, operationId, resizeModeSupported);

    this.assertCurrent(operationId, capture.stream);
    this.stream = capture.stream;
    this.track = capture.track;
    return capture.stream;
  }

  async applyResolution(size: ImageSize): Promise<CameraSettingsSnapshot> {
    validateImageSize(size);
    const resizeModeSupported = supportsResizeMode();
    const track = this.requireTrack();
    const operationId = this.operationId;
    await track.applyConstraints({
      width: { exact: size.width },
      height: { exact: size.height },
      ...unscaledCaptureConstraint(resizeModeSupported),
    } as ExtendedConstraints);
    this.assertActiveTrack(operationId, track);
    const settings = this.settings();
    this.assertExactSettings(settings, size, resizeModeSupported);
    return settings;
  }

  async applyZoom(zoom: number): Promise<CameraSettingsSnapshot> {
    if (!Number.isFinite(zoom)) throw new Error("Camera zoom must be a finite number.");
    const track = this.requireTrack();
    const operationId = this.operationId;
    const current = this.settingsForTrack(track);
    const resizeModeSupported = supportsResizeMode();
    await track.applyConstraints({
      width: { exact: current.width },
      height: { exact: current.height },
      ...unscaledCaptureConstraint(resizeModeSupported),
      advanced: [{ zoom }],
    } as ExtendedConstraints);
    this.assertActiveTrack(operationId, track);
    const settings = this.settings();
    this.assertExactSettings(settings, current, resizeModeSupported);
    return settings;
  }

  async applyFocusMode(focusMode: string): Promise<CameraSettingsSnapshot> {
    if (!focusMode) throw new Error("Camera focus mode is required.");
    const track = this.requireTrack();
    const operationId = this.operationId;
    const current = this.settingsForTrack(track);
    const resizeModeSupported = supportsResizeMode();
    await track.applyConstraints({
      width: { exact: current.width },
      height: { exact: current.height },
      ...unscaledCaptureConstraint(resizeModeSupported),
      advanced: [{ focusMode }],
    } as ExtendedConstraints);
    this.assertActiveTrack(operationId, track);
    const settings = this.settings();
    this.assertExactSettings(settings, current, resizeModeSupported);
    return settings;
  }

  capabilities(): ExtendedCapabilities | undefined {
    if (!this.track || typeof this.track.getCapabilities !== "function") return undefined;
    return this.track.getCapabilities() as ExtendedCapabilities;
  }

  settings(): CameraSettingsSnapshot {
    return this.settingsForTrack(this.requireTrack());
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
    operationId: number,
    resizeModeSupported: boolean,
  ): Promise<{ stream: MediaStream; track: MediaStreamTrack }> {
    try {
      return await this.acquire(request, operationId, resizeModeSupported);
    } catch (error) {
      if (!isTransientCaptureFailure(error)) throw error;
      await wait(CAPTURE_RETRY_DELAY_MS);
      this.assertCurrent(operationId);
      return this.acquire(request, operationId, resizeModeSupported);
    }
  }

  private async acquire(
    request: CameraRequest,
    operationId: number,
    resizeModeSupported: boolean,
  ): Promise<{ stream: MediaStream; track: MediaStreamTrack }> {
    this.assertCurrent(operationId);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints(request, resizeModeSupported),
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
    try {
      this.assertExactSettings(
        this.settingsForTrack(track),
        request.width === undefined || request.height === undefined
          ? undefined
          : { width: request.width, height: request.height },
        resizeModeSupported,
      );
    } catch (error) {
      stopStream(stream);
      throw error;
    }
    return { stream, track };
  }

  private settingsForTrack(track: MediaStreamTrack): CameraSettingsSnapshot {
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

  private assertExactSettings(
    settings: CameraSettingsSnapshot,
    requestedSize?: ImageSize,
    resizeModeSupported = supportsResizeMode(),
  ): void {
    if (resizeModeSupported && settings.resizeMode !== "none") {
      throw new Error("The browser did not provide an uncropped, unscaled camera stream.");
    }
    if (
      requestedSize &&
      (settings.width !== requestedSize.width || settings.height !== requestedSize.height)
    ) {
      throw new Error(
        `The camera did not provide the exact requested mode (${requestedSize.width} × ${requestedSize.height}).`,
      );
    }
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
