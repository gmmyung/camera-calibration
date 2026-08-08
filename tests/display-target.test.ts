import { describe, expect, it } from "vitest";
import {
  dictionaryModuleCount,
  displayEnvironment,
  displayEnvironmentKey,
  displayProfileScale,
  displayRasterMatchesSpecification,
  displayTargetGeometry,
  estimatedMmPerPixel,
  validateDisplaySpecification,
  type DisplayProfile,
} from "../src/domain/display-target";
import { CHARUCO_PRESET, CHESSBOARD_PRESET } from "../src/domain/patterns";

const specification = {
  nativeWidthPixels: 2560,
  nativeHeightPixels: 1440,
  sizeSource: "diagonal" as const,
  diagonalInches: 27,
};

describe("display target geometry", () => {
  it("calculates pixel pitch from diagonal or active-area specifications", () => {
    expect(estimatedMmPerPixel(specification)).toBeCloseTo(0.2335, 4);
    expect(estimatedMmPerPixel({
      nativeWidthPixels: 2560,
      nativeHeightPixels: 1440,
      sizeSource: "active-area",
      activeWidthMm: 597.6,
      activeHeightMm: 336.2,
    })).toBeCloseTo(0.23345, 5);
  });

  it("uses a verification only for the environment where it was measured", () => {
    const environment = displayEnvironment(2048, 1152, 1.25);
    const profile: DisplayProfile = {
      schemaVersion: 1,
      id: "display-1",
      name: "Desk monitor",
      specification,
      verification: {
        measuredLengthMm: 150,
        renderedLengthPixels: 750,
        mmPerPixel: 0.2,
        environmentKey: displayEnvironmentKey(environment),
        verifiedAt: "2026-08-08T00:00:00.000Z",
      },
    };
    expect(displayProfileScale(profile, environment)).toMatchObject({
      mmPerPixel: 0.2,
      source: "verified",
      verificationCurrent: true,
    });
    expect(displayProfileScale(profile, displayEnvironment(1920, 1080, 1))).toMatchObject({
      source: "estimated",
      verificationCurrent: false,
    });
  });

  it("snaps ChArUco markers to complete dictionary modules", () => {
    const geometry = displayTargetGeometry(CHARUCO_PRESET, 0.2);
    expect(geometry.squarePixels).toBe(150);
    expect(geometry.markerPixels).toBe(105);
    expect(geometry.markerPixels! % dictionaryModuleCount(CHARUCO_PRESET.dictionary)).toBe(0);
    expect(geometry.boardWidthPixels).toBe(750);
    expect(geometry.boardHeightPixels).toBe(1050);
    expect(geometry.pattern).toEqual(CHARUCO_PRESET);
  });

  it("reports the actual pixel-snapped chessboard dimensions", () => {
    const geometry = displayTargetGeometry(CHESSBOARD_PRESET, 0.23);
    expect(geometry.squarePixels).toBe(104);
    expect(geometry.pattern.squareLengthMm).toBe(23.92);
    expect(geometry.boardWidthPixels).toBe(1040);
    expect(geometry.boardHeightPixels).toBe(728);
  });

  it("compares current and rotated browser rasters with the selected native mode", () => {
    expect(displayRasterMatchesSpecification(displayEnvironment(2560, 1440, 1), specification)).toBe(true);
    expect(displayRasterMatchesSpecification(displayEnvironment(1440, 2560, 1), specification)).toBe(true);
    expect(displayRasterMatchesSpecification(displayEnvironment(1920, 1080, 1), specification)).toBe(false);
  });

  it("rejects incomplete physical display specifications", () => {
    expect(validateDisplaySpecification({
      nativeWidthPixels: 1920,
      nativeHeightPixels: 1080,
      sizeSource: "diagonal",
    })).toContain("Display diagonal must be between 2 and 300 inches.");
    expect(validateDisplaySpecification({
      nativeWidthPixels: 1920,
      nativeHeightPixels: 1080,
      sizeSource: "active-area",
      activeWidthMm: 500,
      activeHeightMm: 500,
    })).toContain("Active panel dimensions do not match the native-resolution aspect ratio.");
  });
});
