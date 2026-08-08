import { useEffect, useRef, useState } from "preact/hooks";
import type { CalibrationResultV1, CorrectedPreviewMode } from "../domain/types";
import { decodeImage } from "../lib/images";
import type { CalibrationWorkerClient } from "../worker/client";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function ValidationImagePreview({
  result,
  worker,
}: {
  result: CalibrationResultV1;
  worker?: CalibrationWorkerClient;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [file, setFile] = useState<File>();
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [previewMode, setPreviewMode] = useState<CorrectedPreviewMode>(
    result.model === "fisheye-kb4" ? "fill" : "full",
  );
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string>();

  useEffect(() => {
    setPreviewMode(result.model === "fisheye-kb4" ? "fill" : "full");
  }, [result.createdAt, result.model]);

  useEffect(() => {
    if (!file) {
      setSourceUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!file || !worker) return;
    let cancelled = false;
    setBusy(true);
    setPreviewError(undefined);
    if (canvasRef.current) {
      canvasRef.current.width = 1;
      canvasRef.current.height = 1;
    }
    void decodeImage(file)
      .then(async (bitmap) => {
        if (bitmap.width !== result.imageSize.width || bitmap.height !== result.imageSize.height) {
          const dimensions = `${bitmap.width} × ${bitmap.height}`;
          bitmap.close();
          throw new Error(
            `Validation image is ${dimensions}; use ${result.imageSize.width} × ${result.imageSize.height}.`,
          );
        }
        return worker.undistort(bitmap, result, previewMode);
      })
      .then((frame) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) {
          throw new Error("The browser could not create the validation preview.");
        }
        canvas.width = frame.width;
        canvas.height = frame.height;
        const pixels = new Uint8ClampedArray(frame.rgba.length);
        pixels.set(frame.rgba);
        context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
      })
      .catch((previewFailure) => {
        if (!cancelled) setPreviewError(errorMessage(previewFailure));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file, previewMode, result, worker]);

  const chooseFile = (candidate?: File) => {
    if (!candidate) return;
    if (!/^image\/(?:jpeg|png|webp)$/.test(candidate.type) || candidate.size > MAX_FILE_BYTES) {
      setPreviewError("Choose a JPEG, PNG, or WebP image no larger than 25 MB.");
      return;
    }
    setFile(candidate);
  };
  const aspectRatio = `${result.imageSize.width} / ${result.imageSize.height}`;

  return (
    <section class="panel full-width validation-panel" aria-busy={busy}>
      <div class="panel-heading">
        <h2>Validation image</h2>
        <div class="panel-heading-actions">
          {result.model === "fisheye-kb4" && (
            <div class="segmented" role="group" aria-label="Validation correction view">
              <button type="button" disabled={busy} class={previewMode === "full" ? "selected" : ""} aria-pressed={previewMode === "full"} onClick={() => setPreviewMode("full")}>Full view</button>
              <button type="button" disabled={busy} class={previewMode === "fill" ? "selected" : ""} aria-pressed={previewMode === "fill"} onClick={() => setPreviewMode("fill")}>Fill view</button>
            </div>
          )}
          <label class={`button secondary file-button${busy || !worker ? " disabled" : ""}`}>
            {busy ? "Processing…" : file ? "Choose another image" : "Choose image"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy || !worker}
              onChange={(event) => {
                const input = event.currentTarget;
                chooseFile(input.files?.[0]);
                input.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {file ? (
        <div class="validation-grid">
          <figure>
            {sourceUrl ? (
              <img src={sourceUrl} alt="Original validation frame" style={{ aspectRatio }} />
            ) : (
              <div class="image-placeholder" style={{ aspectRatio }} />
            )}
            <figcaption>Original</figcaption>
          </figure>
          <figure>
            <canvas ref={canvasRef} style={{ aspectRatio }} />
            <figcaption>
              Corrected{result.model === "fisheye-kb4" ? ` · ${previewMode === "fill" ? "Fill" : "Full"}` : ""}
            </figcaption>
          </figure>
        </div>
      ) : (
        <p class="muted">Use a frame that was not included in the calibration.</p>
      )}
      {previewError && <div class="status status-error" role="alert">{previewError}</div>}
    </section>
  );
}
