import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { LiveResultPreview } from "../src/app/App";
import { ValidationImagePreview } from "../src/app/ValidationImagePreview";
import type { CalibrationResultV1 } from "../src/domain/types";

function result(model: CalibrationResultV1["model"]): CalibrationResultV1 {
  return {
    schemaVersion: 1,
    generator: { appVersion: "test", opencvVersion: "test" },
    createdAt: new Date(0).toISOString(),
    model,
    imageSize: { width: 1280, height: 720 },
    cameraMatrix: [600, 0, 640, 0, 600, 360, 0, 0, 1],
    previewCameraMatrix: [400, 0, 640, 0, 400, 360, 0, 0, 1],
    previewFillCameraMatrix: [700, 0, 640, 0, 700, 360, 0, 0, 1],
    distortion: model === "fisheye-kb4" ? [-0.1, 0.01, 0, 0] : [-0.1, 0.01, 0, 0, 0],
    rmsReprojectionError: 0.2,
    perViewErrors: {},
    includedViewIds: [],
    excludedViewIds: [],
    board: { kind: "chessboard", innerCornersX: 9, innerCornersY: 6 },
    poses: [],
  };
}

afterEach(cleanup);

describe("corrected preview controls", () => {
  it("defaults a fisheye live preview to Fill view and permits Full view", () => {
    render(<LiveResultPreview result={result("fisheye-kb4")} />);

    const fill = screen.getByRole("button", { name: "Fill view" });
    const full = screen.getByRole("button", { name: "Full view" });
    expect(fill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(full);
    expect(full.getAttribute("aria-pressed")).toBe("true");
    expect(fill.getAttribute("aria-pressed")).toBe("false");
  });

  it("offers the same selection for validation images", () => {
    render(<ValidationImagePreview result={result("fisheye-kb4")} />);

    const fill = screen.getByRole("button", { name: "Fill view" });
    const full = screen.getByRole("button", { name: "Full view" });
    expect(fill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(full);
    expect(full.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the standard-lens control as Original or Corrected", () => {
    render(<LiveResultPreview result={result("pinhole-radtan5")} />);

    expect(screen.getByRole("button", { name: "Corrected" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Full view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fill view" })).toBeNull();
  });
});
