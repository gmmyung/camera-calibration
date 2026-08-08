/// <reference lib="webworker" />

import type { DetectionResult } from "../domain/types";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { calibrationErrorMessage } from "./error-message";
import {
  calibrationResultFromNative,
  loadCalibrationModule,
  type CalibrationWasmModule,
} from "./wasm-module";

const context = self as DedicatedWorkerGlobalScope;
const MAX_WORKING_EDGE = 1920;
const MAX_SOURCE_PIXELS = 40_000_000;
let module: CalibrationWasmModule | undefined;

function requireModule(): CalibrationWasmModule {
  if (!module) throw new Error("The OpenCV module is not initialized.");
  return module;
}

function bitmapPixels(bitmap: ImageBitmap): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
} {
  try {
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error("The source frame is empty.");
    if (sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
      throw new Error("The source frame exceeds the 40-megapixel limit.");
    }
    const scale = Math.min(1, MAX_WORKING_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = new OffscreenCanvas(width, height);
    const renderingContext = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!renderingContext) throw new Error("Offscreen 2D canvas is unavailable.");
    renderingContext.drawImage(bitmap, 0, 0, width, height);
    const imageData = renderingContext.getImageData(0, 0, width, height);
    return {
      rgba: imageData.data,
      width,
      height,
      scaleX: sourceWidth / width,
      scaleY: sourceHeight / height,
    };
  } finally {
    bitmap.close();
  }
}

function sourceScaleDetection(
  detection: DetectionResult,
  sourceWidth: number,
  sourceHeight: number,
  scaleX: number,
  scaleY: number,
): DetectionResult {
  return {
    ...detection,
    imageSize: { width: sourceWidth, height: sourceHeight },
    imagePoints: detection.imagePoints.map(({ x, y }) => ({ x: x * scaleX, y: y * scaleY })),
    quality: {
      ...detection.quality,
      minEdgeDistancePx: detection.quality.minEdgeDistancePx * Math.min(scaleX, scaleY),
    },
  };
}

context.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    let response: WorkerResponse;
    switch (request.type) {
      case "INIT": {
        module = await loadCalibrationModule(request.moduleUrl);
        response = {
          id: request.id,
          ok: true,
          type: request.type,
          opencvVersion: module.getOpenCvVersion(),
        };
        break;
      }
      case "DETECT_FRAME": {
        const sourceWidth = request.bitmap.width;
        const sourceHeight = request.bitmap.height;
        const pixels = bitmapPixels(request.bitmap);
        const nativeDetection = requireModule().detectFrame(
          pixels.rgba,
          pixels.width,
          pixels.height,
          request.pattern,
        );
        response = {
          id: request.id,
          ok: true,
          type: request.type,
          detection: sourceScaleDetection(
            nativeDetection,
            sourceWidth,
            sourceHeight,
            pixels.scaleX,
            pixels.scaleY,
          ),
        };
        break;
      }
      case "SOLVE_CALIBRATION": {
        const native = requireModule().solveCalibration(
          request.observations.filter((observation) => observation.included),
          request.model,
          request.imageSize.width,
          request.imageSize.height,
        );
        response = {
          id: request.id,
          ok: true,
          type: request.type,
          result: calibrationResultFromNative(
            native,
            request.model,
            request.pattern,
            request.imageSize,
            request.observations,
            request.captureSettings,
          ),
        };
        break;
      }
      case "UNDISTORT_FRAME": {
        const pixels = bitmapPixels(request.bitmap);
        const native = requireModule().undistortFrame(
          pixels.rgba,
          pixels.width,
          pixels.height,
          request.calibration,
        );
        if (!native.ok) throw new Error(native.error || "OpenCV could not undistort the frame.");
        if (
          native.width !== pixels.width ||
          native.height !== pixels.height ||
          !(native.rgba instanceof Uint8Array) ||
          native.rgba.byteLength !== native.width * native.height * 4
        ) {
          throw new Error("OpenCV returned an invalid undistorted frame.");
        }
        response = {
          id: request.id,
          ok: true,
          type: request.type,
          frame: {
            width: native.width,
            height: native.height,
            rgba: new Uint8ClampedArray(native.rgba),
          },
        };
        context.postMessage(response, [response.frame.rgba.buffer]);
        return;
      }
      case "GENERATE_PATTERN_SVG": {
        response = {
          id: request.id,
          ok: true,
          type: request.type,
          svg: requireModule().generatePatternSvg(request.pattern),
        };
        break;
      }
      case "GENERATE_DISPLAY_PATTERN_SVG": {
        response = {
          id: request.id,
          ok: true,
          type: request.type,
          svg: requireModule().generateDisplayPatternSvg(
            request.pattern,
            request.squarePixels,
            request.markerPixels ?? 0,
          ),
        };
        break;
      }
    }
    context.postMessage(response);
  } catch (error) {
    const message = calibrationErrorMessage(error, module);
    console.error(`Calibration worker request ${request.type} failed: ${message}`, error);
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      type: request.type,
      error: message,
    };
    context.postMessage(response);
  }
});

export {};
