import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  CaptureGate,
  captureProgress,
  isUsableDetection,
  type CaptureDecision,
} from "../domain/capture-quality";
import {
  CHARUCO_PRESET,
  CHESSBOARD_PRESET,
  MAX_PATTERN_GRID_SIZE,
  MAX_PATTERN_LENGTH_MM,
  clonePattern,
  patternLabel,
  validatePattern,
} from "../domain/patterns";
import { parseStoredSession } from "../domain/session";
import {
  DICTIONARY_NAMES,
  type AppStep,
  type CalibrationResultV1,
  type CalibrationSessionV1,
  type CameraSettingsSnapshot,
  type DetectionResult,
  type FrameObservation,
  type ImageSize,
  type LensModel,
  type PatternConfig,
} from "../domain/types";
import {
  CameraController,
  listVideoDevices,
} from "../lib/camera";
import {
  downloadBlob,
  downloadText,
  resultJson,
  toOpenCvYaml,
  toRosCameraInfoYaml,
} from "../lib/exports";
import { createId } from "../lib/ids";
import {
  decodeImage,
  groupImageFiles,
  thumbnailBlob,
  videoFrameBlob,
  type ImageFileGroup,
} from "../lib/images";
import {
  clearLocalSession,
  deleteSessionBlobs,
  loadActiveSession,
  putSessionBlobs,
  replaceLocalSession,
  saveActiveSession,
  storageHeadroom,
} from "../lib/session-db";
import { createSessionPackage, readSessionPackage } from "../lib/session-package";
import { WebGlUndistortRenderer } from "../lib/undistort-webgl";
import { CalibrationWorkerClient } from "../worker/client";
import { CalibrationDiagnostics } from "./CalibrationDiagnostics";
import { ObservationThumbnail } from "./ObservationThumbnail";
import { ValidationImagePreview } from "./ValidationImagePreview";

const MAX_SESSION_VIEWS = 100;
const MAX_INCLUDED_VIEWS = 30;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
const MAX_CAMERA_DIMENSION = 32_768;
const MAX_CAMERA_PIXELS = 40_000_000;

interface ResolutionDraft {
  width: string;
  height: string;
}

type ExportFormat = "json" | "opencv-yaml" | "ros-yaml" | "session-package";

function parseResolutionDraft(draft: ResolutionDraft): {
  size?: ImageSize;
  error?: string;
} {
  const widthText = draft.width.trim();
  const heightText = draft.height.trim();
  if (!widthText && !heightText) return {};
  if (!widthText || !heightText) return { error: "Enter both width and height." };
  const width = Number(widthText);
  const height = Number(heightText);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_CAMERA_DIMENSION ||
    height > MAX_CAMERA_DIMENSION
  ) {
    return { error: `Width and height must be whole numbers from 1 to ${MAX_CAMERA_DIMENSION}.` };
  }
  if (width * height > MAX_CAMERA_PIXELS) {
    return { error: "The requested mode exceeds the 40-megapixel processing limit." };
  }
  return { size: { width, height } };
}

class SessionOperationCancelledError extends Error {
  constructor() {
    super("The session changed before the operation completed.");
    this.name = "SessionOperationCancelledError";
  }
}

function isOperationCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  return (
    error.name === "SessionOperationCancelledError" ||
    error.name === "CameraOperationCancelledError"
  );
}

function freshSession(): CalibrationSessionV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: createId("session"),
    createdAt: now,
    updatedAt: now,
    step: "setup",
    lensModel: "pinhole-radtan5",
    pattern: clonePattern(CHARUCO_PRESET),
    observations: [],
  };
}

function updated(
  previous: CalibrationSessionV1,
  changes: Partial<CalibrationSessionV1>,
): CalibrationSessionV1 {
  return { ...previous, ...changes, updatedAt: new Date().toISOString() };
}

function errorText(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
      ? error.name
      : "";
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : "";
  if (name === "NotAllowedError") {
    return "Camera permission was denied. You can enable it in the browser's site settings or import images.";
  }
  if (name === "NotFoundError") {
    return "No matching camera was found.";
  }
  if (name === "OverconstrainedError") {
    return "The camera does not provide that exact mode. Try another mode or leave width and height blank.";
  }
  if (
    name === "NotReadableError" ||
    name === "AbortError" ||
    /capture failure|could not start (?:the )?video source|starting video failed/i.test(message)
  ) {
    return "Camera capture failed. Close other apps using the camera, reconnect it if needed, and try again.";
  }
  if (error instanceof Error) return error.message;
  if (message) return message;
  return String(error);
}

function sameSize(left?: ImageSize, right?: ImageSize): boolean {
  return Boolean(left && right && left.width === right.width && left.height === right.height);
}

function cameraPipelineChanged(
  previous: CameraSettingsSnapshot | undefined,
  next: CameraSettingsSnapshot,
): boolean {
  if (!previous) return false;
  if (!sameSize(previous, next)) return true;
  if (previous.deviceId && next.deviceId && previous.deviceId !== next.deviceId) return true;
  if (
    (!previous.deviceId || !next.deviceId) &&
    previous.cameraLabel &&
    next.cameraLabel &&
    previous.cameraLabel !== next.cameraLabel
  ) {
    return true;
  }
  return (
    previous.zoom !== next.zoom ||
    previous.focusMode !== next.focusMode ||
    previous.resizeMode !== next.resizeMode
  );
}

function humanBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Stepper({ step }: { step: AppStep }) {
  const steps: Array<{ id: AppStep; label: string }> = [
    { id: "setup", label: "Set up" },
    { id: "capture", label: "Capture" },
    { id: "review", label: "Review" },
    { id: "results", label: "Results" },
  ];
  const activeIndex = steps.findIndex((candidate) => candidate.id === step);
  return (
    <ol class="stepper" aria-label="Calibration progress">
      {steps.map((candidate, index) => (
        <li
          key={candidate.id}
          class={index === activeIndex ? "active" : index < activeIndex ? "complete" : ""}
          aria-current={index === activeIndex ? "step" : undefined}
        >
          <span>{index + 1}</span>
          {candidate.label}
        </li>
      ))}
    </ol>
  );
}

