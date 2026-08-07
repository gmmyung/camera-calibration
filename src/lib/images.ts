import type { ImageSize } from "../domain/types";

export interface ImageFileGroup extends ImageSize {
  key: string;
  files: File[];
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

export async function groupImageFiles(files: File[]): Promise<ImageFileGroup[]> {
  const groups = new Map<string, ImageFileGroup>();
  for (const file of files) {
    const bitmap = await decodeImage(file);
    const key = `${bitmap.width}x${bitmap.height}`;
    const group = groups.get(key) ?? {
      key,
      width: bitmap.width,
      height: bitmap.height,
      files: [],
    };
    group.files.push(file);
    groups.set(key, group);
    bitmap.close();
  }
  return [...groups.values()].sort((left, right) => right.files.length - left.files.length);
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
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
  canvas.getContext("2d", { alpha: false })!.drawImage(video, 0, 0);
  try {
    return await canvasBlob(canvas, "image/webp", 0.92);
  } catch {
    return canvasBlob(canvas, "image/png");
  }
}

export async function thumbnailBlob(blob: Blob, maxEdge = 320): Promise<Blob> {
  const bitmap = await decodeImage(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = canvasFor(width, height);
  canvas.getContext("2d", { alpha: false })!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvasBlob(canvas, "image/webp", 0.78);
}
