# Lensbench

Lensbench is a private, browser-only monocular camera calibration tool. It captures or imports calibration views, detects ChArUco or chessboard targets with OpenCV WebAssembly, solves standard or fisheye intrinsics, validates the result live, and exports versioned JSON or OpenCV YAML.

There is no runtime server. Camera frames, imported images, observations, and results remain in the browser. The generated site can be hosted directly on GitHub Pages.

## Features

- Guided live capture with sharpness, stability, and X/Y/size/skew coverage feedback
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

The first connection leaves dimensions unset unless the user enters them, allowing the camera to choose its default native mode. Once connected, the width and height fields show the active mode and the track's reported bounds. Entered dimensions are required exactly; Lensbench does not fall back to browser-selected dimensions. Every camera request also requires `resizeMode: { exact: "none" }`, so browsers that cannot guarantee an uncropped, unscaled stream are rejected. **Actual stream** shows the settings used for calibration. Changing the camera, resolution, zoom, focus mode, or resize mode clears incompatible captures.

## Verification

```bash
npm run check
npm run test:wasm
npm run build
```

The WebAssembly build is intentionally single-threaded. This keeps the application compatible with ordinary GitHub Pages hosting without requiring cross-origin isolation headers. Detection runs in a dedicated module worker, and frames are downscaled to a maximum 1920-pixel working edge. The corrected live preview runs in WebGL2 at the camera frame cadence, with the OpenCV worker retained as a fallback. Fisheye previews use OpenCV's full-field (`balance = 1`) projection matrix.

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
