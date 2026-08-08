import { describe, expect, it } from "vitest";
import {
  dictionaryModuleCount,
  displayBoardGeometry,
  displayBoardUrl,
  patternFromDisplayBoardUrl,
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

  it("round-trips board settings through a standalone page URL", () => {
    const charucoUrl = displayBoardUrl(
      CHARUCO_PRESET,
      "https://example.test/camera-calibration/?old=value#fragment",
    );
    const parsedUrl = new URL(charucoUrl);
    expect(parsedUrl.pathname).toBe("/camera-calibration/");
    expect(parsedUrl.hash).toBe("");
    expect(parsedUrl.searchParams.has("old")).toBe(false);
    expect(patternFromDisplayBoardUrl(parsedUrl)).toEqual(CHARUCO_PRESET);
    expect(patternFromDisplayBoardUrl(new URL(
      displayBoardUrl(CHESSBOARD_PRESET, "https://example.test/camera-calibration/"),
    ))).toEqual(CHESSBOARD_PRESET);
  });

  it("rejects malformed standalone board URLs", () => {
    const url = new URL(displayBoardUrl(
      CHARUCO_PRESET,
      "https://example.test/camera-calibration/",
    ));
    url.searchParams.set("columns", "31");
    expect(() => patternFromDisplayBoardUrl(url)).toThrow("Invalid display board link");
    url.searchParams.set("columns", "5");
    url.searchParams.set("dictionary", "DICT_UNKNOWN");
    expect(() => patternFromDisplayBoardUrl(url)).toThrow("Invalid display board link");
  });
});
