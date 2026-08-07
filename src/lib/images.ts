import type { ImageSize } from "../domain/types";

export interface ImageFileGroup extends ImageSize {
  key: string;
  files: File[];
}

const MAX_DECODED_PIXELS = 40_000_000;

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_DECODED_PIXELS
  ) {
    throw new Error("The image dimensions are invalid or exceed the 40-megapixel limit.");
  }
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

export async function groupImageFiles(files: File[]): Promise<ImageFileGroup[]> {
  const groups = new Map<string, ImageFileGroup>();
  for (const file of files) {
    const bitmap = await decodeImage(file);
    try {
      validateDimensions(bitmap.width, bitmap.height);
      const key = `${bitmap.width}x${bitmap.height}`;
      const group = groups.get(key) ?? {
        key,
        width: bitmap.width,
        height: bitmap.height,
        files: [],
      };
      group.files.push(file);
      groups.set(key, group);
    } finally {
      bitmap.close();
    }
  }
  return [...groups.values()].sort((left, right) => right.files.length - left.files.length);
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  validateDimensions(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create a 2D canvas.");
  return context;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The browser could not encode the frame."))),
      type,
      quality,
    );
  });
}

export async function videoFrameBlob(video: HTMLVideoElement): Promise<Blob> {
  const canvas = canvasFor(video.videoWidth, video.videoHeight);
  canvasContext(canvas).drawImage(video, 0, 0);
  try {
    return await canvasBlob(canvas, "image/webp", 0.92);
  } catch {
    return canvasBlob(canvas, "image/png");
  }
}

export async function thumbnailBlob(blob: Blob, maxEdge = 320): Promise<Blob> {
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) {
    throw new Error("Thumbnail size must be greater than zero.");
  }
  const bitmap = await decodeImage(blob);
  try {
    validateDimensions(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = canvasFor(width, height);
    canvasContext(canvas).drawImage(bitmap, 0, 0, width, height);
    return await canvasBlob(canvas, "image/webp", 0.78);
  } finally {
    bitmap.close();
  }
}
