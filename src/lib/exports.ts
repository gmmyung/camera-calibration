import type { CalibrationResultV1 } from "../domain/types";

function yamlNumber(value: number): string {
  if (!Number.isFinite(value)) return ".nan";
  const [mantissa = "0", exponent] = value.toPrecision(15).split("e");
  const compactMantissa = mantissa.replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
  return exponent === undefined ? compactMantissa : `${compactMantissa}e${exponent}`;
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

export function toOpenCvYaml(result: CalibrationResultV1): string {
  const distortionRows = result.distortion.length;
  return [
    "%YAML:1.0",
    "---",
    `schema_version: ${result.schemaVersion}`,
    `model: ${yamlQuoted(result.model)}`,
    `image_width: ${result.imageSize.width}`,
    `image_height: ${result.imageSize.height}`,
    `rms_reprojection_error: ${yamlNumber(result.rmsReprojectionError)}`,
    "camera_matrix: !!opencv-matrix",
    "   rows: 3",
    "   cols: 3",
    "   dt: d",
    `   data: [ ${result.cameraMatrix.map(yamlNumber).join(", ")} ]`,
    "distortion_coefficients: !!opencv-matrix",
    `   rows: ${distortionRows}`,
    "   cols: 1",
    "   dt: d",
    `   data: [ ${result.distortion.map(yamlNumber).join(", ")} ]`,
    `board_json: ${yamlQuoted(JSON.stringify(result.board))}`,
    `opencv_version: ${yamlQuoted(result.generator.opencvVersion)}`,
    `created_at: ${yamlQuoted(result.createdAt)}`,
    "",
  ].join("\n");
}

export function resultJson(result: CalibrationResultV1): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function toRosCameraInfoYaml(
  result: CalibrationResultV1,
  cameraName = "camera",
): string {
  const projection = [
    result.cameraMatrix[0], 0, result.cameraMatrix[2], 0,
    0, result.cameraMatrix[4], result.cameraMatrix[5], 0,
    0, 0, 1, 0,
  ];
  return [
    `image_width: ${result.imageSize.width}`,
    `image_height: ${result.imageSize.height}`,
    `camera_name: ${yamlQuoted(cameraName)}`,
    "camera_matrix:",
    "  rows: 3",
    "  cols: 3",
    `  data: [${result.cameraMatrix.map(yamlNumber).join(", ")}]`,
    `distortion_model: ${yamlQuoted(result.model === "fisheye-kb4" ? "equidistant" : "plumb_bob")}`,
    "distortion_coefficients:",
    "  rows: 1",
    `  cols: ${result.distortion.length}`,
    `  data: [${result.distortion.map(yamlNumber).join(", ")}]`,
    "rectification_matrix:",
    "  rows: 3",
    "  cols: 3",
    "  data: [1, 0, 0, 0, 1, 0, 0, 0, 1]",
    "projection_matrix:",
    "  rows: 3",
    "  cols: 4",
    `  data: [${projection.map(yamlNumber).join(", ")}]`,
    "",
  ].join("\n");
}

export function downloadText(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
