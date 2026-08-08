import { describe, expect, it } from "vitest";
import {
  DISPLAY_SPECIFICATION_PRESETS,
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
  it("calculates pixel pitch from diagonal, active-area, or PPI specifications", () => {
    expect(estimatedMmPerPixel(specification)).toBeCloseTo(0.2335, 4);
    expect(estimatedMmPerPixel({
      nativeWidthPixels: 2560,
      nativeHeightPixels: 1440,
      sizeSource: "active-area",
      activeWidthMm: 597.6,
      activeHeightMm: 336.2,
    })).toBeCloseTo(0.23345, 5);
    expect(estimatedMmPerPixel({
      nativeWidthPixels: 1206,
      nativeHeightPixels: 2622,
      sizeSource: "pixel-density",
      pixelsPerInch: 460,
    })).toBeCloseTo(25.4 / 460, 8);
  });

  it("includes published-density presets for iPhone and MacBook displays", () => {
    expect(DISPLAY_SPECIFICATION_PRESETS.find((preset) => preset.id === "iphone-air")).toMatchObject({
      group: "iPhone",
      specification: {
        nativeWidthPixels: 1260,
        nativeHeightPixels: 2736,
        pixelsPerInch: 460,
      },
    });
    expect(DISPLAY_SPECIFICATION_PRESETS.find((preset) => preset.id === "macbook-pro-14.2")).toMatchObject({
      group: "MacBook",
      specification: {
        nativeWidthPixels: 3024,
        nativeHeightPixels: 1964,
        pixelsPerInch: 254,
      },
    });
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
    expect(displayProfileScale(profile, displayEnvironment(1280, 720, 2))).toMatchObject({
      source: "estimated",
      verificationCurrent: false,
    });
  });

  it("adjusts an estimated scale to the current OS/browser raster", () => {
    const profile: DisplayProfile = {
      schemaVersion: 1,
      id: "scaled-display",
      name: "Scaled display",
      specification,
    };
    const nativeScale = displayProfileScale(profile, displayEnvironment(2560, 1440, 1));
    const halfRasterScale = displayProfileScale(profile, displayEnvironment(1280, 720, 1));
    expect(halfRasterScale.mmPerPixel).toBeCloseTo(nativeScale.mmPerPixel * 2, 8);
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
    expect(validateDisplaySpecification({
      nativeWidthPixels: 1206,
      nativeHeightPixels: 2622,
      sizeSource: "pixel-density",
    })).toContain("Pixel density must be between 20 and 2000 ppi.");
  });
});
