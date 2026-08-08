import { describe, expect, it } from "vitest";
import {
  dictionaryModuleCount,
  displayBoardGeometry,
} from "../src/domain/display-board";
import { CHARUCO_PRESET, CHESSBOARD_PRESET } from "../src/domain/patterns";

describe("display board geometry", () => {
  it("fits a ChArUco board within the current viewport", () => {
    const geometry = displayBoardGeometry(CHARUCO_PRESET, {
      widthCss: 1024,
      heightCss: 768,
      devicePixelRatio: 2,
    });
    expect(geometry).toMatchObject({
      squarePixels: 190,
      markerPixels: 133,
      boardWidthPixels: 950,
      boardHeightPixels: 1330,
      boardWidthCss: 475,
      boardHeightCss: 665,
    });
    expect(geometry.markerPixels! % dictionaryModuleCount(CHARUCO_PRESET.dictionary)).toBe(0);
  });

  it("uses the outer square count for a chessboard", () => {
    expect(displayBoardGeometry(CHESSBOARD_PRESET, {
      widthCss: 1000,
      heightCss: 800,
      devicePixelRatio: 1,
    })).toMatchObject({
      squarePixels: 97,
      boardWidthPixels: 970,
      boardHeightPixels: 679,
    });
  });

  it("rejects a viewport that cannot show detectable squares", () => {
    expect(() => displayBoardGeometry(CHARUCO_PRESET, {
      widthCss: 40,
      heightCss: 40,
      devicePixelRatio: 1,
    })).toThrow("too small");
  });
});
