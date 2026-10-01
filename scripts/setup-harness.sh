#!/usr/bin/env bash
# Installs the public OpenFox npm package into a private tree for the integration
# harness. It never touches the developer's OpenFox install, config, auth or
# session database: HARNESS_PKG_DIR is a throwaway directory under /tmp.
set -euo pipefail

HARNESS_PKG_DIR="${HARNESS_PKG_DIR:-/tmp/of-harness-probe}"
OPENFOX_VERSION="${OPENFOX_VERSION:-2.0.160}"

# The version actually installed in the tree is the version the harness will
# load. Reusing a tree that holds a different release would make every reported
# version claim false, so a mismatch is refused instead of silently accepted.
installed_version() {
  node -p "require('$1/node_modules/openfox/package.json').version" 2>/dev/null || true
}

PRESENT_VERSION="$(installed_version "$HARNESS_PKG_DIR")"
if [ -n "$PRESENT_VERSION" ]; then
  if [ "$PRESENT_VERSION" != "$OPENFOX_VERSION" ]; then
    echo "refusing to reuse $HARNESS_PKG_DIR: it holds openfox@$PRESENT_VERSION, not openfox@$OPENFOX_VERSION" >&2
    echo "use a separate HARNESS_PKG_DIR per version, e.g. HARNESS_PKG_DIR=/tmp/of-harness-$OPENFOX_VERSION" >&2
    exit 1
  fi
  echo "openfox@$OPENFOX_VERSION already present in $HARNESS_PKG_DIR"
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

# The version is read back from the installed tree, never from the requested
# one, so a report cannot claim a version that was not actually loaded.
ACTUAL_VERSION="$(installed_version "$HARNESS_PKG_DIR")"
if [ "$ACTUAL_VERSION" != "$OPENFOX_VERSION" ]; then
  echo "failed to install openfox@$OPENFOX_VERSION (found: ${ACTUAL_VERSION:-none})" >&2
  exit 1
fi
echo "openfox version: $ACTUAL_VERSION"
echo "harness package tree: $HARNESS_PKG_DIR"
