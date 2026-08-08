import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  displayBoardGeometry,
  type DisplayViewport,
} from "../domain/display-board";
import type { PatternConfig } from "../domain/types";
import { CalibrationWorkerClient } from "../worker/client";

interface WebkitFullscreenDocument extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function currentViewport(): DisplayViewport {
  return {
    widthCss: window.visualViewport?.width || window.innerWidth || 1,
    heightCss: window.visualViewport?.height || window.innerHeight || 1,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function fullscreenElement(): Element | null | undefined {
  const webkitDocument = document as WebkitFullscreenDocument;
  return document.fullscreenElement ?? webkitDocument.webkitFullscreenElement;
}

function fullscreenSupported(): boolean {
  const root = document.documentElement as WebkitFullscreenElement;
  return Boolean(root.requestFullscreen || root.webkitRequestFullscreen);
}

async function toggleFullscreen(): Promise<void> {
  const webkitDocument = document as WebkitFullscreenDocument;
  const root = document.documentElement as WebkitFullscreenElement;
  if (fullscreenElement()) {
    if (document.exitFullscreen) await document.exitFullscreen();
    else await webkitDocument.webkitExitFullscreen?.();
  } else if (root.requestFullscreen) {
    await root.requestFullscreen();
  } else {
    await root.webkitRequestFullscreen?.();
  }
}

export function DisplayBoardPage({
  pattern,
  initialError,
}: {
  pattern?: PatternConfig;
  initialError?: string;
}) {
  const clientRef = useRef<CalibrationWorkerClient>();
  const [viewport, setViewport] = useState(currentViewport);
  const [ready, setReady] = useState(false);
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string | undefined>(initialError);
  const [fullscreen, setFullscreen] = useState(Boolean(fullscreenElement()));

  const geometryResult = useMemo(() => {
    if (!pattern) return { error: initialError ?? "Invalid display board link." };
    try {
      return { geometry: displayBoardGeometry(pattern, viewport) };
    } catch (geometryError) {
      return {
        error: geometryError instanceof Error ? geometryError.message : String(geometryError),
      };
    }
  }, [initialError, pattern, viewport]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Display Board";
    const refresh = () => setViewport(currentViewport());
    const handleFullscreenChange = () => {
      refresh();
      setFullscreen(Boolean(fullscreenElement()));
    };
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      window.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("resize", refresh);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (!pattern) return;
    const client = new CalibrationWorkerClient();
    clientRef.current = client;
    let cancelled = false;
    void client.initialize()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((initializationError) => {
        if (!cancelled) {
          setError(initializationError instanceof Error
            ? initializationError.message
            : String(initializationError));
        }
      });
    return () => {
      cancelled = true;
      clientRef.current = undefined;
      void client.dispose().catch(() => undefined);
    };
  }, [pattern]);

  useEffect(() => {
    const client = clientRef.current;
    const geometry = geometryResult.geometry;
    if (!client || !ready || !pattern || !geometry) return;
    let cancelled = false;
    setSvg(undefined);
    setError(undefined);
    void client.displayPatternSvg(pattern, geometry.squarePixels, geometry.markerPixels ?? 0)
      .then((generatedSvg) => {
        if (!cancelled) setSvg(generatedSvg);
      })
      .catch((generationError) => {
        if (!cancelled) {
          setError(generationError instanceof Error ? generationError.message : String(generationError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [geometryResult.geometry, pattern, ready]);

  const activeError = geometryResult.error ?? error;
  const geometry = geometryResult.geometry;
  return (
    <main class="display-board-page">
      <div class="display-board-controls">
        <button
          type="button"
          class="button secondary"
          disabled={!fullscreenSupported()}
          onClick={() => void toggleFullscreen().catch(() => setError("Fullscreen unavailable."))}
        >
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      {geometry && svg ? (
        <div
          class="display-board-target"
          style={{ width: `${geometry.boardWidthCss}px`, height: `${geometry.boardHeightCss}px` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : activeError ? (
        <span class="display-board-error" role="alert">{activeError}</span>
      ) : (
        <span class="display-board-loading">Loading…</span>
      )}
    </main>
  );
}
