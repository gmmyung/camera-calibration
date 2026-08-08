import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
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
    vi.stubGlobal("Worker", InitializingWorker);
  });

  afterEach(() => {
    cleanup();
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
});
