#!/usr/bin/env bash
# Copy the shared protocol core from the desktop app into the mobile backend.
# The desktop modules (src/main/*.js) are the single source of truth; the mobile
# backend bundles its own copy because nodejs-mobile only ships the
# nodejs-project/ folder. Run this whenever the core changes.
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/../src/main"
dst="$here/nodejs-assets/nodejs-project/core"
mkdir -p "$dst"
cp "$src/code.js" "$src/transfer.js" "$src/swarm.js" "$src/lan.js" "$dst/"
echo "Synced core -> $dst"
