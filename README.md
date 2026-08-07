# Lensbench

Lensbench is a private, browser-only monocular camera calibration tool. It captures or imports calibration views, detects ChArUco or chessboard targets with OpenCV WebAssembly, solves standard or fisheye intrinsics, validates the result live, and exports versioned JSON or OpenCV YAML.

There is no runtime server. Camera frames, imported images, observations, and results remain in the browser. The generated site can be hosted directly on GitHub Pages.

## Features

- Guided live capture with sharpness, stability, novelty, tilt, scale, and 3×3 coverage feedback
- JPEG, PNG, and WebP import grouped by exact resolution
- Standard five-coefficient radial/tangential and four-coefficient fisheye models
- ChArUco and chessboard presets plus custom board definitions
- Exact-dimension SVG target generation with a 100 mm print-verification ruler
- Robust reprojection-error filtering with reviewable exclusions
- IndexedDB session recovery and explicit local-data deletion
- Live undistortion preview and OpenCV-compatible exports

## Local development

Requirements:

- Node.js 22+
- Docker, or a local Emscripten 4.0.15 toolchain

Build the pinned OpenCV 4.13.0 module:

```bash
./scripts/build-wasm-container.sh
```

Install and run the frontend:

```bash
npm ci
npm run dev
```

The camera API requires HTTPS or `localhost`. If `public/wasm/calibration.js` and `calibration.wasm` have not been built, the UI loads but reports that the calibration engine is unavailable.

The resolution selector first requests exact width and height constraints, then retries them as preferences when a camera or browser cannot provide that mode. **Actual stream** shows the dimensions returned by `MediaStreamTrack.getSettings()` and is the value used for calibration. Changing the camera, actual resolution, zoom, focus mode, or resize mode clears incompatible captures.

## Verification

```bash
npm run check
npm run build
```

The WebAssembly build is intentionally single-threaded. This keeps the application compatible with ordinary GitHub Pages hosting without requiring cross-origin isolation headers. Pixel processing runs in a dedicated module worker, and frames are downscaled to a maximum 1920-pixel working edge before detection.

## GitHub Pages

The workflow in `.github/workflows/deploy.yml` builds and caches OpenCV WASM, runs the TypeScript tests, creates the Vite production bundle, and deploys it to Pages after pushes to `main`. Enable **Settings → Pages → Source → GitHub Actions** in the repository.

Vite uses relative asset URLs, so the same artifact works for both a user site and a repository subpath.

## Calibration contract

Results use schema version 1 and include:

- exact source image dimensions and captured stream settings
- row-major 3×3 camera matrix
- model-specific distortion vector
- total and per-view reprojection errors
- included and excluded view identifiers
- physical target definition and OpenCV/app versions

A calibration is valid only for the same camera pipeline, resolution, crop, zoom, and focus state. Browsers may provide processed video rather than raw sensor images.
