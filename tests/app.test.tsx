import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { CHESSBOARD_PRESET } from "../src/domain/patterns";
import type { CalibrationSessionV1, FrameObservation } from "../src/domain/types";
import {
  clearLocalSession,
  getSessionBlob,
  loadActiveSession,
  putSessionBlob,
  saveActiveSession,
} from "../src/lib/session-db";

class InitializingWorker extends EventTarget {
  terminated = false;

  postMessage(message: unknown): void {
    const request = message as { id: number; type: string };
    if (request.type === "INIT") {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: {
              id: request.id,
              ok: true,
              type: "INIT",
              opencvVersion: "4.13.0-test",
            },
          }),
        );
      });
    } else if (request.type === "GENERATE_DISPLAY_PATTERN_SVG") {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: {
              id: request.id,
              ok: true,
              type: request.type,
              svg: '<svg width="360" height="252" viewBox="0 0 360 252"></svg>',
            },
          }),
        );
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

function completedSession(): CalibrationSessionV1 {
  const observations: FrameObservation[] = Array.from({ length: 12 }, (_, index) => ({
    id: `view-${index}`,
    source: "upload",
    sourceName: `frame-${index}.webp`,
    createdAt: "2026-08-07T00:00:00.000Z",
    imageSize: { width: 1280, height: 720 },
    imagePoints: [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ],
    objectPoints: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
    pointIds: [0, 1, 2, 3],
    quality: {
      sharpness: 100,
      boardAreaRatio: 0.1,
      minEdgeDistancePx: 100,
      detectedCorners: 4,
      availableCorners: 54,
      basicValid: true,
      messages: [],
    },
    pose: {
      centerX: 0.5,
      centerY: 0.5,
      areaRatio: 0.1,
      planeAngleDegrees: 15,
      coverageCell: index % 9,
    },
    imageBlobKey: `image-${index}`,
    thumbnailBlobKey: `thumbnail-${index}`,
    included: true,
  }));
  const includedViewIds = observations.map(({ id }) => id);
  return {
    schemaVersion: 1,
    id: "completed-session",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    step: "results",
    lensModel: "fisheye-kb4",
    pattern: CHESSBOARD_PRESET,
    imageSize: { width: 1280, height: 720 },
    observations,
    result: {
      schemaVersion: 1,
      generator: { appVersion: "test", opencvVersion: "4.13.0" },
      createdAt: "2026-08-07T00:00:00.000Z",
      model: "fisheye-kb4",
      imageSize: { width: 1280, height: 720 },
      cameraMatrix: [900, 0, 640, 0, 900, 360, 0, 0, 1],
      distortion: [0, 0, 0, 0],
      rmsReprojectionError: 0.3,
      perViewErrors: Object.fromEntries(includedViewIds.map((id) => [id, 0.3])),
      includedViewIds,
      excludedViewIds: [],
      board: CHESSBOARD_PRESET,
      poses: includedViewIds.map((viewId) => ({
        viewId,
        rotationVector: [0, 0, 0],
        translationVector: [0, 0, 1],
      })),
    },
  };
}

