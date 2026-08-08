import type {
  CalibrationResultV1,
  CorrectedPreviewMode,
  FrameObservation,
  ImageSize,
  LensModel,
  PatternConfig,
} from "../domain/types";
import type { UndistortedFrame, WorkerRequest, WorkerResponse } from "./protocol";

type SuccessfulResponse = Extract<WorkerResponse, { ok: true }>;
type WorkerRequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

interface PendingRequest {
  resolve: (response: SuccessfulResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

export class CalibrationWorkerClient {
  private readonly worker: Worker;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private terminalError?: Error;

  constructor(worker?: Worker, requestTimeoutMs = 60_000) {
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("The calibration worker timeout must be greater than zero.");
    }
    this.worker =
      worker ??
      new Worker(new URL("./calibration.worker.ts", import.meta.url), {
        type: "module",
        name: "calibration-worker",
      });
    this.requestTimeoutMs = requestTimeoutMs;
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
    this.worker.addEventListener("messageerror", this.onMessageError);
  }

  async initialize(): Promise<string> {
    const moduleUrl = new URL("wasm/calibration.js", document.baseURI);
    moduleUrl.searchParams.set("v", __BUILD_ID__);
    const response = await this.request({ type: "INIT", moduleUrl: moduleUrl.href });
    if (response.type !== "INIT") throw new Error("Unexpected worker response.");
    return response.opencvVersion;
  }

  async detect(bitmap: ImageBitmap, pattern: PatternConfig) {
    try {
      const response = await this.request({ type: "DETECT_FRAME", bitmap, pattern }, [bitmap]);
      if (response.type !== "DETECT_FRAME") throw new Error("Unexpected worker response.");
      return response.detection;
    } finally {
      bitmap.close();
    }
  }

  async solve(
    observations: FrameObservation[],
    model: LensModel,
    pattern: PatternConfig,
    imageSize: ImageSize,
    captureSettings?: CalibrationResultV1["captureSettings"],
  ): Promise<CalibrationResultV1> {
    const response = await this.request({
      type: "SOLVE_CALIBRATION",
      observations,
      model,
      pattern,
      imageSize,
      captureSettings,
    });
    if (response.type !== "SOLVE_CALIBRATION") throw new Error("Unexpected worker response.");
    return response.result;
  }

  async undistort(
    bitmap: ImageBitmap,
    calibration: CalibrationResultV1,
    previewMode: CorrectedPreviewMode = "full",
  ): Promise<UndistortedFrame> {
    try {
      const response = await this.request(
        { type: "UNDISTORT_FRAME", bitmap, calibration, previewMode },
        [bitmap],
      );
      if (response.type !== "UNDISTORT_FRAME") throw new Error("Unexpected worker response.");
      return response.frame;
    } finally {
      bitmap.close();
    }
  }

  async patternSvg(pattern: PatternConfig): Promise<string> {
    const response = await this.request({ type: "GENERATE_PATTERN_SVG", pattern });
    if (response.type !== "GENERATE_PATTERN_SVG") throw new Error("Unexpected worker response.");
    return response.svg;
  }

  async displayPatternSvg(
    pattern: PatternConfig,
    squarePixels: number,
    markerPixels?: number,
  ): Promise<string> {
    const response = await this.request({
      type: "GENERATE_DISPLAY_PATTERN_SVG",
      pattern,
      squarePixels,
      markerPixels,
    });
    if (response.type !== "GENERATE_DISPLAY_PATTERN_SVG") {
      throw new Error("Unexpected worker response.");
    }
    return response.svg;
  }

  dispose(): Promise<void> {
    this.fail(new Error("The calibration worker was disposed."));
    return Promise.resolve();
  }

  private request(
    request: WorkerRequestWithoutId,
    transfer: Transferable[] = [],
  ): Promise<SuccessfulResponse> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.fail(
          new Error(`The calibration worker did not respond within ${this.requestTimeoutMs} ms.`),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...request, id } as WorkerRequest, transfer);
      } catch (error) {
        globalThis.clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const response = event.data;
    if (
      typeof response !== "object" ||
      response === null ||
      typeof response.id !== "number" ||
      typeof response.ok !== "boolean" ||
      typeof response.type !== "string"
    ) {
      this.fail(new Error("The calibration worker returned an unreadable response."));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    globalThis.clearTimeout(pending.timer);
    if (!response.ok) {
      if (typeof response.error !== "string" || response.error.length === 0) {
        const error = new Error("The calibration worker returned an unreadable error response.");
        pending.reject(error);
        this.fail(error);
        return;
      }
      pending.reject(new Error(response.error));
      return;
    }
    pending.resolve(response);
  };

  private onError = (event: ErrorEvent): void => {
    const detail = event.error instanceof Error ? event.error.message : event.message;
    console.error("The calibration worker crashed.", event.error ?? event.message);
    this.fail(new Error(detail || "The calibration worker crashed."));
  };

  private onMessageError = (): void => {
    this.fail(new Error("The calibration worker returned an unreadable response."));
  };

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("messageerror", this.onMessageError);
    this.pending.forEach(({ reject, timer }) => {
      globalThis.clearTimeout(timer);
      reject(error);
    });
    this.pending.clear();
    this.worker.terminate();
  }
}
