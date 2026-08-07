#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCV_VERSION="${OPENCV_VERSION:-4.13.0}"
OPENCV_ARCHIVE_SHA256="${OPENCV_ARCHIVE_SHA256:-1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d}"
CACHE_ROOT="${PROJECT_ROOT}/.cache/opencv-wasm"
SOURCE_ROOT="${CACHE_ROOT}/opencv-${OPENCV_VERSION}"
OPENCV_BUILD="${CACHE_ROOT}/build-${OPENCV_VERSION}"
MODULE_BUILD="${CACHE_ROOT}/lensbench-${OPENCV_VERSION}"
OUTPUT_ROOT="${PROJECT_ROOT}/public/wasm"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake is required. Run this script in the pinned emscripten/emsdk container." >&2
  exit 1
fi

mkdir -p "${CACHE_ROOT}" "${OUTPUT_ROOT}"

if [[ ! -f "${SOURCE_ROOT}/CMakeLists.txt" ]]; then
  archive="${CACHE_ROOT}/opencv-${OPENCV_VERSION}.tar.gz"
  if [[ ! -f "${archive}" ]]; then
    curl --fail --location --retry 3 \
      "https://github.com/opencv/opencv/archive/refs/tags/${OPENCV_VERSION}.tar.gz" \
      --output "${archive}"
  fi
  echo "${OPENCV_ARCHIVE_SHA256}  ${archive}" | sha256sum --check --status
  tar -xzf "${archive}" -C "${CACHE_ROOT}"
fi

emcmake cmake -S "${SOURCE_ROOT}" -B "${OPENCV_BUILD}" -G"Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="-msimd128" \
  -DCMAKE_CXX_FLAGS="-msimd128" \
  -DCPU_BASELINE= \
  -DCPU_DISPATCH= \
  -DCV_ENABLE_INTRINSICS=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DBUILD_LIST=core,imgproc,calib3d,objdetect \
  -DBUILD_TESTS=OFF \
  -DBUILD_PERF_TESTS=OFF \
  -DBUILD_EXAMPLES=OFF \
  -DBUILD_opencv_apps=OFF \
  -DBUILD_opencv_js=OFF \
  -DBUILD_JAVA=OFF \
  -DBUILD_opencv_python3=OFF \
  -DWITH_PTHREADS_PF=OFF \
  -DWITH_IPP=OFF \
  -DWITH_OPENCL=OFF \
  -DWITH_ITT=OFF \
  -DWITH_ADE=OFF

cmake --build "${OPENCV_BUILD}" --parallel

emcmake cmake -S "${PROJECT_ROOT}/cpp" -B "${MODULE_BUILD}" -G"Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DOpenCV_DIR="${OPENCV_BUILD}"
cmake --build "${MODULE_BUILD}" --parallel

cp "${MODULE_BUILD}/calibration.js" "${OUTPUT_ROOT}/calibration.js"
cp "${MODULE_BUILD}/calibration.wasm" "${OUTPUT_ROOT}/calibration.wasm"

echo "Wrote ${OUTPUT_ROOT}/calibration.js and calibration.wasm"
