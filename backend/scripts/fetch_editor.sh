#!/usr/bin/env bash
# 拉取锁定版本的 Manga Editor Desu! 到 backend/static/editor/
# 用法：bash backend/scripts/fetch_editor.sh
set -euo pipefail

COMMIT="04e0cf3de1f3677682f6d1831f2713db70e441ba"
REPO="new-sankaku/manga-editor-desu"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$ROOT/backend/static/editor"
TMP="${TMPDIR:-/tmp}/med_fetch"

echo "拉取 $REPO @ $COMMIT ..."
rm -rf "$TMP"; mkdir -p "$TMP"
curl -sL -o "$TMP/med.zip" "https://codeload.github.com/$REPO/zip/$COMMIT"
unzip -q -o "$TMP/med.zip" -d "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'manga-editor-desu-*' | head -1)"
[ -n "$SRC" ] || { echo "解压后未找到源码目录"; exit 1; }

rm -rf "$DEST"; mkdir -p "$DEST"
for item in index.html css js third font 02_images_svg 03_images json_js \
            manifest.json service-worker.js favicon.ico favicon.svg package.json LICENSE robots.txt; do
  [ -e "$SRC/$item" ] && cp -r "$SRC/$item" "$DEST/"
done

echo "已就位：$DEST"
