#!/usr/bin/env bash
# Build nfsu2.wasm (with BOTH WebGPU/WGSL and WebGL2/GLSL ES 3.00 shader translators)
# inside WSL 2 Ubuntu using wasi-sdk 34.
#
# Usage (from WSL 2):
#   bash scripts/build-wasm.sh "/mnt/f/PROJECT/BROTATO WEB/Need for Speed Underground 2/SPEED2.EXE"
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXE="${1:-}"
EXPECTED_SHA="f9dd86c054878ce6276beb07c1fd61874f7a1e4bf1f241b084c65b73e24168a7"

if [ -z "$EXE" ] || [ ! -f "$EXE" ]; then
  echo "Usage: bash scripts/build-wasm.sh \"/path/to/SPEED2.EXE\""
  echo "Note: Requires NFSU2 v1.2 North America SPEED2.EXE (4,800,512 bytes, SHA-256 $EXPECTED_SHA)"
  exit 1
fi

ACTUAL_SHA="$(sha256sum "$EXE" | awk '{print $1}')"
ACTUAL_SZ="$(stat -c%s "$EXE")"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "ERROR: SPEED2.EXE hash mismatch!"
  echo "  Found:    $ACTUAL_SHA ($ACTUAL_SZ bytes)"
  echo "  Expected: $EXPECTED_SHA (4800512 bytes, v1.2 North America)"
  echo "The static recompiler's runtime hooks require the exact v1.2 NA executable."
  exit 1
fi

# Install wasi-sdk 34 into ~/nfsu2-deps if not already present
WASI_DIR="$HOME/nfsu2-deps/wasi-sdk-34.0-x86_64-linux"
if [ ! -x "$WASI_DIR/bin/clang" ]; then
  echo "Downloading wasi-sdk 34.0 for Linux x86_64..."
  mkdir -p "$HOME/nfsu2-deps"
  curl -4 -fSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-x86_64-linux.tar.gz" \
    -o "$HOME/nfsu2-deps/wasi-sdk-34.tar.gz"
  tar -xzf "$HOME/nfsu2-deps/wasi-sdk-34.tar.gz" -C "$HOME/nfsu2-deps"
  rm -f "$HOME/nfsu2-deps/wasi-sdk-34.tar.gz"
fi

# Build inside WSL native filesystem (~10x faster than /mnt/f), then copy out/web/nfsu2.wasm back
WORK="$HOME/nfsu2web-build"
echo "Syncing sources to $WORK..."
mkdir -p "$WORK"
rsync -a --delete \
  --exclude '.git' --exclude 'web/node_modules' --exclude 'cf/node_modules' \
  --exclude 'out' --exclude 'gen' --exclude '.venv' \
  "$ROOT/" "$WORK/"

cd "$WORK"
# Ensure bash scripts have Unix LF endings when synced from a Windows checkout
find . -maxdepth 4 -name '*.sh' -exec sed -i 's/\r$//' {} +
if [ ! -x .venv/bin/pip ]; then
  rm -rf .venv
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

echo "Step 1/2: Lifting SPEED2.EXE -> C (web/gen.sh)..."
bash web/gen.sh "$EXE"

echo "Step 2/2: Compiling C + runtime (WebGPU + WebGL2) -> nfsu2.wasm (web/build.sh)..."
WASI="$WASI_DIR" bash web/build.sh

mkdir -p "$ROOT/out/web"
cp -f "$WORK/out/web/nfsu2.wasm" "$WORK/out/web/nfsu2.json" "$ROOT/out/web/"
echo "SUCCESS! Built:"
ls -lh "$ROOT/out/web/nfsu2.wasm" "$ROOT/out/web/nfsu2.json"
