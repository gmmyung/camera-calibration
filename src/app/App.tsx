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
  RESOLUTION_PRESETS,
  listVideoDevices,
  type ExtendedCapabilities,
} from "../lib/camera";
import { downloadBlob, downloadText, resultJson, toOpenCvYaml } from "../lib/exports";
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
  getSessionBlob,
  loadActiveSession,
  putSessionBlobs,
  saveActiveSession,
  storageHeadroom,
} from "../lib/session-db";
import { WebGlUndistortRenderer } from "../lib/undistort-webgl";
import { CalibrationWorkerClient } from "../worker/client";

const MAX_IMPORT_FILES = 100;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMPORT_BYTES = 250 * 1024 * 1024;

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

function Status({ children, tone = "info" }: { children: ComponentChildren; tone?: string }) {
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
}: {
  pattern: PatternConfig;
  onChange: (pattern: PatternConfig) => void;
}) {
  return (
    <section class="panel pattern-panel">
      <div class="panel-heading">
        <h2>Target</h2>
        <div class="segmented">
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
              label="Squares across"
              value={pattern.squaresX}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(squaresX) => onChange({ ...pattern, squaresX })}
            />
            <NumberField
              label="Squares down"
              value={pattern.squaresY}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(squaresY) => onChange({ ...pattern, squaresY })}
            />
            <NumberField
              label="Square length (mm)"
              value={pattern.squareLengthMm}
              min={0.1}
              max={MAX_PATTERN_LENGTH_MM}
              step={0.1}
              onChange={(squareLengthMm) => onChange({ ...pattern, squareLengthMm })}
            />
            <NumberField
              label="Marker length (mm)"
              value={pattern.markerLengthMm}
              min={0.1}
              max={MAX_PATTERN_LENGTH_MM}
              step={0.1}
              onChange={(markerLengthMm) => onChange({ ...pattern, markerLengthMm })}
            />
            <label class="field span-two">
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
              My board uses OpenCV's pre-4.6 legacy ChArUco layout
            </label>
          </>
        ) : (
          <>
            <NumberField
              label="Inner corners across"
              value={pattern.innerCornersX}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(innerCornersX) => onChange({ ...pattern, innerCornersX })}
            />
            <NumberField
              label="Inner corners down"
              value={pattern.innerCornersY}
              min={3}
              max={MAX_PATTERN_GRID_SIZE}
              onChange={(innerCornersY) => onChange({ ...pattern, innerCornersY })}
            />
            <NumberField
              label="Square length (mm)"
              value={pattern.squareLengthMm}
              min={0.1}
              max={MAX_PATTERN_LENGTH_MM}
              step={0.1}
              onChange={(squareLengthMm) => onChange({ ...pattern, squareLengthMm })}
            />
          </>
        )}
      </div>
    </section>
  );
}

function CoverageGrid({ observations }: { observations: FrameObservation[] }) {
  const counts = Array.from({ length: 9 }, (_, cell) =>
    observations.filter((observation) => observation.included && observation.pose.coverageCell === cell)
      .length,
  );
  return (
    <div class="coverage" aria-label="Image coverage map">
      {counts.map((count, cell) => (
        <div key={cell} class={count ? "covered" : ""} title={`Cell ${cell + 1}: ${count} views`}>
          {count || "·"}
        </div>
      ))}
    </div>
  );
}

