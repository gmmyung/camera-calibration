export interface EmscriptenExceptionTools {
  getExceptionMessage?: (error: unknown) => readonly string[];
  decrementExceptionRefcount?: (error: unknown) => void;
}

function stringProperty(error: unknown, property: "name" | "message"): string {
  if (typeof error !== "object" || error === null || !(property in error)) return "";
  const value = (error as Record<string, unknown>)[property];
  return typeof value === "string" ? value : "";
}

function nativeExceptionMessage(
  error: unknown,
  tools: EmscriptenExceptionTools | undefined,
): string | undefined {
  if (typeof error !== "number" || typeof tools?.getExceptionMessage !== "function") {
    return undefined;
  }

  try {
    const [type, message] = tools.getExceptionMessage(error);
    if (message) return message;
    if (type) return `OpenCV raised ${type}.`;
  } catch {
    return undefined;
  } finally {
    try {
      tools.decrementExceptionRefcount?.(error);
    } catch {
      // The original exception is more useful than a refcount cleanup failure.
    }
  }
  return undefined;
}

export function calibrationErrorMessage(
  error: unknown,
  tools?: EmscriptenExceptionTools,
): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;

  const nativeMessage = nativeExceptionMessage(error, tools);
  if (nativeMessage) return nativeMessage;

  const message = stringProperty(error, "message");
  if (message) return message;
  const name = stringProperty(error, "name");
  if (name) return `Calibration failed with ${name}.`;
  if (typeof error === "number") return `Calibration failed with native exception ${error}.`;

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return `Calibration failed: ${serialized.slice(0, 500)}`;
    }
  } catch {
    // Fall through to a stable message for cyclic and otherwise opaque values.
  }
  return "Calibration failed without an error message.";
}
