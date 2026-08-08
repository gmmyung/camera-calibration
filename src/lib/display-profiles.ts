import {
  MAX_DISPLAY_PROFILES,
  isDisplayProfile,
  type DisplayProfile,
} from "../domain/display-target";

const STORAGE_KEY = "camera-calibration.display-profiles.v1";
export const DISPLAY_PROFILES_CHANGED_EVENT = "camera-calibration-display-profiles-changed";

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadDisplayProfiles(): DisplayProfile[] {
  const target = storage();
  if (!target) return [];
  try {
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDisplayProfile).slice(0, MAX_DISPLAY_PROFILES);
  } catch {
    return [];
  }
}

export function saveDisplayProfiles(profiles: DisplayProfile[]): void {
  const target = storage();
  if (!target) throw new Error("Display profiles cannot be saved in this browser.");
  const valid = profiles.filter(isDisplayProfile).slice(0, MAX_DISPLAY_PROFILES);
  if (valid.length !== profiles.length) throw new Error("A display profile is invalid.");
  target.setItem(STORAGE_KEY, JSON.stringify(valid));
  window.dispatchEvent(new Event(DISPLAY_PROFILES_CHANGED_EVENT));
}

export function clearDisplayProfiles(): void {
  storage()?.removeItem(STORAGE_KEY);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DISPLAY_PROFILES_CHANGED_EVENT));
  }
}