function ObservationThumbnail({ observation }: { observation: FrameObservation }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    getSessionBlob(observation.thumbnailBlobKey)
      .then((blob) => {
        if (!blob || disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [observation.thumbnailBlobKey]);
  return url ? (
    <img src={url} alt={observation.sourceName ?? "Calibration capture"} />
  ) : (
    <div class="image-placeholder" />
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
  const [requestedSize, setRequestedSize] = useState<ImageSize>({ width: 1280, height: 720 });
  const [capabilities, setCapabilities] = useState<ExtendedCapabilities>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [currentDetection, setCurrentDetection] = useState<DetectionResult>();
  const currentDetectionRef = useRef<DetectionResult>();
  const [captureDecision, setCaptureDecision] = useState<CaptureDecision>();
  const [autoCapture, setAutoCapture] = useState(true);
  const [importGroups, setImportGroups] = useState<ImageFileGroup[]>([]);
  const [importBusy, setImportBusy] = useState(false);
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
  const patternErrors = useMemo(() => validatePattern(session.pattern), [session.pattern]);

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

  const commitCameraSettings = useCallback(async (settings: CameraSettingsSnapshot) => {
    const pipelineChanged =
      sessionRef.current.observations.length > 0 &&
      cameraPipelineChanged(sessionRef.current.captureSettings, settings);
    if (pipelineChanged) await clearObservations();
    setCapabilities(cameraRef.current.capabilities());
    setSession((previous) =>
      updated(previous, { captureSettings: settings, imageSize: settings }),
    );
    return pipelineChanged;
  }, [clearObservations]);

  const openCamera = useCallback(async (deviceId = selectedDeviceId) => {
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setCameraBusy(true);
    setError(undefined);
    setStatus("Requesting camera access…");
    if (setupVideoRef.current) setupVideoRef.current.srcObject = null;
    if (captureVideoRef.current) captureVideoRef.current.srcObject = null;
    setStream(undefined);
    setCapabilities(undefined);
    setCurrentDetection(undefined);
    currentDetectionRef.current = undefined;
    setCaptureDecision(undefined);
    drawDetection(overlayRef.current, undefined);
    captureGateRef.current.reset();
    try {
      const nextStream = await cameraRef.current.open({
        ...requestedSize,
        deviceId: deviceId || undefined,
        frameRate: 30,
      });
      const settings = cameraRef.current.settings();
      const pipelineChanged = await commitCameraSettings(settings);
      if (pipelineChanged) {
        setStatus("The stream configuration changed, so previous captures were cleared.");
      } else {
        setStatus(
          settings.width === requestedSize.width && settings.height === requestedSize.height
            ? `Camera ready at ${settings.width} × ${settings.height}.`
            : `The browser selected ${settings.width} × ${settings.height} instead of the requested mode.`,
        );
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
  }, [requestedSize, selectedDeviceId, commitCameraSettings]);

  const applyCameraSettings = useCallback(async () => {
    if (!stream) {
      await openCamera();
      return;
    }
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setCameraBusy(true);
    setError(undefined);
    setStatus("Applying resolution…");
    try {
      const settings = await cameraRef.current.applyResolution(requestedSize);
      const pipelineChanged = await commitCameraSettings(settings);
      if (pipelineChanged) {
        setStatus("The stream resolution changed, so previous captures were cleared.");
      } else {
        setStatus(
          settings.width === requestedSize.width && settings.height === requestedSize.height
            ? `Camera ready at ${settings.width} × ${settings.height}.`
            : `The browser selected ${settings.width} × ${settings.height} instead of the requested mode.`,
        );
      }
    } catch (cameraError) {
      if (!isOperationCancellation(cameraError)) {
        setStatus(undefined);
        setError(errorText(cameraError));
      }
    } finally {
      cameraBusyRef.current = false;
      setCameraBusy(false);
    }
  }, [stream, openCamera, requestedSize, commitCameraSettings]);

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
      setCapabilities(undefined);
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

  const applyZoom = useCallback(async (zoom: number) => {
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setCameraBusy(true);
    setError(undefined);
    try {
      const settings = await cameraRef.current.applyZoom(zoom);
      const pipelineChanged = await commitCameraSettings(settings);
      setStatus(`Zoom changed to ${zoom.toFixed(1)}×.`);
      if (pipelineChanged) setStatus(`Zoom changed to ${zoom.toFixed(1)}×; previous captures were cleared.`);
    } catch (zoomError) {
      if (!isOperationCancellation(zoomError)) setError(errorText(zoomError));
    } finally {
      cameraBusyRef.current = false;
      setCameraBusy(false);
    }
  }, [commitCameraSettings]);

  const applyFocusMode = useCallback(async (focusMode: string) => {
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setCameraBusy(true);
    setError(undefined);
    try {
      const settings = await cameraRef.current.applyFocusMode(focusMode);
      const pipelineChanged = await commitCameraSettings(settings);
      setStatus(`Focus mode changed to ${focusMode}.`);
      if (pipelineChanged) setStatus(`Focus mode changed to ${focusMode}; previous captures were cleared.`);
    } catch (focusError) {
      if (!isOperationCancellation(focusError)) setError(errorText(focusError));
    } finally {
      cameraBusyRef.current = false;
      setCameraBusy(false);
    }
  }, [commitCameraSettings]);

  const storeObservation = useCallback(
    async (
      detection: DetectionResult,
      imageBlob: Blob,
      source: FrameObservation["source"],
      sourceName?: string,
      include = true,
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
      if (!detection?.quality.basicValid || !isUsableDetection(detection) || !video) {
        setStatus("A valid board detection is required before capture.");
        return;
      }
      if (sessionRef.current.observations.filter((view) => view.included).length >= 30) {
        setStatus("The 30-view capture limit has been reached.");
        return;
      }
      captureBusyRef.current = true;
      const generation = sessionGenerationRef.current;
      try {
        const blob = await videoFrameBlob(video);
        await storeObservation(detection, blob, "live", undefined, true, generation);
        captureGateRef.current.markCaptured();
        setStatus(`Captured view ${sessionRef.current.observations.length + 1}.`);
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
        if (autoCapture && decision.accept) await captureCurrentFrame();
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
      .slice(0, MAX_IMPORT_FILES);
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
        let initiallyIncluded = sessionRef.current.observations.filter(
          (view) => view.included,
        ).length;
        if (sessionRef.current.imageSize && !sameSize(sessionRef.current.imageSize, group)) {
          await clearObservations();
          generation = sessionGenerationRef.current;
          initiallyIncluded = 0;
          setStatus("Existing captures were cleared because the imported resolution is different.");
        }
        let accepted = 0;
        let rejected = 0;
        let skippedByLimit = 0;
        for (const [index, file] of group.files.entries()) {
          if (generation !== sessionGenerationRef.current) {
            throw new SessionOperationCancelledError();
          }
          if (initiallyIncluded + accepted >= 30) {
            skippedByLimit = group.files.length - index;
            break;
          }
          setStatus(`Processing ${index + 1} of ${group.files.length}: ${file.name}`);
          const bitmap = await decodeImage(file);
          const detection = await worker.detect(bitmap, sessionRef.current.pattern);
          if (generation !== sessionGenerationRef.current) {
            throw new SessionOperationCancelledError();
          }
          if (!detection.quality.basicValid || !isUsableDetection(detection)) {
            rejected += 1;
            continue;
          }
          await storeObservation(detection, file, "upload", file.name, true, generation);
          accepted += 1;
        }
        setImportGroups([]);
        setStatus(
          `Imported ${accepted} valid views; ${rejected} images did not contain a usable board${
            skippedByLimit ? `; ${skippedByLimit} images were not processed after reaching the 30-view limit` : ""
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
        session.captureSettings,
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
      setStatus("Calibration solved successfully.");
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

  const resetEverything = useCallback(async () => {
    sessionGenerationRef.current += 1;
    clearTimeout(saveTimerRef.current);
    cameraRef.current.stop();
    if (setupVideoRef.current) setupVideoRef.current.srcObject = null;
    if (captureVideoRef.current) captureVideoRef.current.srcObject = null;
    setStream(undefined);
    setCapabilities(undefined);
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
        <div class="brand"><strong>Lensbench</strong></div>
        <div class="privacy-pill">Local processing</div>
      </header>

      <main>
        <div class="hero-copy">
          <h1>Camera calibration</h1>
          <p>{patternLabel(session.pattern)} · {session.lensModel === "pinhole-radtan5" ? "Standard lens" : "Fisheye"}</p>
        </div>
        <Stepper step={session.step} />

        {error && <Status tone="error">{error}</Status>}
        {status && <Status>{status}</Status>}
        {workerStatus === "loading" && <Status>Loading the OpenCV calibration engine…</Status>}

        {session.step === "setup" && (
          <div class="setup-layout">
            <section class="panel camera-panel">
              <div class="panel-heading"><h2>Camera</h2><span class={stream ? "ready-dot" : "idle-dot"}>{stream ? "Ready" : "Not connected"}</span></div>
              <div class="camera-preview compact">
                {stream ? <video ref={attachPreview} autoplay muted playsinline /> : <div class="empty-preview"><p>No camera connected</p></div>}
              </div>
              <div class="form-grid">
                <label class="field span-two"><span>Camera</span><select value={selectedDeviceId} disabled={cameraBusy} onChange={(event) => selectCamera(event.currentTarget.value)}><option value="">Default camera</option>{devices.map((device, index) => <option key={`${device.deviceId}-${index}`} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>
                <label class="field span-two"><span>Requested resolution</span><select value={`${requestedSize.width}x${requestedSize.height}`} disabled={cameraBusy} onChange={(event) => { const selected = RESOLUTION_PRESETS.find((size) => `${size.width}x${size.height}` === event.currentTarget.value); if (selected) setRequestedSize({ width: selected.width, height: selected.height }); }}>{RESOLUTION_PRESETS.map((size) => <option key={`${size.width}x${size.height}`} value={`${size.width}x${size.height}`}>{size.label}</option>)}</select></label>
                <label class="field span-two"><span>Lens model</span><select value={session.lensModel} onChange={(event) => { const lensModel = event.currentTarget.value as LensModel; setSession((previous) => updated(previous, { lensModel, result: undefined })); }}><option value="pinhole-radtan5">Standard lens · radial/tangential 5</option><option value="fisheye-kb4">Fisheye · four coefficients</option></select></label>
              </div>
              <div class="button-row"><button type="button" class="button secondary" disabled={cameraBusy} onClick={() => void applyCameraSettings()}>{cameraBusy ? "Working…" : stream ? "Apply resolution" : "Connect camera"}</button></div>
              {session.captureSettings && <dl class="settings-summary"><div><dt>Actual stream</dt><dd>{session.captureSettings.width} × {session.captureSettings.height}</dd></div><div><dt>Frame rate</dt><dd>{session.captureSettings.frameRate?.toFixed(1) ?? "Browser default"}</dd></div><div><dt>Resize mode</dt><dd>{session.captureSettings.resizeMode ?? "Not reported"}</dd></div></dl>}
              {capabilities?.zoom && <label class="field"><span>Optical/digital zoom: {session.captureSettings?.zoom?.toFixed(1) ?? capabilities.zoom.min.toFixed(1)}×</span><input type="range" min={capabilities.zoom.min} max={capabilities.zoom.max} step={capabilities.zoom.step || 0.1} value={session.captureSettings?.zoom ?? capabilities.zoom.min} disabled={cameraBusy} onChange={(event) => void applyZoom(Number(event.currentTarget.value))} /></label>}
              {capabilities?.focusMode && <label class="field"><span>Focus mode</span><select value={session.captureSettings?.focusMode} disabled={cameraBusy} onChange={(event) => void applyFocusMode(event.currentTarget.value)}>{capabilities.focusMode.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>}
            </section>

            <PatternEditor pattern={session.pattern} onChange={setPattern} />

            <section class="panel setup-actions">
              <div><h2>Target file</h2><p class="muted">Print at 100%. Verify the 100 mm ruler.</p></div>
              {patternErrors.map((message) => <Status key={message} tone="error">{message}</Status>)}
              <div class="button-row"><button type="button" class="button secondary" disabled={workerStatus !== "ready" || patternErrors.length > 0} onClick={() => void downloadPattern()}>Download board SVG</button><button type="button" class="button primary" disabled={workerStatus !== "ready" || patternErrors.length > 0} onClick={() => setStep("capture")}>Start capture</button></div>
            </section>
          </div>
        )}

        {session.step === "capture" && (
          <div class="capture-layout">
            <section class="panel capture-main">
              <div class="panel-heading"><h2>Capture</h2><label class="switch"><input type="checkbox" checked={autoCapture} onChange={(event) => setAutoCapture(event.currentTarget.checked)} /><span /> Auto capture</label></div>
              {stream ? <div class="camera-preview live"><video ref={captureVideoRef} autoplay muted playsinline /><canvas ref={overlayRef} /><div class="view-counter">{progress.accepted}<small>/ 20 views</small></div></div> : <div class="empty-capture"><span>Camera is not connected.</span><button type="button" class="button secondary" onClick={() => setStep("setup")}>Configure camera</button></div>}
              <div class="capture-message"><span class={currentDetection?.quality.basicValid ? "signal good" : "signal"} /> <strong>{captureDecision?.reasons[0] ?? "Show the entire board to the camera."}</strong></div>
              <div class="button-row"><button type="button" class="button secondary" disabled={importBusy || !captureDecision?.basicValid || !stream || progress.accepted >= 30} onClick={() => void captureCurrentFrame()}>Capture now</button><label class={`button secondary file-button${importBusy ? " disabled" : ""}`}>Import images<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={importBusy} onChange={(event) => { const input = event.currentTarget; const files = Array.from(input.files ?? []); input.value = ""; void chooseImportFiles(files); }} /></label><button type="button" class="button secondary" disabled={importBusy} onClick={() => setStep("setup")}>Camera settings</button><button type="button" class="button primary" disabled={importBusy || !progress.minimumReached} onClick={() => setStep("review")}>Review {progress.accepted} views</button></div>
              {importGroups.length > 0 && <div class="import-groups"><h3>Choose one resolution</h3>{importGroups.map((group) => <button key={group.key} type="button" disabled={importBusy} onClick={() => void processImportGroup(group)}><strong>{group.width} × {group.height}</strong><span>{group.files.length} images</span></button>)}</div>}
            </section>
            <aside class="panel capture-guide"><h2>Coverage</h2><CoverageGrid observations={session.observations} /><dl class="progress-list"><div><dt>Views</dt><dd>{progress.accepted} / 20</dd></div><div><dt>Cells</dt><dd>{progress.occupiedCells} / 6</dd></div><div><dt>Tilted</dt><dd>{progress.tiltedViews} / 4</dd></div><div><dt>Scale</dt><dd>{progress.scaleRatio.toFixed(1)}× / 1.8×</dd></div></dl><p class="capture-hint">Cover edges and corners. Vary distance and tilt.</p>{progress.targetReached && <Status tone="success">Coverage target reached.</Status>}</aside>
          </div>
        )}

        {session.step === "review" && (
          <div class="review-layout">
            <section class="panel review-summary"><div><h2>Views ({progress.accepted} included)</h2><p class="muted">Toggle views before calibration.</p></div><CoverageGrid observations={session.observations} /><div class="button-row"><button type="button" class="button secondary" disabled={solving} onClick={() => setStep("capture")}>Add views</button><button type="button" class="button primary" disabled={!progress.minimumReached || solving} onClick={() => void solveCalibration()}>{solving ? "Solving…" : "Run calibration"}</button></div></section>
            <section class="observation-grid" aria-label="Captured calibration views">
              {session.observations.map((observation, index) => (
                <article key={observation.id} class={`observation-card ${observation.included ? "" : "excluded"}`}>
                  <div class="observation-image"><ObservationThumbnail observation={observation} /><span>#{index + 1}</span></div>
                  <div class="observation-details">
                    <strong>{observation.sourceName ?? `${observation.source} capture`}</strong>
                    <small>{observation.quality.detectedCorners} corners · sharpness {observation.quality.sharpness.toFixed(0)}</small>
                    {observation.perViewRms !== undefined && <small>RMS {observation.perViewRms.toFixed(3)} px</small>}
                    {observation.autoExcludedReason && <small>{observation.autoExcludedReason}</small>}
                    <label class="check"><input type="checkbox" checked={observation.included} disabled={solving} onChange={(event) => { const included = event.currentTarget.checked; setSession((previous) => updated(previous, { observations: previous.observations.map((candidate) => candidate.id === observation.id ? { ...candidate, included, autoExcludedReason: undefined } : candidate), result: undefined })); }} /> Include view</label>
                  </div>
                </article>
              ))}
            </section>
          </div>
        )}

        {session.step === "results" && session.result && (
          <div class="results-layout">
            <section class="panel result-summary"><div class="result-title"><div><h2>{session.result.model === "pinhole-radtan5" ? "Standard lens" : "Fisheye"}</h2><p class="muted">{session.result.imageSize.width} × {session.result.imageSize.height} · OpenCV {session.result.generator.opencvVersion}</p></div><div class={`score ${session.result.rmsReprojectionError <= (session.result.model === "pinhole-radtan5" ? 0.5 : 0.8) ? "good" : "warn"}`}><strong>{session.result.rmsReprojectionError.toFixed(3)}</strong><span>px RMS</span></div></div><ResultMatrix result={session.result} /><div class="button-row"><button type="button" class="button secondary" onClick={() => downloadText("camera-calibration.json", resultJson(session.result!), "application/json")}>Export JSON</button><button type="button" class="button secondary" onClick={() => downloadText("camera-calibration.yaml", toOpenCvYaml(session.result!), "application/yaml")}>Export YAML</button><button type="button" class="button primary" onClick={() => setStep("review")}>Review views</button></div>{session.result.excludedViewIds.length > 0 && <Status>{session.result.excludedViewIds.length} unstable or high-error view(s) excluded.</Status>}</section>
            <LiveResultPreview stream={stream} result={session.result} worker={worker} />
          </div>
        )}
      </main>

      <footer><button type="button" onClick={() => void resetEverything()}>Delete local data</button><span>{opencvVersion ? `OpenCV ${opencvVersion}` : "OpenCV unavailable"}</span></footer>

      {restoreCandidate && !restoreResolved && <div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title"><h2 id="restore-title">Restore session?</h2><p>{restoreCandidate.observations.length} views saved {new Date(restoreCandidate.updatedAt).toLocaleString()}.</p><div class="button-row"><button type="button" class="button secondary" disabled={restoreBusy} onClick={() => void discardRestore()}>{restoreBusy ? "Discarding…" : "Discard"}</button><button type="button" class="button primary" disabled={restoreBusy} onClick={() => { sessionGenerationRef.current += 1; setSession(restoreCandidate); setRestoreCandidate(undefined); setRestoreResolved(true); setStatus("Saved session restored."); }}>Restore</button></div></div></div>}
    </div>
  );
}
