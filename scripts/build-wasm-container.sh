#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="emscripten/emsdk:4.0.15@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

docker run --rm \
  --volume "${PROJECT_ROOT}:/workspace" \
  --workdir /workspace \
  "${IMAGE}" \
  bash -lc "scripts/build-wasm.sh; chown -R ${HOST_UID}:${HOST_GID} public/wasm .cache/opencv-wasm"
