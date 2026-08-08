import { useEffect, useMemo, useState } from "preact/hooks";
import {
  displayBoardGeometry,
  type DisplayViewport,
} from "../domain/display-board";
import type { PatternConfig } from "../domain/types";
import type { CalibrationWorkerClient } from "../worker/client";

function currentViewport(): DisplayViewport {
  return {
    widthCss: window.visualViewport?.width || window.innerWidth || 1,
    heightCss: window.visualViewport?.height || window.innerHeight || 1,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function requestFullscreen(): void {
  if (!document.documentElement.requestFullscreen) return;
  void document.documentElement.requestFullscreen().catch(() => undefined);
}

export function DisplayTargetPanel({
  settingsVisible,
  pattern,
  worker,
  workerReady,
  onStartCapture,
}: {
  settingsVisible: boolean;
  pattern: PatternConfig;
  worker?: CalibrationWorkerClient;
  workerReady: boolean;
  onStartCapture: () => void;
}) {
  const [viewport, setViewport] = useState(currentViewport);
  const [open, setOpen] = useState(false);
  const [displaySvg, setDisplaySvg] = useState<string>();
  const [error, setError] = useState<string>();

  const geometryResult = useMemo(() => {
    try {
      return { geometry: displayBoardGeometry(pattern, viewport) };
    } catch (geometryError) {
      return {
        error: geometryError instanceof Error ? geometryError.message : String(geometryError),
      };
    }
  }, [pattern, viewport]);

  useEffect(() => {
    const refresh = () => setViewport(currentViewport());
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
    return () => {
      window.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("resize", refresh);
    };
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setViewport(currentViewport());
      if (open && !document.fullscreenElement) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (open && event.key === "Escape") setOpen(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useEffect(() => {
    const geometry = geometryResult.geometry;
    if (!open || !worker || !workerReady || !geometry) return;
    let cancelled = false;
    setDisplaySvg(undefined);
    setError(undefined);
    void worker
      .displayPatternSvg(pattern, geometry.squarePixels, geometry.markerPixels ?? 0)
      .then((svg) => {
        if (!cancelled) setDisplaySvg(svg);
      })
      .catch((generationError) => {
        if (!cancelled) {
          setError(generationError instanceof Error ? generationError.message : String(generationError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [geometryResult.geometry, open, pattern, worker, workerReady]);

  const showBoard = () => {
    setError(undefined);
    setDisplaySvg(undefined);
    setOpen(true);
    onStartCapture();
    requestFullscreen();
  };

  const closeBoard = () => {
    setOpen(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };

  const geometry = geometryResult.geometry;
  return (
    <>
      {settingsVisible && (
        <section class="panel display-board-panel">
          <div class="panel-heading"><h2>Display board</h2></div>
          {geometryResult.error && <p class="field-error" role="alert">{geometryResult.error}</p>}
          <button
            type="button"
            class="button secondary"
            disabled={!workerReady || !worker || !geometry}
            onClick={showBoard}
          >
            Display board
          </button>
        </section>
      )}

      {open && (
        <div class="display-board-overlay" role="dialog" aria-modal="true" aria-label="Calibration board display">
          <div class="display-board-toolbar">
            <button type="button" class="button secondary" onClick={closeBoard}>Exit</button>
          </div>
          {geometry && displaySvg ? (
            <div
              class="display-board-target"
              style={{ width: `${geometry.boardWidthCss}px`, height: `${geometry.boardHeightCss}px` }}
              dangerouslySetInnerHTML={{ __html: displaySvg }}
            />
          ) : error ? (
            <span class="display-board-error" role="alert">{error}</span>
          ) : (
            <span class="display-board-loading">Preparing board…</span>
          )}
        </div>
      )}
    </>
  );
}
