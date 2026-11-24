#!/usr/bin/env bash
# Build dist/onliner-price-tracker.zip with only Load-unpacked / Web Store files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist"
ZIP_NAME="onliner-price-tracker.zip"
STAGE="$OUT_DIR/_stage"

rm -rf "$STAGE"
mkdir -p "$STAGE/src" "$STAGE/icons" "$OUT_DIR"

cp "$ROOT/manifest.json" "$STAGE/"
cp "$ROOT"/src/* "$STAGE/src/"
cp "$ROOT"/icons/icon16.png "$ROOT"/icons/icon32.png \
   "$ROOT"/icons/icon48.png "$ROOT"/icons/icon128.png \
   "$STAGE/icons/"

rm -f "$OUT_DIR/$ZIP_NAME"
(
  cd "$STAGE"
  zip -r -q "$OUT_DIR/$ZIP_NAME" manifest.json src icons
)

rm -rf "$STAGE"
echo "Wrote $OUT_DIR/$ZIP_NAME"
unzip -l "$OUT_DIR/$ZIP_NAME"
