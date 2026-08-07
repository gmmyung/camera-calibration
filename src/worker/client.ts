import type {
  CalibrationResultV1,
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

export class CalibrationWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (response: SuccessfulResponse) => void; reject: (error: Error) => void }
  >();

  constructor() {
    this.worker = new Worker(new URL("./calibration.worker.ts", import.meta.url), {
      type: "module",
      name: "calibration-worker",
    });
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The calibration worker crashed.");
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
    });
  }

  async initialize(): Promise<string> {
    const moduleUrl = new URL("wasm/calibration.js", document.baseURI).href;
    const response = await this.request({ type: "INIT", moduleUrl });
    if (response.type !== "INIT") throw new Error("Unexpected worker response.");
    return response.opencvVersion;
  }

  async detect(bitmap: ImageBitmap, pattern: PatternConfig) {
    const response = await this.request({ type: "DETECT_FRAME", bitmap, pattern }, [bitmap]);
    if (response.type !== "DETECT_FRAME") throw new Error("Unexpected worker response.");
    return response.detection;
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
  ): Promise<UndistortedFrame> {
    const response = await this.request(
      { type: "UNDISTORT_FRAME", bitmap, calibration },
      [bitmap],
    );
    if (response.type !== "UNDISTORT_FRAME") throw new Error("Unexpected worker response.");
    return response.frame;
  }

  async patternSvg(pattern: PatternConfig): Promise<string> {
    const response = await this.request({ type: "GENERATE_PATTERN_SVG", pattern });
    if (response.type !== "GENERATE_PATTERN_SVG") throw new Error("Unexpected worker response.");
    return response.svg;
  }

  async dispose(): Promise<void> {
    try {
      await this.request({ type: "DISPOSE" });
    } finally {
      this.worker.removeEventListener("message", this.onMessage);
      this.worker.terminate();
    }
  }

  private request(
    request: WorkerRequestWithoutId,
    transfer: Transferable[] = [],
  ): Promise<SuccessfulResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id } as WorkerRequest, transfer);
    });
  }

  private onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (!response.ok) {
      pending.reject(new Error(response.error));
      return;
    }
    pending.resolve(response);
  };
}
