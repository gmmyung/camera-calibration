# Web Camera Calibration Tool

Web Camera Calibration Tool is a browser-only monocular camera calibration tool. It captures or imports calibration views, detects ChArUco or chessboard targets with OpenCV WebAssembly, solves standard or fisheye intrinsics, and previews the correction.

There is no runtime server. Camera frames, imported images, observations, and results remain in the browser. The generated site can be hosted directly on GitHub Pages.

## Features

- Guided live capture with stability and X/Y/size/skew feedback
- JPEG, PNG, and WebP import grouped by exact resolution
- Standard five-coefficient radial/tangential and four-coefficient fisheye models
- ChArUco and chessboard presets plus custom row and column counts
- SVG board export
- Board-only display tabs with viewport fitting and fullscreen control
- Robust reprojection-error filtering with reviewable exclusions
- Point-coverage and residual maps, worst-view overlays, and leave-one-view-out stability
- Live and independent-image undistortion previews
- IndexedDB recovery plus portable session import/export
- Versioned JSON, OpenCV YAML, and ROS `camera_info` YAML exports

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

The first connection leaves dimensions unset unless the user enters them, allowing the camera to choose its default mode. Entered dimensions are requested exactly; the tool does not fall back to browser-selected dimensions. Browsers expose independent width and height bounds, not a list of valid mode combinations, so the UI does not present those bounds as camera modes. Where supported, camera requests also require `resizeMode: { exact: "none" }`. Other browsers can still connect, but only the actual stream dimensions can be reported. Changing the camera or stream settings clears incompatible captures.

## Display targets

**Open board in new tab** launches a separate board-only view. The board fills the available viewport while preserving complete board squares and marker modules; a fullscreen control is included when the browser supports it.

Physical square size is not required to solve camera intrinsics. Object points and pose translations use board-square units, so translation values are relative to one square rather than millimetres.

## Verification

```bash
npm run check
npm run test:wasm
npm run build
```

The WebAssembly build is intentionally single-threaded. This keeps the application compatible with ordinary GitHub Pages hosting without requiring cross-origin isolation headers. Detection runs in a dedicated module worker, and frames are downscaled to a maximum 1920-pixel working edge. The corrected live preview runs in WebGL2 at the camera frame cadence, with the OpenCV worker retained as a fallback. Fisheye previews provide centered Full (`balance = 1`) and Fill (`balance = 0`) projections; Fill is the default.

## GitHub Pages

The workflow in `.github/workflows/deploy.yml` builds and caches OpenCV WASM, runs the TypeScript tests, creates the Vite production bundle, and deploys it to Pages after pushes to `main`. Enable **Settings → Pages → Source → GitHub Actions** in the repository.

Vite uses relative asset URLs, so the same artifact works for both a user site and a repository subpath.

## Calibration contract

Results use schema version 1 and include:

- exact source image dimensions and captured stream settings
- row-major 3×3 camera matrix
- model-specific distortion vector
- total and per-view reprojection errors
- point-level reprojection residuals and sampled leave-one-view-out parameter variation
- included and excluded view identifiers
- target layout and OpenCV/app versions

A calibration is valid only for the same camera pipeline, resolution, crop, zoom, and focus state. Browsers may provide processed video rather than raw sensor images.

## AI disclosure

Development of this software was AI-assisted. Verify calibration results independently before production or safety-critical use.
