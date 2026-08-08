import { afterEach, describe, expect, it, vi } from "vitest";
import { CHARUCO_PRESET } from "../src/domain/patterns";
import { CalibrationWorkerClient } from "../src/worker/client";

class FakeWorker extends EventTarget {
  messages: unknown[] = [];
  terminated = false;
  postError?: Error;

  postMessage(message: unknown): void {
    if (this.postError) throw this.postError;
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function clientFor(worker: FakeWorker, timeout = 1_000): CalibrationWorkerClient {
  return new CalibrationWorkerClient(worker as unknown as Worker, timeout);
}

describe("calibration worker client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves matching responses", async () => {
    const worker = new FakeWorker();
    const client = clientFor(worker);
    const pending = client.patternSvg(CHARUCO_PRESET);
    const request = worker.messages[0] as { id: number };
    worker.respond({ id: request.id, ok: true, type: "GENERATE_PATTERN_SVG", svg: "<svg/>" });
    await expect(pending).resolves.toBe("<svg/>");
    await client.dispose();
  });

  it("requests a device-pixel-aligned display pattern", async () => {
    const worker = new FakeWorker();
    const client = clientFor(worker);
    const pending = client.displayPatternSvg(CHARUCO_PRESET, 150, 105);
    const request = worker.messages[0] as {
      id: number;
      type: string;
      squarePixels: number;
      markerPixels: number;
    };
    expect(request).toMatchObject({
      type: "GENERATE_DISPLAY_PATTERN_SVG",
      squarePixels: 150,
      markerPixels: 105,
    });
    worker.respond({
      id: request.id,
      ok: true,
      type: "GENERATE_DISPLAY_PATTERN_SVG",
      svg: "<svg width=\"750\"/>",
    });
    await expect(pending).resolves.toContain("750");
    await client.dispose();
  });

  it("does not leave a pending request when postMessage throws", async () => {
    const worker = new FakeWorker();
    worker.postError = new Error("clone failed");
    const client = clientFor(worker);
    await expect(client.patternSvg(CHARUCO_PRESET)).rejects.toThrow("clone failed");
    await client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("rejects pending and future requests after a worker crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = new FakeWorker();
    const client = clientFor(worker);
    const pending = client.patternSvg(CHARUCO_PRESET);
    worker.dispatchEvent(new ErrorEvent("error", { message: "wasm trap" }));
    await expect(pending).rejects.toThrow("wasm trap");
    await expect(client.patternSvg(CHARUCO_PRESET)).rejects.toThrow("wasm trap");
    expect(worker.terminated).toBe(true);
  });

  it("rejects malformed worker messages", async () => {
    const worker = new FakeWorker();
    const client = clientFor(worker);
    const pending = client.patternSvg(CHARUCO_PRESET);
    const rejection = expect(pending).rejects.toThrow("unreadable response");
    worker.respond(null);
    await rejection;
    expect(worker.terminated).toBe(true);
  });

  it("rejects error responses without a message", async () => {
    const worker = new FakeWorker();
    const client = clientFor(worker);
    const pending = client.patternSvg(CHARUCO_PRESET);
    const rejection = expect(pending).rejects.toThrow("unreadable error response");
    const request = worker.messages[0] as { id: number };
    worker.respond({ id: request.id, ok: false, type: "GENERATE_PATTERN_SVG", error: "" });
    await rejection;
    expect(worker.terminated).toBe(true);
  });

  it("times out a hung worker and terminates it", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = clientFor(worker, 50);
    const pending = client.patternSvg(CHARUCO_PRESET);
    const rejection = expect(pending).rejects.toThrow("did not respond within 50 ms");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(worker.terminated).toBe(true);
  });

  it("disposes immediately even while a request is pending", async () => {
    const worker = new FakeWorker();
    const client = clientFor(worker);
    const pending = client.patternSvg(CHARUCO_PRESET);
    const rejection = expect(pending).rejects.toThrow("disposed");
    await client.dispose();
    await rejection;
    expect(worker.terminated).toBe(true);
  });
});