describe("application shell", () => {
  beforeEach(async () => {
    await clearLocalSession();
    localStorage.clear();
    vi.stubGlobal("Worker", InitializingWorker);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    if (originalMediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(navigator, "mediaDevices");
    }
  });

  it("initializes the calibration engine and exposes bounded target controls", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Web Camera Calibration Tool", level: 1 })).toBeTruthy();
    expect(screen.queryByText("Local processing")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Camera calibration" })).toBeNull();
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Download board SVG" });
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByRole("heading", { name: "Calibration board" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Display board" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open board in new tab" })).toBeTruthy();
    expect(screen.queryByLabelText("Display profile")).toBeNull();
    expect(screen.queryByLabelText("Display preset")).toBeNull();
    expect(screen.queryByText(/ppi|ruler|square size|marker size/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Target" })).toBeNull();
    expect(screen.getByLabelText("Columns (squares)").getAttribute("max")).toBe("30");
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Height") as HTMLInputElement).value).toBe("");
    const connectButton = screen.getByRole("button", { name: "Connect camera" });
    expect(connectButton.getAttribute("type")).toBe("button");
    expect(connectButton.closest(".empty-preview")).not.toBeNull();
    expect(screen.queryByText("Print at 100%. Verify the 100 mm ruler.")).toBeNull();
    expect(screen.getByText("OpenCV 4.13.0-test")).toBeTruthy();
    expect(screen.getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe(
      "https://github.com/gmmyung/camera-calibration",
    );
    expect(screen.queryByText("AI-assisted software; verify calibration results.")).toBeNull();
  });

  it("refreshes the reported stream dimensions when an exact mode is rejected", async () => {
    let settings = {
      width: 640,
      height: 480,
      deviceId: "camera-1",
      frameRate: 30,
    };
    const track = {
      label: "Test camera",
      readyState: "live",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSettings: vi.fn(() => settings),
      getCapabilities: vi.fn(() => ({
        width: { min: 1, max: 4224 },
        height: { min: 1, max: 4224 },
        zoom: { min: 1, max: 4, step: 0.1 },
      })),
      applyConstraints: vi.fn(async () => {
        settings = { ...settings, width: 800, height: 450 };
      }),
    };
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => stream),
        enumerateDevices: vi.fn(async () => []),
        getSupportedConstraints: vi.fn(() => ({ resizeMode: false })),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Connect camera" }));
    await waitFor(() => expect(screen.getByText("640 × 480")).toBeTruthy());
    expect(screen.getByText("Not reported by browser")).toBeTruthy();
    expect(screen.queryByText(/reported bounds/i)).toBeNull();
    expect(screen.getByLabelText("Width").getAttribute("max")).toBe("32768");
    expect(screen.getByLabelText("Height").getAttribute("max")).toBe("32768");
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByText(/zoom/i)).toBeNull();

    fireEvent.input(screen.getByLabelText("Width"), { target: { value: "800" } });
    fireEvent.input(screen.getByLabelText("Height"), { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply resolution" }));

    await waitFor(() => {
      expect(
        screen.getByText("The camera reported 800 × 450 after 800 × 600 was requested."),
      ).toBeTruthy();
    });
    expect(screen.getByText("800 × 450")).toBeTruthy();
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toBe("800");
    expect((screen.getByLabelText("Height") as HTMLInputElement).value).toBe("600");
  });

  it("navigates between available steps without bypassing prerequisites", async () => {
    render(<App />);

    const setupStep = screen.getByRole("button", { name: "Set up" });
    const captureStep = screen.getByRole("button", { name: "Capture" });
    const reviewStep = screen.getByRole("button", { name: "Review" });
    const resultsStep = screen.getByRole("button", { name: "Results" });
    expect(setupStep.getAttribute("aria-current")).toBe("step");
    expect((reviewStep as HTMLButtonElement).disabled).toBe(true);
    expect((resultsStep as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((captureStep as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(captureStep);
    expect(screen.getByRole("heading", { name: "Capture" })).toBeTruthy();
    expect(captureStep.getAttribute("aria-current")).toBe("step");
    fireEvent.click(setupStep);
    expect(screen.getByRole("heading", { name: "Calibration board" })).toBeTruthy();
    expect(setupStep.getAttribute("aria-current")).toBe("step");
  });

  it("links to a board-only tab without leaving setup", async () => {
    render(<App />);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Download board SVG" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Chessboard" }));
    const displayLink = screen.getByRole("link", { name: "Open board in new tab" });
    const targetUrl = new URL(displayLink.getAttribute("href")!);
    expect(displayLink.getAttribute("target")).toBe("_blank");
    expect(displayLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(targetUrl.searchParams.get("view")).toBe("board");
    expect(targetUrl.searchParams.get("type")).toBe("chessboard");
    expect(targetUrl.searchParams.get("columns")).toBe("9");
    expect(targetUrl.searchParams.get("rows")).toBe("6");
    expect(screen.getByRole("heading", { name: "Calibration board" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Capture" })).toBeNull();
  });

  it("starts a fresh calibration from results after confirmation", async () => {
    await saveActiveSession(completedSession());
    await putSessionBlob("image-0", new Blob(["frame"]));
    render(<App />);

    const restore = await screen.findByRole("button", { name: "Restore" });
    fireEvent.click(restore);
    await screen.findByRole("button", { name: "New calibration" });
    const setupStep = screen.getByRole("button", { name: "Set up" });
    const resultsStep = screen.getByRole("button", { name: "Results" });
    expect(resultsStep.getAttribute("aria-current")).toBe("step");
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(setupStep);
    expect(screen.getByRole("heading", { name: "Calibration board" })).toBeTruthy();
    fireEvent.click(resultsStep);
    const newCalibration = await screen.findByRole("button", { name: "New calibration" });
    fireEvent.click(newCalibration);

    expect(screen.getByRole("heading", { name: "Start a new calibration?" })).toBeTruthy();
    expect(screen.getByText("Current views and results will be deleted.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start new calibration" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Calibration board" })).toBeTruthy();
      expect(screen.getByText("New calibration started.")).toBeTruthy();
    });
    expect((screen.getByLabelText("Lens model") as HTMLSelectElement).value).toBe(
      "fisheye-kb4",
    );
    expect(screen.getByRole("button", { name: "Chessboard" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: "New calibration" })).toBeNull();
    expect(await loadActiveSession()).toBeUndefined();
    expect(await getSessionBlob("image-0")).toBeUndefined();
  });
});
