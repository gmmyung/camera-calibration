import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  DISPLAY_SPECIFICATION_PRESETS,
  MAX_DISPLAY_PATTERN_EDGE,
  displayEnvironment,
  displayEnvironmentKey,
  displayProfileScale,
  displayRasterMatchesSpecification,
  displayTargetGeometry,
  validateDisplaySpecification,
  type DisplayEnvironment,
  type DisplayProfile,
  type DisplaySizeSource,
  type DisplaySpecification,
  type DisplayTargetGeometry,
  type DisplayVerification,
} from "../domain/display-target";
import type { PatternConfig } from "../domain/types";
import {
  DISPLAY_PROFILES_CHANGED_EVENT,
  loadDisplayProfiles,
  saveDisplayProfiles,
} from "../lib/display-profiles";
import { createId } from "../lib/ids";
import type { CalibrationWorkerClient } from "../worker/client";

interface ProfileDraft {
  id?: string;
  name: string;
  nativeWidthPixels: string;
  nativeHeightPixels: string;
  sizeSource: DisplaySizeSource;
  diagonalInches: string;
  activeWidthMm: string;
  activeHeightMm: string;
  verification?: DisplayVerification;
}

interface ParsedDraft {
  profile?: DisplayProfile;
  errors: string[];
}

function currentDisplayEnvironment(): DisplayEnvironment {
  const cssWidth = window.screen?.width || window.innerWidth || 1;
  const cssHeight = window.screen?.height || window.innerHeight || 1;
  return displayEnvironment(cssWidth, cssHeight, window.devicePixelRatio || 1);
}

function blankDraft(environment: DisplayEnvironment): ProfileDraft {
  return {
    name: "Current display",
    nativeWidthPixels: String(environment.pixelWidth),
    nativeHeightPixels: String(environment.pixelHeight),
    sizeSource: "diagonal",
    diagonalInches: "",
    activeWidthMm: "",
    activeHeightMm: "",
  };
}

function profileDraft(profile: DisplayProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    nativeWidthPixels: String(profile.specification.nativeWidthPixels),
    nativeHeightPixels: String(profile.specification.nativeHeightPixels),
    sizeSource: profile.specification.sizeSource,
    diagonalInches: profile.specification.diagonalInches === undefined
      ? ""
      : String(profile.specification.diagonalInches),
    activeWidthMm: profile.specification.activeWidthMm === undefined
      ? ""
      : String(profile.specification.activeWidthMm),
    activeHeightMm: profile.specification.activeHeightMm === undefined
      ? ""
      : String(profile.specification.activeHeightMm),
    verification: profile.verification,
  };
}

function finiteNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDraft(draft: ProfileDraft): ParsedDraft {
  const specification: DisplaySpecification = {
    nativeWidthPixels: finiteNumber(draft.nativeWidthPixels) ?? Number.NaN,
    nativeHeightPixels: finiteNumber(draft.nativeHeightPixels) ?? Number.NaN,
    sizeSource: draft.sizeSource,
    diagonalInches: draft.sizeSource === "diagonal"
      ? finiteNumber(draft.diagonalInches)
      : undefined,
    activeWidthMm: draft.sizeSource === "active-area"
      ? finiteNumber(draft.activeWidthMm)
      : undefined,
    activeHeightMm: draft.sizeSource === "active-area"
      ? finiteNumber(draft.activeHeightMm)
      : undefined,
  };
  const errors = validateDisplaySpecification(specification);
  if (!draft.name.trim()) errors.unshift("Enter a display profile name.");
  if (draft.name.length > 100) errors.unshift("Display profile names are limited to 100 characters.");
  if (errors.length > 0) return { errors };
  return {
    errors: [],
    profile: {
      schemaVersion: 1,
      id: draft.id ?? "draft",
      name: draft.name.trim(),
      specification,
      verification: draft.verification,
    },
  };
}

