#!/usr/bin/env bash
# Builds the standalone Diffpane executable, without installers (--no-bundle).
#
# Usage (from anywhere):  bash scripts/build.sh
# Output:                 src-tauri/target/release/diffpane  (diffpane.exe on Windows)

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi

npx tauri build --no-bundle

exe=src-tauri/target/release/diffpane
[ -f "$exe.exe" ] && exe="$exe.exe"
echo "Built: $(pwd)/$exe ($(du -h "$exe" | cut -f1))"
