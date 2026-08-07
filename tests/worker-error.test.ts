import { describe, expect, it, vi } from "vitest";
import { calibrationErrorMessage } from "../src/worker/error-message";

describe("calibrationErrorMessage", () => {
  it("extracts and releases an Emscripten C++ exception", () => {
    const tools = {
      getExceptionMessage: vi.fn(() => ["std::runtime_error", "Not enough valid views."]),
      decrementExceptionRefcount: vi.fn(),
    };

    expect(calibrationErrorMessage(1048576, tools)).toBe("Not enough valid views.");
    expect(tools.getExceptionMessage).toHaveBeenCalledWith(1048576);
    expect(tools.decrementExceptionRefcount).toHaveBeenCalledWith(1048576);
  });

  it("uses message fields from non-Error exception objects", () => {
    expect(calibrationErrorMessage({ message: "OpenCV assertion failed." })).toBe(
      "OpenCV assertion failed.",
    );
  });

  it("describes opaque values instead of reporting an unknown error", () => {
    expect(calibrationErrorMessage({ code: "CALIBRATION_FAILED" })).toBe(
      'Calibration failed: {"code":"CALIBRATION_FAILED"}',
    );
  });
});