function adjustedPatternDiffers(current: PatternConfig, adjusted: PatternConfig): boolean {
  if (current.kind !== adjusted.kind) return true;
  if (current.squareLengthMm !== adjusted.squareLengthMm) return true;
  return current.kind === "charuco" && adjusted.kind === "charuco"
    ? current.markerLengthMm !== adjusted.markerLengthMm
    : false;
}

function formatMillimetres(value: number): string {
  return `${value.toFixed(2)} mm`;
}

function requestPageFullscreen(onError: (message: string) => void): void {
  if (!document.documentElement.requestFullscreen) {
    onError("Fullscreen is unavailable; the target is using the current window.");
    return;
  }
  void document.documentElement.requestFullscreen().catch(() => {
    onError("Fullscreen was not granted; the target is using the current window.");
  });
}

export function DisplayTargetPanel({
  settingsVisible,
  pattern,
  worker,
  workerReady,
  onApplyPattern,
  onStartCapture,
}: {
  settingsVisible: boolean;
  pattern: PatternConfig;
  worker?: CalibrationWorkerClient;
  workerReady: boolean;
  onApplyPattern: (pattern: PatternConfig) => void;
  onStartCapture: () => void;
}) {
  const initialProfiles = useMemo(() => loadDisplayProfiles(), []);
  const [profiles, setProfiles] = useState<DisplayProfile[]>(initialProfiles);
  const [environment, setEnvironment] = useState(currentDisplayEnvironment);
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    initialProfiles[0] ? profileDraft(initialProfiles[0]) : blankDraft(currentDisplayEnvironment())
  );
  const [presetId, setPresetId] = useState("");
  const [notice, setNotice] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [overlayMode, setOverlayMode] = useState<"verify" | "board">();
  const [displaySvg, setDisplaySvg] = useState<string>();
  const [displayBusy, setDisplayBusy] = useState(false);
  const [barPixels, setBarPixels] = useState(0);
  const [measuredLength, setMeasuredLength] = useState("");
  const rulerRef = useRef<SVGSVGElement>(null);

  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const scale = useMemo(() => {
    if (!parsed.profile) return undefined;
    try {
      return displayProfileScale(parsed.profile, environment);
    } catch {
      return undefined;
    }
  }, [parsed.profile, environment]);
  const geometry = useMemo<DisplayTargetGeometry | undefined>(() => {
    if (!scale) return undefined;
    try {
      return displayTargetGeometry(pattern, scale.mmPerPixel);
    } catch {
      return undefined;
    }
  }, [pattern, scale]);
  const verificationStale = Boolean(draft.verification && scale?.source !== "verified");
  const rasterMatches = parsed.profile
    ? displayRasterMatchesSpecification(environment, parsed.profile.specification)
    : false;
  const targetFits = Boolean(
    geometry &&
    geometry.boardWidthPixels / environment.devicePixelRatio <= environment.cssWidth - 24 &&
    geometry.boardHeightPixels / environment.devicePixelRatio <= environment.cssHeight - 72
  );

  useEffect(() => {
    const refreshEnvironment = () => setEnvironment(currentDisplayEnvironment());
    window.addEventListener("resize", refreshEnvironment);
    window.visualViewport?.addEventListener("resize", refreshEnvironment);
    return () => {
      window.removeEventListener("resize", refreshEnvironment);
      window.visualViewport?.removeEventListener("resize", refreshEnvironment);
    };
  }, []);

  useEffect(() => {
    const refreshProfiles = () => {
      const next = loadDisplayProfiles();
      setProfiles(next);
      if (next.length === 0 && draft.id) setDraft(blankDraft(currentDisplayEnvironment()));
    };
    window.addEventListener(DISPLAY_PROFILES_CHANGED_EVENT, refreshProfiles);
    return () => window.removeEventListener(DISPLAY_PROFILES_CHANGED_EVENT, refreshProfiles);
  }, [draft.id]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setEnvironment(currentDisplayEnvironment());
      if (overlayMode && !document.fullscreenElement) setOverlayMode(undefined);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (overlayMode && event.key === "Escape" && !document.fullscreenElement) {
        setOverlayMode(undefined);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      window.removeEventListener("keydown", handleKey);
    };
  }, [overlayMode]);

  const updateSpecification = (changes: Partial<ProfileDraft>) => {
    setPresetId("");
    setNotice(undefined);
    setLocalError(undefined);
    setDraft((previous) => ({ ...previous, ...changes, verification: undefined }));
  };

  const selectProfile = (id: string) => {
    setPresetId("");
    setNotice(undefined);
    setLocalError(undefined);
    const profile = profiles.find((candidate) => candidate.id === id);
    setDraft(profile ? profileDraft(profile) : blankDraft(environment));
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    setNotice(undefined);
    setLocalError(undefined);
    const preset = DISPLAY_SPECIFICATION_PRESETS.find((candidate) => candidate.id === id);
    if (!preset) return;
    setDraft((previous) => ({
      ...previous,
      name: previous.id ? previous.name : preset.label,
      nativeWidthPixels: String(preset.specification.nativeWidthPixels),
      nativeHeightPixels: String(preset.specification.nativeHeightPixels),
      sizeSource: preset.specification.sizeSource,
      diagonalInches: String(preset.specification.diagonalInches ?? ""),
      activeWidthMm: "",
      activeHeightMm: "",
      verification: undefined,
    }));
  };

  const persistProfile = (verification = draft.verification): DisplayProfile | undefined => {
    const result = parseDraft({ ...draft, verification });
    if (!result.profile) {
      setLocalError(result.errors[0]);
      return undefined;
    }
    const profile = {
      ...result.profile,
      id: draft.id ?? createId("display"),
      verification,
    };
    const next = [...profiles.filter((candidate) => candidate.id !== profile.id), profile];
    try {
      saveDisplayProfiles(next);
      setProfiles(next);
      setDraft(profileDraft(profile));
      setNotice("Display profile saved.");
      setLocalError(undefined);
      return profile;
    } catch (saveError) {
      setLocalError(saveError instanceof Error ? saveError.message : String(saveError));
      return undefined;
    }
  };

  const deleteProfile = () => {
    if (!draft.id) return;
    const next = profiles.filter((profile) => profile.id !== draft.id);
    try {
      saveDisplayProfiles(next);
      setProfiles(next);
      setDraft(next[0] ? profileDraft(next[0]) : blankDraft(environment));
      setNotice("Display profile deleted.");
      setLocalError(undefined);
    } catch (deleteError) {
      setLocalError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const beginVerification = () => {
    if (!scale) return;
    const maximum = Math.max(
      100,
      Math.min(MAX_DISPLAY_PATTERN_EDGE, Math.floor(environment.pixelWidth * 0.75)),
    );
    const pixels = Math.max(100, Math.min(maximum, Math.round(150 / scale.mmPerPixel)));
    setBarPixels(pixels);
    setMeasuredLength("");
    setDisplaySvg(undefined);
    setOverlayMode("verify");
    setLocalError(undefined);
    requestPageFullscreen(setLocalError);
  };

  const applyVerification = () => {
    const measuredLengthMm = Number(measuredLength);
    if (!Number.isFinite(measuredLengthMm) || measuredLengthMm < 1 || measuredLengthMm > 10_000) {
      setLocalError("Enter the measured reference length in millimetres.");
      return;
    }
    const renderedCssWidth = rulerRef.current?.getBoundingClientRect().width ?? 0;
    const renderedLengthPixels = renderedCssWidth > 0
      ? renderedCssWidth * environment.devicePixelRatio
      : barPixels;
    const verification: DisplayVerification = {
      measuredLengthMm,
      renderedLengthPixels,
      mmPerPixel: measuredLengthMm / renderedLengthPixels,
      environmentKey: displayEnvironmentKey(environment),
      verifiedAt: new Date().toISOString(),
    };
    if (persistProfile(verification)) {
      setOverlayMode(undefined);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setNotice("Display scale verified.");
    }
  };

  const showBoard = () => {
    if (!worker || !geometry || !targetFits || displayBusy) return;
    setDisplayBusy(true);
    setDisplaySvg(undefined);
    setOverlayMode("board");
    setLocalError(undefined);
    if (adjustedPatternDiffers(pattern, geometry.pattern)) onApplyPattern(geometry.pattern);
    onStartCapture();
    requestPageFullscreen(setLocalError);
    void worker
      .displayPatternSvg(geometry.pattern, geometry.squarePixels, geometry.markerPixels)
      .then(setDisplaySvg)
      .catch((renderError) => {
        setLocalError(renderError instanceof Error ? renderError.message : String(renderError));
        setOverlayMode(undefined);
      })
      .finally(() => setDisplayBusy(false));
  };

  const closeOverlay = () => {
    setOverlayMode(undefined);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };

  const scaleLabel = scale?.source === "verified"
    ? "Verified"
    : verificationStale
      ? "Needs verification"
      : "Estimated";

  return (
    <>
      {settingsVisible && <section class="panel display-target-settings">
      <h3>Display board</h3>
      <div class="form-grid">
        <label class="field span-two">
          <span>Display profile</span>
          <select value={draft.id ?? ""} onChange={(event) => selectProfile(event.currentTarget.value)}>
            <option value="">New display profile</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
        </label>
        <label class="field span-two">
          <span>Monitor specification</span>
          <select value={presetId} onChange={(event) => applyPreset(event.currentTarget.value)}>
            <option value="">Custom</option>
            {DISPLAY_SPECIFICATION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        <label class="field span-two">
          <span>Profile name</span>
          <input value={draft.name} maxlength={100} onInput={(event) => setDraft((previous) => ({ ...previous, name: event.currentTarget.value }))} />
        </label>
        <label class="field">
          <span>Native width</span>
          <input type="number" min={320} max={32768} step={1} value={draft.nativeWidthPixels} onInput={(event) => updateSpecification({ nativeWidthPixels: event.currentTarget.value })} />
        </label>
        <label class="field">
          <span>Native height</span>
          <input type="number" min={200} max={32768} step={1} value={draft.nativeHeightPixels} onInput={(event) => updateSpecification({ nativeHeightPixels: event.currentTarget.value })} />
        </label>
        <label class="field span-two">
          <span>Physical size from</span>
          <select value={draft.sizeSource} onChange={(event) => updateSpecification({ sizeSource: event.currentTarget.value as DisplaySizeSource })}>
            <option value="diagonal">Diagonal</option>
            <option value="active-area">Active panel dimensions</option>
          </select>
        </label>
        {draft.sizeSource === "diagonal" ? (
          <label class="field span-two">
            <span>Diagonal (inches)</span>
            <input type="number" min={2} max={300} step={0.1} value={draft.diagonalInches} onInput={(event) => updateSpecification({ diagonalInches: event.currentTarget.value })} />
          </label>
        ) : (
          <>
            <label class="field">
              <span>Active width (mm)</span>
              <input type="number" min={10} max={10000} step={0.01} value={draft.activeWidthMm} onInput={(event) => updateSpecification({ activeWidthMm: event.currentTarget.value })} />
            </label>
            <label class="field">
              <span>Active height (mm)</span>
              <input type="number" min={10} max={10000} step={0.01} value={draft.activeHeightMm} onInput={(event) => updateSpecification({ activeHeightMm: event.currentTarget.value })} />
            </label>
          </>
        )}
      </div>

      {parsed.errors.length > 0 && <p class="field-error display-profile-error">{parsed.errors[0]}</p>}
      {localError && <p class="field-error display-profile-error" role="alert">{localError}</p>}
      {notice && <p class="display-profile-notice" role="status">{notice}</p>}

      {scale && geometry && (
        <dl class="display-target-metrics">
          <div><dt>Scale</dt><dd>{scaleLabel}</dd></div>
          <div><dt>Pixel pitch</dt><dd>{scale.mmPerPixel.toFixed(4)} mm</dd></div>
          <div><dt>Square</dt><dd>{formatMillimetres(geometry.pattern.squareLengthMm)}</dd></div>
          {geometry.pattern.kind === "charuco" && <div><dt>Marker</dt><dd>{formatMillimetres(geometry.pattern.markerLengthMm)}</dd></div>}
          <div><dt>Board</dt><dd>{formatMillimetres(geometry.boardWidthMm)} × {formatMillimetres(geometry.boardHeightMm)}</dd></div>
          <div><dt>Browser raster</dt><dd>{environment.pixelWidth} × {environment.pixelHeight}</dd></div>
        </dl>
      )}
      {parsed.profile && !rasterMatches && <p class="display-profile-warning">Browser raster differs from the selected native resolution.</p>}
      {geometry && !targetFits && <p class="display-profile-warning">The board does not fit this display at the selected square size.</p>}

      <div class="button-row display-target-actions">
        <button type="button" class="button secondary" disabled={!parsed.profile} onClick={() => persistProfile()}>Save profile</button>
        {draft.id && <button type="button" class="button secondary" onClick={deleteProfile}>Delete profile</button>}
        <button type="button" class="button secondary" disabled={!scale} onClick={beginVerification}>Verify with ruler</button>
        <button type="button" class="button secondary" disabled={!workerReady || !geometry || !targetFits || displayBusy} onClick={showBoard}>{displayBusy ? "Preparing…" : "Display board"}</button>
      </div>
      </section>}

      {overlayMode === "verify" && (
        <div class="display-target-overlay verify" role="dialog" aria-modal="true" aria-label="Verify display scale">
          <div class="display-ruler-wrap">
            <svg ref={rulerRef} class="display-ruler" style={{ width: `${barPixels / environment.devicePixelRatio}px` }} viewBox={`0 0 ${barPixels} 80`} preserveAspectRatio="none" aria-label="Measurement reference">
              <line x1="0" y1="40" x2={barPixels} y2="40" />
              <line x1="0" y1="20" x2="0" y2="60" />
              <line x1={barPixels} y1="20" x2={barPixels} y2="60" />
            </svg>
            <span>Measure between the end marks.</span>
          </div>
          <div class="display-target-toolbar verify-controls">
            <label class="field"><span>Measured length (mm)</span><input type="number" min={1} max={10000} step={0.1} autofocus value={measuredLength} onInput={(event) => setMeasuredLength(event.currentTarget.value)} /></label>
            <button type="button" class="button primary" onClick={applyVerification}>Apply</button>
            <button type="button" class="button secondary" onClick={closeOverlay}>Cancel</button>
          </div>
        </div>
      )}

      {overlayMode === "board" && geometry && (
        <div class="display-target-overlay board" role="dialog" aria-modal="true" aria-label="Calibration board display">
          <div class="display-target-toolbar board-controls"><span>{formatMillimetres(geometry.pattern.squareLengthMm)} squares · {scaleLabel.toLowerCase()} scale</span><button type="button" class="button secondary" onClick={closeOverlay}>Exit</button></div>
          {displaySvg ? (
            <div class="display-target-board" style={{ width: `${geometry.boardWidthPixels / environment.devicePixelRatio}px`, height: `${geometry.boardHeightPixels / environment.devicePixelRatio}px` }} dangerouslySetInnerHTML={{ __html: displaySvg }} />
          ) : (
            <span class="display-target-loading">Preparing board…</span>
          )}
        </div>
      )}
    </>
  );
}