function Status({
  children,
  tone = "info",
}: {
  children: ComponentChildren;
  tone?: "info" | "error";
}) {
  return (
    <div class={`status status-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function PatternEditor({
  pattern,
  onChange,
  errors,
  workerReady,
  onDownload,
  onStart,
}: {
  pattern: PatternConfig;
  onChange: (pattern: PatternConfig) => void;
  errors: string[];
  workerReady: boolean;
  onDownload: () => void;
  onStart: () => void;
}) {
  return (
    <section class="panel pattern-panel">
      <div class="panel-heading">
        <h2>Calibration board</h2>
      </div>
      <div class="board-type">
        <span>Board type</span>
        <div class="segmented" role="group" aria-label="Board type">
          <button
            type="button"
            class={pattern.kind === "charuco" ? "selected" : ""}
            aria-pressed={pattern.kind === "charuco"}
            onClick={() => onChange(clonePattern(CHARUCO_PRESET))}
          >
            ChArUco
          </button>
          <button
            type="button"
            class={pattern.kind === "chessboard" ? "selected" : ""}
            aria-pressed={pattern.kind === "chessboard"}
            onClick={() => onChange(clonePattern(CHESSBOARD_PRESET))}
          >
            Chessboard
          </button>
        </div>
      </div>
      <div class="form-grid">
        {pattern.kind === "charuco" ? (
          <>
            <NumberField
              label="Columns (squares)"
              value={pattern.squaresX}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(squaresX) => onChange({ ...pattern, squaresX })}
            />
            <NumberField
              label="Rows (squares)"
              value={pattern.squaresY}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(squaresY) => onChange({ ...pattern, squaresY })}
            />
            <NumberField
              label="Square size (mm)"
              value={pattern.squareLengthMm}
              min={0.1}
              max={MAX_PATTERN_LENGTH_MM}
              step={0.1}
              onChange={(squareLengthMm) => onChange({ ...pattern, squareLengthMm })}
            />
            <details class="advanced-settings span-two">
              <summary>Advanced ChArUco settings</summary>
              <div class="form-grid">
                <NumberField
                  label="Marker size (mm)"
                  value={pattern.markerLengthMm}
                  min={0.1}
                  max={MAX_PATTERN_LENGTH_MM}
                  step={0.1}
                  onChange={(markerLengthMm) => onChange({ ...pattern, markerLengthMm })}
                />
                <label class="field">
                  <span>Marker dictionary</span>
                  <select
                    value={pattern.dictionary}
                    onChange={(event) =>
                      onChange({
                        ...pattern,
                        dictionary: event.currentTarget.value as typeof pattern.dictionary,
                      })
                    }
                  >
                    {DICTIONARY_NAMES.map((dictionary) => (
                      <option key={dictionary} value={dictionary}>{dictionary}</option>
                    ))}
                  </select>
                </label>
                <label class="check span-two">
                  <input
                    type="checkbox"
                    checked={pattern.legacyPattern}
                    onChange={(event) =>
                      onChange({ ...pattern, legacyPattern: event.currentTarget.checked })
                    }
                  />
                  Pre-4.6 OpenCV board layout
                </label>
              </div>
            </details>
          </>
        ) : (
          <>
            <NumberField
              label="Columns (inner corners)"
              value={pattern.innerCornersX}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(innerCornersX) => onChange({ ...pattern, innerCornersX })}
            />
            <NumberField
              label="Rows (inner corners)"
              value={pattern.innerCornersY}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(innerCornersY) => onChange({ ...pattern, innerCornersY })}
            />
            <NumberField
              label="Square size (mm)"
              value={pattern.squareLengthMm}
              min={0.1}
              max={MAX_PATTERN_LENGTH_MM}
              step={0.1}
              onChange={(squareLengthMm) => onChange({ ...pattern, squareLengthMm })}
            />
          </>
        )}
      </div>
      {errors.length > 0 && (
        <div class="pattern-errors" role="alert">
          {errors.map((message) => <p key={message}>{message}</p>)}
        </div>
      )}
      <div class="button-row pattern-actions">
        <button
          type="button"
          class="button secondary"
          disabled={!workerReady || errors.length > 0}
          onClick={onDownload}
        >
          Download board SVG
        </button>
        <button
          type="button"
          class="button primary"
          disabled={!workerReady || errors.length > 0}
          onClick={onStart}
        >
          Start capture
        </button>
      </div>
    </section>
  );
}

function CoverageMetrics({
  progress,
}: {
  progress: ReturnType<typeof captureProgress>;
}) {
  const metrics = [
    ["Horizontal", progress.horizontal],
    ["Vertical", progress.vertical],
    ["Size", progress.size],
    ["Skew", progress.skew],
  ] as const;
  return (
    <div class="coverage-metrics" aria-label="Calibration view coverage">
      {metrics.map(([label, value]) => (
        <div class="coverage-metric" key={label}>
          <div><span>{label}</span><strong>{Math.round(value * 100)}%</strong></div>
          <progress max={1} value={value} aria-label={`${label} coverage`} />
        </div>
      ))}
    </div>
  );
}

function drawDetection(
  canvas: HTMLCanvasElement | null,
  detection: DetectionResult | undefined,
): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!detection) return;
  canvas.width = detection.imageSize.width;
  canvas.height = detection.imageSize.height;
  context.fillStyle = detection.quality.basicValid ? "#6fffb0" : "#ffcc66";
  context.strokeStyle = "rgba(10, 18, 14, .8)";
  context.lineWidth = Math.max(1, canvas.width / 1000);
  const radius = Math.max(3, canvas.width / 300);
  detection.imagePoints.forEach(({ x, y }) => {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  });
}

function ResultMatrix({ result }: { result: CalibrationResultV1 }) {
  const fx = result.cameraMatrix[0];
  const cx = result.cameraMatrix[2];
  const fy = result.cameraMatrix[4];
  const cy = result.cameraMatrix[5];
  return (
    <div class="metric-grid">
      <div><span>fx</span><strong>{fx.toFixed(3)}</strong></div>
      <div><span>fy</span><strong>{fy.toFixed(3)}</strong></div>
      <div><span>cx</span><strong>{cx.toFixed(3)}</strong></div>
      <div><span>cy</span><strong>{cy.toFixed(3)}</strong></div>
      <div class="wide"><span>Distortion</span><strong>{result.distortion.map((v) => v.toPrecision(6)).join(", ")}</strong></div>
      <div><span>RMS</span><strong>{result.rmsReprojectionError.toFixed(4)} px</strong></div>
      <div><span>Views</span><strong>{result.includedViewIds.length}</strong></div>
    </div>
  );
}

function LiveResultPreview({
  stream,
  result,
  worker,
}: {
  stream?: MediaStream;
  result: CalibrationResultV1;
  worker?: CalibrationWorkerClient;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [corrected, setCorrected] = useState(true);
  const [previewError, setPreviewError] = useState<string>();

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream ?? null;
  }, [stream]);

  useEffect(() => {
    setPreviewError(undefined);
    if (!stream || !corrected) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let gpuRenderer: WebGlUndistortRenderer | undefined;
    try {
      gpuRenderer = WebGlUndistortRenderer.create(canvas);
    } catch (error) {
      setPreviewError(errorText(error));
      return;
    }

    if (gpuRenderer) {
      let cancelled = false;
      let videoFrameHandle: number | undefined;
      let animationHandle: number | undefined;
      let lastVideoTime = Number.NEGATIVE_INFINITY;

      const renderFrame = () => {
        if (cancelled) return;
        if (
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.currentTime !== lastVideoTime
        ) {
          try {
            gpuRenderer?.render(video, result);
            lastVideoTime = video.currentTime;
          } catch (error) {
            cancelled = true;
            setPreviewError(errorText(error));
            return;
          }
        }
        scheduleFrame();
      };

      const scheduleFrame = () => {
        if (cancelled) return;
        if (video.requestVideoFrameCallback) {
          videoFrameHandle = video.requestVideoFrameCallback(() => renderFrame());
        } else {
          animationHandle = requestAnimationFrame(renderFrame);
        }
      };

      scheduleFrame();
      return () => {
        cancelled = true;
        if (videoFrameHandle !== undefined) video.cancelVideoFrameCallback?.(videoFrameHandle);
        if (animationHandle !== undefined) cancelAnimationFrame(animationHandle);
        gpuRenderer?.dispose();
      };
    }

    if (!worker) {
      setPreviewError("WebGL2 is unavailable and the OpenCV preview is not ready.");
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let timer = 0;
    let failed = false;
    const scheduleCpuFrame = (delay: number) => {
      if (!cancelled && !failed) timer = window.setTimeout(() => void renderFrame(), delay);
    };
    const renderFrame = async () => {
      if (cancelled) return;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || inFlight) {
        scheduleCpuFrame(200);
        return;
      }
      inFlight = true;
      try {
        const bitmap = await createImageBitmap(video);
        const frame = await worker.undistort(bitmap, result);
        if (!cancelled) {
          if (canvas.width !== frame.width || canvas.height !== frame.height) {
            canvas.width = frame.width;
            canvas.height = frame.height;
          }
          const pixels = new Uint8ClampedArray(frame.rgba.length);
          pixels.set(frame.rgba);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("The browser could not create a 2D preview canvas.");
          context.putImageData(
            new ImageData(pixels, frame.width, frame.height),
            0,
            0,
          );
        }
      } catch (error) {
        failed = true;
        if (!cancelled) setPreviewError(errorText(error));
      } finally {
        inFlight = false;
        scheduleCpuFrame(100);
      }
    };
    void renderFrame();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stream, worker, result, corrected]);

  return (
    <section class="panel">
      <div class="panel-heading">
        <h2>Preview</h2>
        <div class="segmented">
          <button type="button" class={!corrected ? "selected" : ""} aria-pressed={!corrected} onClick={() => setCorrected(false)}>Original</button>
          <button type="button" class={corrected ? "selected" : ""} aria-pressed={corrected} onClick={() => setCorrected(true)}>Corrected</button>
        </div>
      </div>
      {stream ? (
        <div class="result-preview">
          <video ref={videoRef} autoplay muted playsinline class={corrected ? "visually-hidden" : ""} />
          <canvas ref={canvasRef} class={!corrected ? "visually-hidden" : ""} />
        </div>
      ) : (
        <p class="muted">Connect the calibrated camera to preview correction.</p>
      )}
      {previewError && <Status tone="error">{previewError}</Status>}
    </section>
  );
}

export function App() {
  const [session, setSession] = useState<CalibrationSessionV1>(() => freshSession());
  const sessionRef = useRef(session);
  const [restoreCandidate, setRestoreCandidate] = useState<CalibrationSessionV1>();
  const [restoreResolved, setRestoreResolved] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [worker, setWorker] = useState<CalibrationWorkerClient>();
  const [workerStatus, setWorkerStatus] = useState<"loading" | "ready" | "error">("loading");
  const [opencvVersion, setOpenCvVersion] = useState<string>();
  const [stream, setStream] = useState<MediaStream>();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [resolutionDraft, setResolutionDraft] = useState<ResolutionDraft>({
    width: "",
    height: "",
  });
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [currentDetection, setCurrentDetection] = useState<DetectionResult>();
  const currentDetectionRef = useRef<DetectionResult>();
  const [captureDecision, setCaptureDecision] = useState<CaptureDecision>();
  const [autoCapture, setAutoCapture] = useState(true);
  const [importGroups, setImportGroups] = useState<ImageFileGroup[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [sessionPackageBusy, setSessionPackageBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [solving, setSolving] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const cameraRef = useRef(new CameraController());
  const captureGateRef = useRef(new CaptureGate());
  const setupVideoRef = useRef<HTMLVideoElement>(null);
  const captureVideoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const captureBusyRef = useRef(false);
  const cameraBusyRef = useRef(false);
  const importBusyRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const skipPristineSaveIdRef = useRef<string | undefined>(session.id);
  const saveTimerRef = useRef<number>();

  sessionRef.current = session;
  currentDetectionRef.current = currentDetection;
  const progress = useMemo(() => captureProgress(session.observations), [session.observations]);
  const currentFrameUsable = Boolean(
    currentDetection?.ok && isUsableDetection(currentDetection),
  );
  const patternErrors = useMemo(() => validatePattern(session.pattern), [session.pattern]);
  const requestedResolution = useMemo(
    () => parseResolutionDraft(resolutionDraft),
    [resolutionDraft],
  );

  useEffect(() => {
    const client = new CalibrationWorkerClient();
    setWorker(client);
    client
      .initialize()
      .then((version) => {
        setOpenCvVersion(version);
        setWorkerStatus("ready");
      })
      .catch((workerError) => {
        setWorkerStatus("error");
        setError(`OpenCV could not start: ${errorText(workerError)}`);
      });
    return () => {
      void client.dispose().catch(() => undefined);
      cameraRef.current.stop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadActiveSession()
      .then(async (stored) => {
        const candidate = parseStoredSession(stored);
        if (cancelled) return;
        if (candidate && candidate.observations.length > 0) {
          setRestoreCandidate(candidate);
          return;
        }
        if (stored !== undefined && !candidate) {
          await clearLocalSession();
          if (!cancelled) {
            skipPristineSaveIdRef.current = sessionRef.current.id;
            setStatus("An invalid saved session was removed.");
          }
        }
        if (!cancelled) setRestoreResolved(true);
      })
      .catch((restoreError) => {
        if (!cancelled) {
          setStatus(`Session recovery is unavailable: ${errorText(restoreError)}`);
          setRestoreResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!restoreResolved) return;
    if (
      skipPristineSaveIdRef.current === session.id &&
      session.updatedAt === session.createdAt &&
      session.observations.length === 0 &&
      session.result === undefined
    ) {
      return;
    }
    if (skipPristineSaveIdRef.current === session.id) {
      skipPristineSaveIdRef.current = undefined;
    }
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveActiveSession(session).catch((saveError) => {
        setStatus(`Session recovery is unavailable: ${errorText(saveError)}`);
      });
    }, 400);
    return () => clearTimeout(saveTimerRef.current);
  }, [session, restoreResolved]);

  useEffect(() => {
    if (captureVideoRef.current) captureVideoRef.current.srcObject = stream ?? null;
  }, [stream, session.step]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refreshDevices = async () => {
      let nextDevices: MediaDeviceInfo[];
      try {
        nextDevices = await listVideoDevices();
      } catch {
        return;
      }
      if (cancelled) return;
      setDevices(nextDevices);
      setSelectedDeviceId((current) =>
        current && !nextDevices.some((device) => device.deviceId === current) ? "" : current,
      );
    };
    void refreshDevices();
    mediaDevices.addEventListener?.("devicechange", refreshDevices);
    return () => {
      cancelled = true;
      mediaDevices.removeEventListener?.("devicechange", refreshDevices);
    };
  }, []);

  const attachPreview = useCallback(
    (element: HTMLVideoElement | null) => {
      setupVideoRef.current = element;
      if (element) element.srcObject = stream ?? null;
    },
    [stream],
  );

  const removeObservationData = useCallback(async (observations: FrameObservation[]) => {
    await deleteSessionBlobs(
      observations.flatMap((observation) => [
        observation.imageBlobKey,
        observation.thumbnailBlobKey,
      ]),
    );
  }, []);

  const clearObservations = useCallback(async () => {
    sessionGenerationRef.current += 1;
    await removeObservationData(sessionRef.current.observations);
    setSession((previous) =>
      updated(previous, { observations: [], result: undefined, imageSize: undefined }),
    );
    captureGateRef.current.reset();
  }, [removeObservationData]);

  const commitCameraSettings = useCallback(async (
    settings: CameraSettingsSnapshot,
    syncResolutionDraft = true,
  ) => {
    const pipelineChanged =
      sessionRef.current.observations.length > 0 &&
      cameraPipelineChanged(sessionRef.current.captureSettings, settings);
    if (pipelineChanged) await clearObservations();
    if (syncResolutionDraft) {
      setResolutionDraft({
        width: String(settings.width),
        height: String(settings.height),
      });
    }
    setSession((previous) =>
      updated(previous, { captureSettings: settings, imageSize: settings }),
    );
    return pipelineChanged;
  }, [clearObservations]);

  const openCamera = useCallback(async (deviceId = selectedDeviceId) => {
    if (cameraBusyRef.current) return;
    if (requestedResolution.error) {
      setError(requestedResolution.error);
      return;
    }
    cameraBusyRef.current = true;
    setCameraBusy(true);
    setError(undefined);
    setStatus("Requesting camera access…");
    if (setupVideoRef.current) setupVideoRef.current.srcObject = null;
    if (captureVideoRef.current) captureVideoRef.current.srcObject = null;
    setStream(undefined);
    setCurrentDetection(undefined);
    currentDetectionRef.current = undefined;
    setCaptureDecision(undefined);
    drawDetection(overlayRef.current, undefined);
    captureGateRef.current.reset();
    try {
      const nextStream = await cameraRef.current.open({
        ...requestedResolution.size,
        deviceId: deviceId || undefined,
      });
      const settings = cameraRef.current.settings();
      const pipelineChanged = await commitCameraSettings(settings);
      if (pipelineChanged) {
        setStatus("The stream configuration changed, so previous captures were cleared.");
      } else {
        setStatus(`Camera ready at ${settings.width} × ${settings.height}.`);
      }
      setStream(nextStream);
      try {
        const availableDevices = await listVideoDevices();
        setDevices(availableDevices);
        const active = availableDevices.find(
          (device) =>
            device.deviceId === settings.deviceId || device.label === settings.cameraLabel,
        );
        if (active) setSelectedDeviceId(active.deviceId);
      } catch {
        // The active stream is usable even when device enumeration is temporarily unavailable.
      }
    } catch (cameraError) {
      if (isOperationCancellation(cameraError)) return;
      cameraRef.current.stop();
      setStream(undefined);
      setStatus(undefined);
      setError(errorText(cameraError));
    } finally {
      cameraBusyRef.current = false;
      setCameraBusy(false);
    }
  }, [requestedResolution, selectedDeviceId, commitCameraSettings]);

  const applyCameraSettings = useCallback(async () => {
    if (!stream) {
      await openCamera();
      return;
    }
    if (requestedResolution.error || !requestedResolution.size) {
      setError(requestedResolution.error ?? "Enter the exact width and height to apply.");
      return;
    }
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setCameraBusy(true);
    setError(undefined);
    setStatus("Applying exact camera mode…");
    try {
      const settings = await cameraRef.current.applyResolution(requestedResolution.size);
      const pipelineChanged = await commitCameraSettings(settings);
      if (pipelineChanged) {
        setStatus("The stream resolution changed, so previous captures were cleared.");
      } else {
        setStatus(`Camera ready at ${settings.width} × ${settings.height}.`);
      }
    } catch (cameraError) {
      if (!isOperationCancellation(cameraError)) {
        let pipelineChanged = false;
        try {
          pipelineChanged = await commitCameraSettings(cameraRef.current.settings(), false);
        } catch {
          // The original camera error is more useful if the track also ended.
        }
        setStatus(undefined);
        setError(
          `${errorText(cameraError)}${pipelineChanged ? " Previous captures were cleared because the stream changed." : ""}`,
        );
      }
    } finally {
      cameraBusyRef.current = false;
      setCameraBusy(false);
    }
  }, [stream, openCamera, requestedResolution, commitCameraSettings]);

  const selectCamera = useCallback(
    (deviceId: string) => {
      if (cameraBusyRef.current) return;
      setSelectedDeviceId(deviceId);
      if (stream) void openCamera(deviceId);
    },
    [openCamera, stream],
  );

  useEffect(() => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const handleEnded = () => {
      if (cameraRef.current.currentStream() !== stream) return;
      cameraRef.current.stop();
      setStream(undefined);
      setCurrentDetection(undefined);
      currentDetectionRef.current = undefined;
      setCaptureDecision(undefined);
      drawDetection(overlayRef.current, undefined);
      setStatus(undefined);
      setError(
        "Camera capture stopped unexpectedly. Close other apps using the camera, reconnect it if needed, and connect again.",
      );
    };
    track.addEventListener("ended", handleEnded);
    if (track.readyState === "ended") handleEnded();
    return () => track.removeEventListener("ended", handleEnded);
  }, [stream]);

  const storeObservation = useCallback(
    async (
      detection: DetectionResult,
      imageBlob: Blob,
      source: FrameObservation["source"],
      sourceName?: string,
      include = true,
      exclusionReason?: string,
      generation = sessionGenerationRef.current,
    ): Promise<FrameObservation> => {
      const id = createId("view");
      const imageBlobKey = `${id}-image`;
      const thumbnailBlobKey = `${id}-thumb`;
      const thumb = await thumbnailBlob(imageBlob);
      if (generation !== sessionGenerationRef.current) {
        throw new SessionOperationCancelledError();
      }
      const headroom: { remaining?: number; quota?: number } = await storageHeadroom().catch(
        () => ({}),
      );
      if (
        headroom.remaining !== undefined &&
        headroom.remaining < imageBlob.size + thumb.size
      ) {
        throw new Error("There is not enough browser storage to preserve another frame.");
      }
      await putSessionBlobs([
        [imageBlobKey, imageBlob],
        [thumbnailBlobKey, thumb],
      ]);
      if (generation !== sessionGenerationRef.current) {
        await deleteSessionBlobs([imageBlobKey, thumbnailBlobKey]).catch(() => undefined);
        throw new SessionOperationCancelledError();
      }
      const observation: FrameObservation = {
        id,
        source,
        sourceName,
        createdAt: new Date().toISOString(),
        imageSize: detection.imageSize,
        imagePoints: detection.imagePoints,
        objectPoints: detection.objectPoints,
        pointIds: detection.pointIds,
        quality: detection.quality,
        pose: detection.pose,
        imageBlobKey,
        thumbnailBlobKey,
        included: include,
        autoExcludedReason: include ? undefined : exclusionReason,
      };
      setSession((previous) =>
        updated(previous, {
          observations: [...previous.observations, observation],
          imageSize: detection.imageSize,
          result: undefined,
        }),
      );
      return observation;
    },
    [],
  );

  const captureCurrentFrame = useCallback(
    async () => {
      if (captureBusyRef.current || importBusyRef.current) return;
      const detection = currentDetectionRef.current;
      const video = captureVideoRef.current;
      if (!detection?.ok || !isUsableDetection(detection) || !video) {
        setStatus("A board detection is required before capture.");
        return;
      }
      if (sessionRef.current.observations.length >= MAX_SESSION_VIEWS) {
        setStatus(`The ${MAX_SESSION_VIEWS}-view storage limit has been reached.`);
        return;
      }
      if (
        sessionRef.current.observations.filter((view) => view.included).length >=
        MAX_INCLUDED_VIEWS
      ) {
        setStatus(`The ${MAX_INCLUDED_VIEWS}-view solve set is full.`);
        return;
      }
      captureBusyRef.current = true;
      const generation = sessionGenerationRef.current;
      try {
        const blob = await videoFrameBlob(video);
        const include = detection.quality.basicValid;
        const exclusionReason = include
          ? undefined
          : detection.quality.messages[0] ?? "Captured for manual review.";
        await storeObservation(
          detection,
          blob,
          "live",
          undefined,
          include,
          exclusionReason,
          generation,
        );
        captureGateRef.current.markCaptured();
        setStatus(
          include
            ? `Captured view ${sessionRef.current.observations.length + 1}.`
            : `Saved view for review: ${exclusionReason}`,
        );
      } catch (captureError) {
        if (!isOperationCancellation(captureError)) setError(errorText(captureError));
      } finally {
        captureBusyRef.current = false;
      }
    },
    [storeObservation],
  );

  useEffect(() => {
    if (
      session.step !== "capture" ||
      !stream ||
      !worker ||
      workerStatus !== "ready" ||
      importBusy
    ) {
      return;
    }
    captureGateRef.current.reset();
    setCurrentDetection(undefined);
    currentDetectionRef.current = undefined;
    setCaptureDecision(undefined);
    drawDetection(overlayRef.current, undefined);
    let cancelled = false;
    let requestHandle: number | undefined;
    let animationHandle: number | undefined;
    let inFlight = false;
    let lastDetectionAt = 0;

    const schedule = (callback: (time: number) => void) => {
      if (cancelled) return;
      const video = captureVideoRef.current;
      if (video?.requestVideoFrameCallback) {
        requestHandle = video.requestVideoFrameCallback((time) => callback(time));
      } else {
        animationHandle = requestAnimationFrame(callback);
      }
    };

    const cancelScheduledFrame = () => {
      if (requestHandle !== undefined) {
        captureVideoRef.current?.cancelVideoFrameCallback?.(requestHandle);
        requestHandle = undefined;
      }
      if (animationHandle !== undefined) {
        cancelAnimationFrame(animationHandle);
        animationHandle = undefined;
      }
    };

    const next = async (time: number) => {
      if (cancelled) return;
      schedule((nextTime) => void next(nextTime));
      const video = captureVideoRef.current;
      if (
        !video ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        inFlight ||
        time - lastDetectionAt < 190
      ) {
        return;
      }
      inFlight = true;
      lastDetectionAt = time;
      try {
        const bitmap = await createImageBitmap(video);
        const detection = await worker.detect(bitmap, sessionRef.current.pattern);
        if (cancelled) return;
        setCurrentDetection(detection);
        currentDetectionRef.current = detection;
        drawDetection(overlayRef.current, detection);
        const decision = captureGateRef.current.evaluate(
          detection,
          sessionRef.current.observations,
          time,
        );
        setCaptureDecision(decision);
        const currentSession = sessionRef.current;
        if (
          autoCapture &&
          decision.accept &&
          currentSession.observations.length < MAX_SESSION_VIEWS &&
          currentSession.observations.filter((view) => view.included).length <
            MAX_INCLUDED_VIEWS
        ) {
          await captureCurrentFrame();
        }
      } catch (detectionError) {
        if (!cancelled) {
          cancelled = true;
          cancelScheduledFrame();
          setCurrentDetection(undefined);
          currentDetectionRef.current = undefined;
          setCaptureDecision(undefined);
          drawDetection(overlayRef.current, undefined);
          setError(errorText(detectionError));
        }
      } finally {
        inFlight = false;
      }
    };
    schedule((time) => void next(time));
    return () => {
      cancelled = true;
      cancelScheduledFrame();
    };
  }, [session.step, stream, worker, workerStatus, autoCapture, importBusy, captureCurrentFrame]);

  const chooseImportFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || importBusyRef.current) return;
    importBusyRef.current = true;
    setImportBusy(true);
    setError(undefined);
    const supported = files
      .filter(
        (file) =>
          /^image\/(?:jpeg|png|webp)$/.test(file.type) &&
          file.size > 0 &&
          file.size <= MAX_FILE_BYTES,
      )
      .slice(0, MAX_SESSION_VIEWS);
    if (supported.length === 0) {
      setError("Choose JPEG, PNG, or WebP images no larger than 25 MB each.");
      importBusyRef.current = false;
      setImportBusy(false);
      return;
    }
    const totalBytes = supported.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_IMPORT_BYTES) {
      setError(`The selected images total ${humanBytes(totalBytes)}; the import limit is 250 MB.`);
      importBusyRef.current = false;
      setImportBusy(false);
      return;
    }
    setStatus("Reading image dimensions…");
    try {
      const groups = await groupImageFiles(supported);
      const onlyGroup = groups[0];
      if (!onlyGroup) throw new Error("No readable images were selected.");
      setImportGroups(groups);
      setStatus(
        groups.length > 1
          ? "The images use multiple resolutions. Choose one resolution group."
          : `${onlyGroup.files.length} images ready to process.`,
      );
    } catch (importError) {
      setError(errorText(importError));
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  }, []);

  const processImportGroup = useCallback(
    async (group: ImageFileGroup) => {
      if (!worker || workerStatus !== "ready" || importBusyRef.current) return;
      importBusyRef.current = true;
      setImportBusy(true);
      setError(undefined);
      try {
        let generation = sessionGenerationRef.current;
        let initialObservationCount = sessionRef.current.observations.length;
        let initiallyIncluded = sessionRef.current.observations.filter(
          (view) => view.included,
        ).length;
        if (sessionRef.current.imageSize && !sameSize(sessionRef.current.imageSize, group)) {
          await clearObservations();
          generation = sessionGenerationRef.current;
          initialObservationCount = 0;
          initiallyIncluded = 0;
          setStatus("Existing captures were cleared because the imported resolution is different.");
        }
        let accepted = 0;
        let flagged = 0;
        let rejected = 0;
        let skippedByLimit = 0;
        for (const [index, file] of group.files.entries()) {
          if (generation !== sessionGenerationRef.current) {
            throw new SessionOperationCancelledError();
          }
          if (initialObservationCount + accepted + flagged >= MAX_SESSION_VIEWS) {
            skippedByLimit = group.files.length - index;
            break;
          }
          setStatus(`Processing ${index + 1} of ${group.files.length}: ${file.name}`);
          const bitmap = await decodeImage(file);
          const detection = await worker.detect(bitmap, sessionRef.current.pattern);
          if (generation !== sessionGenerationRef.current) {
            throw new SessionOperationCancelledError();
          }
          if (!detection.ok || !isUsableDetection(detection)) {
            rejected += 1;
            continue;
          }
          const include =
            detection.quality.basicValid &&
            initiallyIncluded + accepted < MAX_INCLUDED_VIEWS;
          const exclusionReason = include
            ? undefined
            : detection.quality.basicValid
              ? `Excluded because the ${MAX_INCLUDED_VIEWS}-view solve set is full.`
              : detection.quality.messages[0] ?? "Flagged for manual review.";
          await storeObservation(
            detection,
            file,
            "upload",
            file.name,
            include,
            exclusionReason,
            generation,
          );
          if (include) accepted += 1;
          else flagged += 1;
        }
        setImportGroups([]);
        setStatus(
          `Imported ${accepted} included views; ${flagged} flagged for review; ${rejected} images had no usable board detection${
            skippedByLimit ? `; ${skippedByLimit} images were not processed after reaching the ${MAX_SESSION_VIEWS}-view storage limit` : ""
          }.`,
        );
      } catch (importError) {
        if (!isOperationCancellation(importError)) setError(errorText(importError));
      } finally {
        importBusyRef.current = false;
        setImportBusy(false);
      }
    },
    [worker, workerStatus, clearObservations, storeObservation],
  );

  const solveCalibration = useCallback(async () => {
    if (!worker || !session.imageSize || progress.accepted < 12) return;
    const generation = sessionGenerationRef.current;
    setSolving(true);
    setError(undefined);
    try {
      const result = await worker.solve(
        session.observations,
        session.lensModel,
        session.pattern,
        session.imageSize,
        session.observations
          .filter((observation) => observation.included)
          .every((observation) => observation.source === "live")
          ? session.captureSettings
          : undefined,
      );
      if (generation !== sessionGenerationRef.current) return;
      const included = new Set(result.includedViewIds);
      setSession((previous) =>
        updated(previous, {
          result,
          step: "results",
          observations: previous.observations.map((observation) => ({
            ...observation,
            included: included.has(observation.id),
            perViewRms: result.perViewErrors[observation.id],
            autoExcludedReason:
              result.excludedViewIds.includes(observation.id) && observation.included
                ? "Excluded because the view was unstable or had high reprojection error."
                : observation.autoExcludedReason,
          })),
        }),
      );
      setStatus(undefined);
    } catch (solveError) {
      setError(errorText(solveError));
    } finally {
      setSolving(false);
    }
  }, [worker, session, progress.accepted]);

  const downloadPattern = useCallback(async () => {
    if (!worker) return;
    try {
      const svg = await worker.patternSvg(session.pattern);
      downloadBlob(
        `${session.pattern.kind}-calibration-board.svg`,
        new Blob([svg], { type: "image/svg+xml" }),
      );
    } catch (patternError) {
      setError(errorText(patternError));
    }
  }, [worker, session.pattern]);

  const exportCurrentSession = useCallback(async () => {
    if (sessionPackageBusy) return;
    setSessionPackageBusy(true);
    setError(undefined);
    try {
      const archive = await createSessionPackage(sessionRef.current);
      downloadBlob("camera-calibration-session.zip", archive);
      setStatus("Session package exported.");
    } catch (packageError) {
      setError(errorText(packageError));
    } finally {
      setSessionPackageBusy(false);
    }
  }, [sessionPackageBusy]);

  const exportSelectedResult = useCallback(async () => {
    const result = sessionRef.current.result;
    if (!result) return;
    switch (exportFormat) {
      case "json":
        downloadText("camera-calibration.json", resultJson(result), "application/json");
        break;
      case "opencv-yaml":
        downloadText("camera-calibration.yaml", toOpenCvYaml(result), "application/yaml");
        break;
      case "ros-yaml":
        downloadText(
          "camera-info.yaml",
          toRosCameraInfoYaml(result),
          "application/yaml",
        );
        break;
      case "session-package":
        await exportCurrentSession();
        break;
    }
  }, [exportCurrentSession, exportFormat]);

  const importSessionFile = useCallback(async (file?: File) => {
    if (!file || sessionPackageBusy) return;
    setSessionPackageBusy(true);
    setError(undefined);
    setStatus("Reading session package…");
    try {
      const imported = await readSessionPackage(file);
      await replaceLocalSession(imported.session, imported.blobs);
      sessionGenerationRef.current += 1;
      clearTimeout(saveTimerRef.current);
      cameraRef.current.stop();
      if (setupVideoRef.current) setupVideoRef.current.srcObject = null;
      if (captureVideoRef.current) captureVideoRef.current.srcObject = null;
      setStream(undefined);
      setSelectedDeviceId("");
      setCurrentDetection(undefined);
      currentDetectionRef.current = undefined;
      setCaptureDecision(undefined);
      drawDetection(overlayRef.current, undefined);
      captureGateRef.current.reset();
      setImportGroups([]);
      importBusyRef.current = false;
      setImportBusy(false);
      setRestoreCandidate(undefined);
      setRestoreResolved(true);
      skipPristineSaveIdRef.current = undefined;
      setSession(imported.session);
      const importedSize = imported.session.captureSettings ?? imported.session.imageSize;
      setResolutionDraft(
        importedSize
          ? { width: String(importedSize.width), height: String(importedSize.height) }
          : { width: "", height: "" },
      );
      setStatus(`Session imported with ${imported.session.observations.length} views.`);
    } catch (packageError) {
      setStatus(undefined);
      setError(errorText(packageError));
    } finally {
      setSessionPackageBusy(false);
    }
  }, [sessionPackageBusy]);

  const resetEverything = useCallback(async () => {
    sessionGenerationRef.current += 1;
    clearTimeout(saveTimerRef.current);
    cameraRef.current.stop();
    if (setupVideoRef.current) setupVideoRef.current.srcObject = null;
    if (captureVideoRef.current) captureVideoRef.current.srcObject = null;
    setStream(undefined);
    setSelectedDeviceId("");
    setResolutionDraft({ width: "", height: "" });
    setError(undefined);
    try {
      await clearLocalSession();
      const nextSession = freshSession();
      skipPristineSaveIdRef.current = nextSession.id;
      setSession(nextSession);
      captureGateRef.current.reset();
      setCurrentDetection(undefined);
      currentDetectionRef.current = undefined;
      setCaptureDecision(undefined);
      drawDetection(overlayRef.current, undefined);
      setImportGroups([]);
      importBusyRef.current = false;
      setImportBusy(false);
      setRestoreCandidate(undefined);
      setRestoreResolved(true);
      setStatus("Local session data was deleted.");
    } catch (resetError) {
      setStatus(undefined);
      setError(`Local data could not be deleted: ${errorText(resetError)}`);
    }
  }, []);

  const discardRestore = useCallback(async () => {
    if (restoreBusy) return;
    setRestoreBusy(true);
    setError(undefined);
    try {
      await clearLocalSession();
      const currentSession = sessionRef.current;
      if (
        currentSession.updatedAt === currentSession.createdAt &&
        currentSession.observations.length === 0
      ) {
        skipPristineSaveIdRef.current = currentSession.id;
      }
      setRestoreCandidate(undefined);
      setRestoreResolved(true);
      setStatus("Saved session discarded.");
    } catch (discardError) {
      setError(`Saved session could not be discarded: ${errorText(discardError)}`);
    } finally {
      setRestoreBusy(false);
    }
  }, [restoreBusy]);

  const setStep = (step: AppStep) => setSession((previous) => updated(previous, { step }));
  const setPattern = (pattern: PatternConfig) => {
    sessionGenerationRef.current += 1;
    const observations = sessionRef.current.observations;
    if (observations.length > 0) {
      void removeObservationData(observations).catch((storageError) => {
        setStatus(`Old capture images could not be removed: ${errorText(storageError)}`);
      });
    }
    captureGateRef.current.reset();
    setCurrentDetection(undefined);
    currentDetectionRef.current = undefined;
    setCaptureDecision(undefined);
    drawDetection(overlayRef.current, undefined);
    setSession((previous) =>
      updated(previous, { pattern, observations: [], imageSize: undefined, result: undefined }),
    );
  };

  return (
    <div class="app-shell">
      <header class="site-header">
        <div class="brand"><h1>Web Camera Calibration Tool</h1></div>
      </header>

      <main>
        <p class="configuration-summary">{patternLabel(session.pattern)} · {session.lensModel === "pinhole-radtan5" ? "Standard lens" : "Fisheye"}</p>
        <Stepper step={session.step} />

        {error && <Status tone="error">{error}</Status>}
        {status && <Status>{status}</Status>}
        {workerStatus === "loading" && <Status>Loading the OpenCV calibration engine…</Status>}

        {session.step === "setup" && (
          <div class="setup-layout">
            <section class="panel camera-panel">
              <div class="panel-heading"><h2>Camera</h2><span class={stream ? "ready-dot" : "idle-dot"}>{stream ? "Ready" : "Not connected"}</span></div>
              <div class="camera-preview compact">
                {stream ? <video ref={attachPreview} autoplay muted playsinline /> : <div class="empty-preview"><button type="button" class="button primary" disabled={cameraBusy || Boolean(requestedResolution.error)} onClick={() => void openCamera()}>{cameraBusy ? "Connecting…" : "Connect camera"}</button></div>}
              </div>
              <div class="camera-controls">
                <div class="form-grid">
                  <label class="field span-two"><span>Camera</span><select value={selectedDeviceId} disabled={cameraBusy} onChange={(event) => selectCamera(event.currentTarget.value)}><option value="">Default camera</option>{devices.map((device, index) => <option key={`${device.deviceId}-${index}`} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>
                  <label class="field"><span>Width</span><input type="number" inputMode="numeric" min={1} max={MAX_CAMERA_DIMENSION} step={1} placeholder="Camera default" value={resolutionDraft.width} disabled={cameraBusy} onInput={(event) => setResolutionDraft((previous) => ({ ...previous, width: event.currentTarget.value }))} /></label>
                  <label class="field"><span>Height</span><input type="number" inputMode="numeric" min={1} max={MAX_CAMERA_DIMENSION} step={1} placeholder="Camera default" value={resolutionDraft.height} disabled={cameraBusy} onInput={(event) => setResolutionDraft((previous) => ({ ...previous, height: event.currentTarget.value }))} /></label>
                  {requestedResolution.error && <p class="field-error span-two">{requestedResolution.error}</p>}
                  <label class="field span-two"><span>Lens model</span><select value={session.lensModel} onChange={(event) => { const lensModel = event.currentTarget.value as LensModel; setSession((previous) => updated(previous, { lensModel, result: undefined })); }}><option value="pinhole-radtan5">Standard lens · radial/tangential 5</option><option value="fisheye-kb4">Fisheye · four coefficients</option></select></label>
                </div>
                {stream && <div class="button-row camera-mode-action"><button type="button" class="button secondary" disabled={cameraBusy || Boolean(requestedResolution.error) || !requestedResolution.size} onClick={() => void applyCameraSettings()}>{cameraBusy ? "Applying…" : "Apply resolution"}</button></div>}
              </div>
              {session.captureSettings && <dl class="settings-summary"><div><dt>Actual stream</dt><dd>{session.captureSettings.width} × {session.captureSettings.height}</dd></div><div><dt>Source scaling</dt><dd>{session.captureSettings.resizeMode === "none" ? "Unscaled" : session.captureSettings.resizeMode === "crop-and-scale" ? "Browser crop/scale" : session.captureSettings.resizeMode ?? "Not reported by browser"}</dd></div></dl>}
            </section>

            <PatternEditor pattern={session.pattern} onChange={setPattern} errors={patternErrors} workerReady={workerStatus === "ready"} onDownload={() => void downloadPattern()} onStart={() => setStep("capture")} />
          </div>
        )}

        {session.step === "capture" && (
          <div class="capture-layout">
            <section class="panel capture-main">
              <div class="panel-heading"><h2>Capture</h2><label class="switch"><input type="checkbox" checked={autoCapture} onChange={(event) => setAutoCapture(event.currentTarget.checked)} /><span /> Auto capture</label></div>
              {stream ? <div class="camera-preview live"><video ref={captureVideoRef} autoplay muted playsinline /><canvas ref={overlayRef} /><div class="view-counter">{progress.accepted}<small>/ 20 views</small></div></div> : <div class="empty-capture"><span>Camera is not connected.</span><button type="button" class="button secondary" onClick={() => setStep("setup")}>Configure camera</button></div>}
              <div class="capture-message"><span class={currentDetection?.quality.basicValid ? "signal good" : "signal"} /> <strong>{captureDecision?.reasons[0] ?? "Show the entire board to the camera."}</strong></div>
              <div class="button-row"><button type="button" class="button secondary" disabled={importBusy || !currentFrameUsable || !stream || session.observations.length >= MAX_SESSION_VIEWS || progress.accepted >= MAX_INCLUDED_VIEWS} onClick={() => void captureCurrentFrame()}>Capture now</button><label class={`button secondary file-button${importBusy ? " disabled" : ""}`}>Import images<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={importBusy} onChange={(event) => { const input = event.currentTarget; const files = Array.from(input.files ?? []); input.value = ""; void chooseImportFiles(files); }} /></label><button type="button" class="button secondary" disabled={importBusy} onClick={() => setStep("setup")}>Camera settings</button><button type="button" class="button primary" disabled={importBusy || !progress.minimumReached} onClick={() => setStep("review")}>Review {progress.accepted} views</button></div>
              {importGroups.length > 0 && <div class="import-groups"><h3>Choose one resolution</h3>{importGroups.map((group) => <button key={group.key} type="button" disabled={importBusy} onClick={() => void processImportGroup(group)}><strong>{group.width} × {group.height}</strong><span>{group.files.length} images</span></button>)}</div>}
            </section>
            <aside class="panel capture-guide"><h2>Capture guidance</h2><CoverageMetrics progress={progress} /><dl class="progress-list"><div><dt>Views</dt><dd>{progress.accepted} / 20</dd></div></dl><p class="capture-hint">Move the board across the frame. Vary size and perspective.</p></aside>
          </div>
        )}

        {session.step === "review" && (
          <div class="review-layout">
            <section class="panel review-summary"><div><h2>Views ({progress.accepted} included)</h2><p class="muted">Toggle views before calibration.</p></div><CoverageMetrics progress={progress} /><div class="button-row"><button type="button" class="button secondary" disabled={solving} onClick={() => setStep("capture")}>Add views</button><button type="button" class="button primary" disabled={!progress.minimumReached || solving} onClick={() => void solveCalibration()}>{solving ? "Solving…" : "Run calibration"}</button></div></section>
            <section class="observation-grid" aria-label="Captured calibration views">
              {session.observations.map((observation, index) => (
                <article key={observation.id} class={`observation-card ${observation.included ? "" : "excluded"}`}>
                  <div class="observation-image" style={{ aspectRatio: `${observation.imageSize.width} / ${observation.imageSize.height}` }}><ObservationThumbnail observation={observation} /><span>#{index + 1}</span></div>
                  <div class="observation-details">
                    <strong>{observation.sourceName ?? `${observation.source} capture`}</strong>
                    <small>{observation.quality.detectedCorners} corners · sharpness {observation.quality.sharpness.toFixed(0)}</small>
                    {observation.perViewRms !== undefined && <small>RMS {observation.perViewRms.toFixed(3)} px</small>}
                    {observation.autoExcludedReason && <small>{observation.autoExcludedReason}</small>}
                    <label class="check"><input type="checkbox" checked={observation.included} disabled={solving || (!observation.included && progress.accepted >= MAX_INCLUDED_VIEWS)} onChange={(event) => { const included = event.currentTarget.checked; setSession((previous) => updated(previous, { observations: previous.observations.map((candidate) => candidate.id === observation.id ? { ...candidate, included, autoExcludedReason: undefined } : candidate), result: undefined })); }} /> Include view</label>
                  </div>
                </article>
              ))}
            </section>
          </div>
        )}

        {session.step === "results" && session.result && (
          <div class="results-layout">
            <section class="panel result-summary">
              <div class="result-title">
                <div>
                  <h2>{session.result.model === "pinhole-radtan5" ? "Standard lens" : "Fisheye"}</h2>
                  <p class="muted">{session.result.imageSize.width} × {session.result.imageSize.height} · OpenCV {session.result.generator.opencvVersion}</p>
                </div>
                <div class="score"><strong>{session.result.rmsReprojectionError.toFixed(3)}</strong><span>px RMS</span></div>
              </div>
              <ResultMatrix result={session.result} />
              <div class="export-row">
                <label class="field export-format">
                  <span>Export format</span>
                  <select
                    value={exportFormat}
                    onChange={(event) => setExportFormat(event.currentTarget.value as ExportFormat)}
                  >
                    <option value="json">Calibration JSON</option>
                    <option value="opencv-yaml">OpenCV YAML</option>
                    <option value="ros-yaml">ROS camera_info YAML</option>
                    <option value="session-package">Portable session package</option>
                  </select>
                </label>
                <button
                  type="button"
                  class="button secondary"
                  disabled={sessionPackageBusy}
                  onClick={() => void exportSelectedResult()}
                >
                  {sessionPackageBusy ? "Preparing…" : "Download"}
                </button>
                <button type="button" class="button primary" onClick={() => setStep("review")}>Review views</button>
              </div>
              {session.result.excludedViewIds.length > 0 && <Status>{session.result.excludedViewIds.length} view(s) excluded from the result.</Status>}
            </section>
            <LiveResultPreview stream={stream} result={session.result} worker={worker} />
            <CalibrationDiagnostics result={session.result} observations={session.observations} />
            <ValidationImagePreview result={session.result} worker={worker} />
          </div>
        )}
      </main>

      <footer>
        <div class="footer-actions">
          <label class={`footer-file${sessionPackageBusy ? " disabled" : ""}`}>
            Import session
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={sessionPackageBusy}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                input.value = "";
                void importSessionFile(file);
              }}
            />
          </label>
          <button
            type="button"
            disabled={sessionPackageBusy}
            onClick={() => void exportCurrentSession()}
          >
            Export session
          </button>
          <button type="button" disabled={sessionPackageBusy} onClick={() => void resetEverything()}>Delete local data</button>
        </div>
        <div class="footer-meta"><span>AI-assisted software; verify calibration results.</span><a href="https://github.com/gmmyung/camera-calibration" target="_blank" rel="noopener noreferrer">GitHub</a><span>{opencvVersion ? `OpenCV ${opencvVersion}` : "OpenCV unavailable"}</span></div>
      </footer>

      {restoreCandidate && !restoreResolved && <div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title"><h2 id="restore-title">Restore session?</h2><p>{restoreCandidate.observations.length} views saved {new Date(restoreCandidate.updatedAt).toLocaleString()}.</p><div class="button-row"><button type="button" class="button secondary" disabled={restoreBusy} onClick={() => void discardRestore()}>{restoreBusy ? "Discarding…" : "Discard"}</button><button type="button" class="button primary" disabled={restoreBusy} onClick={() => { sessionGenerationRef.current += 1; setSession(restoreCandidate); setRestoreCandidate(undefined); setRestoreResolved(true); setStatus("Saved session restored."); }}>Restore</button></div></div></div>}
    </div>
  );
}
