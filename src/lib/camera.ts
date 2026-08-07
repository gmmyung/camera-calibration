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

function isOverconstrained(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "OverconstrainedError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "OverconstrainedError")
  );
}

export class CameraController {
  private stream?: MediaStream;
  private track?: MediaStreamTrack;

  async open(request: CameraRequest): Promise<MediaStream> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support camera capture. You can still import images.");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints(request, true),
      });
    } catch (error) {
      if (!isOverconstrained(error)) throw error;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints(request, false),
      });
    }
    this.track = this.stream.getVideoTracks()[0];
    return this.stream;
  }

  async applyResolution(size: ImageSize): Promise<CameraSettingsSnapshot> {
    const track = this.requireTrack();
    try {
      await track.applyConstraints({
        width: { exact: size.width },
        height: { exact: size.height },
        resizeMode: { ideal: "none" },
      } as ExtendedConstraints);
    } catch (error) {
      if (!isOverconstrained(error)) throw error;
      await track.applyConstraints({
        width: { ideal: size.width },
        height: { ideal: size.height },
        resizeMode: { ideal: "none" },
      } as ExtendedConstraints);
    }
    return this.settings();
  }

  async applyZoom(zoom: number): Promise<CameraSettingsSnapshot> {
    await this.requireTrack().applyConstraints({ advanced: [{ zoom }] } as ExtendedConstraints);
    return this.settings();
  }

  async applyFocusMode(focusMode: string): Promise<CameraSettingsSnapshot> {
    await this.requireTrack().applyConstraints({ advanced: [{ focusMode }] } as ExtendedConstraints);
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

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.track = undefined;
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
