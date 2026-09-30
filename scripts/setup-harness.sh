#!/usr/bin/env bash
# Installs the public OpenFox npm package into a private tree for the integration
# harness. It never touches the developer's OpenFox install, config, auth or
# session database: HARNESS_PKG_DIR is a throwaway directory under /tmp.
set -euo pipefail

HARNESS_PKG_DIR="${HARNESS_PKG_DIR:-/tmp/of-harness-probe}"
OPENFOX_VERSION="${OPENFOX_VERSION:-2.0.160}"

if [ -f "$HARNESS_PKG_DIR/node_modules/openfox/package.json" ]; then
  echo "openfox already present in $HARNESS_PKG_DIR"
else
  mkdir -p "$HARNESS_PKG_DIR"
  cd "$HARNESS_PKG_DIR"
  npm init -y >/dev/null 2>&1
  # No install scripts: better-sqlite3 needs its native binding built separately.
  npm install "openfox@$OPENFOX_VERSION" --ignore-scripts --no-audit --no-fund
fi

# OpenFox requires the better-sqlite3 native binding to serve. The install above
# skipped scripts, so build it explicitly in this throwaway tree.
if [ ! -f "$HARNESS_PKG_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  cd "$HARNESS_PKG_DIR"
  npm rebuild better-sqlite3
fi

node -p "require('$HARNESS_PKG_DIR/node_modules/openfox/package.json').version" \
  | sed 's/^/openfox version: /'
echo "harness package tree: $HARNESS_PKG_DIR"
