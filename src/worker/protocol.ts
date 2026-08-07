import type {
  CalibrationResultV1,
  DetectionResult,
  FrameObservation,
  ImageSize,
  LensModel,
  PatternConfig,
} from "../domain/types";

export type WorkerRequest =
  | { id: number; type: "INIT"; moduleUrl: string }
  | { id: number; type: "DETECT_FRAME"; bitmap: ImageBitmap; pattern: PatternConfig }
  | {
      id: number;
      type: "SOLVE_CALIBRATION";
      observations: FrameObservation[];
      model: LensModel;
      pattern: PatternConfig;
      imageSize: ImageSize;
      captureSettings?: CalibrationResultV1["captureSettings"];
    }
  | {
      id: number;
      type: "UNDISTORT_FRAME";
      bitmap: ImageBitmap;
      calibration: CalibrationResultV1;
    }
  | { id: number; type: "GENERATE_PATTERN_SVG"; pattern: PatternConfig }
  | { id: number; type: "DISPOSE" };

export interface UndistortedFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export type WorkerResponse =
  | { id: number; ok: true; type: "INIT"; opencvVersion: string }
  | { id: number; ok: true; type: "DETECT_FRAME"; detection: DetectionResult }
  | { id: number; ok: true; type: "SOLVE_CALIBRATION"; result: CalibrationResultV1 }
  | { id: number; ok: true; type: "UNDISTORT_FRAME"; frame: UndistortedFrame }
  | { id: number; ok: true; type: "GENERATE_PATTERN_SVG"; svg: string }
  | { id: number; ok: true; type: "DISPOSE" }
  | { id: number; ok: false; type: WorkerRequest["type"]; error: string };
