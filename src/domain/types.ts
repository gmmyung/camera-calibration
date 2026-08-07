export type AppStep = "setup" | "capture" | "review" | "results";

export interface ImageSize {
  width: number;
  height: number;
}

export interface Point2 {
  x: number;
  y: number;
}

export interface Point3 extends Point2 {
  z: number;
}

export const DICTIONARY_NAMES = [
  "DICT_4X4_50",
  "DICT_4X4_100",
  "DICT_4X4_250",
  "DICT_4X4_1000",
  "DICT_5X5_50",
  "DICT_5X5_100",
  "DICT_5X5_250",
  "DICT_5X5_1000",
  "DICT_6X6_50",
  "DICT_6X6_100",
  "DICT_6X6_250",
  "DICT_6X6_1000",
  "DICT_7X7_50",
  "DICT_7X7_100",
  "DICT_7X7_250",
  "DICT_7X7_1000",
  "DICT_ARUCO_ORIGINAL",
] as const;

export type DictionaryName = (typeof DICTIONARY_NAMES)[number];

export interface CharucoPatternConfig {
  kind: "charuco";
  squaresX: number;
  squaresY: number;
  squareLengthMm: number;
  markerLengthMm: number;
  dictionary: DictionaryName;
  legacyPattern: boolean;
}

export interface ChessboardPatternConfig {
  kind: "chessboard";
  innerCornersX: number;
  innerCornersY: number;
  squareLengthMm: number;
}

export type PatternConfig = CharucoPatternConfig | ChessboardPatternConfig;
export type LensModel = "pinhole-radtan5" | "fisheye-kb4";

export interface CameraSettingsSnapshot extends ImageSize {
  deviceId?: string;
  frameRate?: number;
  aspectRatio?: number;
  facingMode?: string;
  resizeMode?: string;
  zoom?: number;
  focusMode?: string;
  cameraLabel?: string;
}

export interface DetectionPoseFeatures {
  centerX: number;
  centerY: number;
  areaRatio: number;
  planeAngleDegrees: number;
  skew?: number;
  coverageCell: number;
}

export interface DetectionQuality {
  sharpness: number;
  boardAreaRatio: number;
  minEdgeDistancePx: number;
  detectedCorners: number;
  availableCorners: number;
  basicValid: boolean;
  messages: string[];
}

export interface DetectionResult {
  ok: boolean;
  error?: string;
  imageSize: ImageSize;
  imagePoints: Point2[];
  objectPoints: Point3[];
  pointIds: number[];
  quality: DetectionQuality;
  pose: DetectionPoseFeatures;
}

export interface FrameObservation {
  id: string;
  source: "live" | "upload";
  sourceName?: string;
  createdAt: string;
  imageSize: ImageSize;
  imagePoints: Point2[];
  objectPoints: Point3[];
  pointIds: number[];
  quality: DetectionQuality;
  pose: DetectionPoseFeatures;
  imageBlobKey: string;
  thumbnailBlobKey: string;
  included: boolean;
  autoExcludedReason?: string;
  perViewRms?: number;
}

export interface ViewPose {
  viewId: string;
  rotationVector: [number, number, number];
  translationVector: [number, number, number];
}

export interface CalibrationResultV1 {
  schemaVersion: 1;
  generator: {
    appVersion: string;
    opencvVersion: string;
  };
  createdAt: string;
  model: LensModel;
  imageSize: ImageSize;
  cameraMatrix: [number, number, number, number, number, number, number, number, number];
  previewCameraMatrix?: [number, number, number, number, number, number, number, number, number];
  distortion: number[];
  rmsReprojectionError: number;
  perViewErrors: Record<string, number>;
  includedViewIds: string[];
  excludedViewIds: string[];
  board: PatternConfig;
  captureSettings?: CameraSettingsSnapshot;
  poses: ViewPose[];
}

export interface CalibrationSessionV1 {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  step: AppStep;
  lensModel: LensModel;
  pattern: PatternConfig;
  imageSize?: ImageSize;
  captureSettings?: CameraSettingsSnapshot;
  observations: FrameObservation[];
  result?: CalibrationResultV1;
}

export interface CaptureProgress {
  accepted: number;
  minimumReached: boolean;
  targetReached: boolean;
  horizontal: number;
  vertical: number;
  size: number;
  skew: number;
}
