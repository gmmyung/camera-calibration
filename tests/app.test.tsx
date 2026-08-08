import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { clearLocalSession } from "../src/lib/session-db";

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
    expect(screen.getByRole("heading", { name: "Display board" })).toBeTruthy();
    expect(screen.getByLabelText("Display profile")).toBeTruthy();
    expect(screen.getByLabelText("Display preset")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify with ruler" })).toBeTruthy();
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

  it("keeps a fullscreen display target mounted after capture starts", async () => {
    render(<App />);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Download board SVG" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Chessboard" }));
    fireEvent.input(screen.getByLabelText("Square size (mm)"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Display preset"), {
      target: { value: "24-1920x1080" },
    });
    const displayButton = screen.getByRole("button", { name: "Display board" });
    expect((displayButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(displayButton);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Calibration board display" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Capture" })).toBeTruthy();
    });
  });

  it("stores a ruler-verified display profile", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Display preset"), {
      target: { value: "27-2560x1440" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify with ruler" }));
    const dialog = screen.getByRole("dialog", { name: "Verify display scale" });
    fireEvent.input(within(dialog).getByLabelText("Measured length (mm)"), {
      target: { value: "150" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(screen.getByText("Verified")).toBeTruthy();
      expect((screen.getByLabelText("Display profile") as HTMLSelectElement).value).not.toBe("");
    });
  });

  it("applies an Apple display preset using its published pixel density", async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Display preset"), {
      target: { value: "iphone-air" },
    });
    await waitFor(() => {
      expect((screen.getByLabelText("Native width") as HTMLInputElement).value).toBe("1260");
      expect((screen.getByLabelText("Native height") as HTMLInputElement).value).toBe("2736");
      expect((screen.getByLabelText("Physical size from") as HTMLSelectElement).value).toBe("pixel-density");
      expect((screen.getByLabelText("Pixel density (ppi)") as HTMLInputElement).value).toBe("460");
    });
  });
});
