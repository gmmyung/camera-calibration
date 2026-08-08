import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayBoardPage } from "../src/app/DisplayBoardPage";
import { CHARUCO_PRESET } from "../src/domain/patterns";

class BoardWorker extends EventTarget {
  postMessage(message: unknown): void {
    const request = message as { id: number; type: string };
    queueMicrotask(() => {
      if (request.type === "INIT") {
        this.dispatchEvent(new MessageEvent("message", {
          data: {
            id: request.id,
            ok: true,
            type: request.type,
            opencvVersion: "4.13.0-test",
          },
        }));
      } else if (request.type === "GENERATE_DISPLAY_PATTERN_SVG") {
        this.dispatchEvent(new MessageEvent("message", {
          data: {
            id: request.id,
            ok: true,
            type: request.type,
            svg: '<svg width="500" height="700" viewBox="0 0 500 700"></svg>',
          },
        }));
      }
    });
  }

  terminate(): void {}
}

const originalRequestFullscreen = Object.getOwnPropertyDescriptor(
  document.documentElement,
  "requestFullscreen",
);

describe("standalone display board", () => {
  const requestFullscreen = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.stubGlobal("Worker", BoardWorker);
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
  });

  afterEach(() => {
    cleanup();
    requestFullscreen.mockClear();
    vi.unstubAllGlobals();
    if (originalRequestFullscreen) {
      Object.defineProperty(
        document.documentElement,
        "requestFullscreen",
        originalRequestFullscreen,
      );
    } else {
      Reflect.deleteProperty(document.documentElement, "requestFullscreen");
    }
  });

  it("renders only the board and a fullscreen control", async () => {
    const { container } = render(<DisplayBoardPage pattern={CHARUCO_PRESET} />);
    await waitFor(() => {
      expect(container.querySelector(".display-board-target svg")).toBeTruthy();
    });
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    const fullscreenButton = screen.getByRole("button", { name: "Fullscreen" });
    expect((fullscreenButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(fullscreenButton);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("shows invalid board links without starting a worker", () => {
    render(<DisplayBoardPage initialError="Invalid display board link." />);
    expect(screen.getByRole("alert").textContent).toBe("Invalid display board link.");
  });
});
