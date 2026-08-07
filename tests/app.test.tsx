import { render, screen, waitFor } from "@testing-library/preact";
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

describe("application shell", () => {
  beforeEach(async () => {
    await clearLocalSession();
    vi.stubGlobal("Worker", InitializingWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes the calibration engine and exposes bounded target controls", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Camera calibration" })).toBeTruthy();
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Download board SVG" });
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.getByLabelText("Squares across").getAttribute("max")).toBe("30");
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Height") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Connect camera" }).getAttribute("type")).toBe(
      "submit",
    );
    expect(screen.queryByText("Print at 100%. Verify the 100 mm ruler.")).toBeNull();
    expect(screen.getByText("OpenCV 4.13.0-test")).toBeTruthy();
  });
});
