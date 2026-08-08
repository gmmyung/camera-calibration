import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayProfile } from "../src/domain/display-target";
import {
  DISPLAY_PROFILES_CHANGED_EVENT,
  clearDisplayProfiles,
  loadDisplayProfiles,
  saveDisplayProfiles,
} from "../src/lib/display-profiles";

const profile: DisplayProfile = {
  schemaVersion: 1,
  id: "display-1",
  name: "Desk monitor",
  specification: {
    nativeWidthPixels: 3840,
    nativeHeightPixels: 2160,
    sizeSource: "diagonal",
    diagonalInches: 27,
  },
};

describe("display profile storage", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("saves, loads, and clears valid profiles", () => {
    const changed = vi.fn();
    window.addEventListener(DISPLAY_PROFILES_CHANGED_EVENT, changed);
    saveDisplayProfiles([profile]);
    expect(loadDisplayProfiles()).toEqual([profile]);
    expect(changed).toHaveBeenCalledTimes(1);
    clearDisplayProfiles();
    expect(loadDisplayProfiles()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
    window.removeEventListener(DISPLAY_PROFILES_CHANGED_EVENT, changed);
  });

  it("does not persist invalid profiles", () => {
    expect(() => saveDisplayProfiles([{ ...profile, name: "" }])).toThrow("invalid");
  });
});
