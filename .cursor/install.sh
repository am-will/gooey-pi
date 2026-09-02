#!/usr/bin/env bash
# Cloud Agent install phase for GooeyPi.
#
# Idempotent bootstrap that prepares a checked-out working tree so a Cloud
# Agent can lint, type-check, test, build, and run the Electron desktop app.
# Runs on Cursor's default Ubuntu base image (which already provides nvm, sudo,
# build-essential, python3, xvfb and ffmpeg).
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Node toolchain (pinned by .nvmrc + package.json#engines) ---------------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install >/dev/null        # reads .nvmrc (24.15.0); no-op once installed
nvm use >/dev/null
nvm alias default "$(cat .nvmrc)" >/dev/null

# --- System libraries to run/build the Electron app and its headless -------
# --- (xvfb) Playwright Electron e2e suite ----------------------------------
# apt is only reachable when sudo is available; skip cleanly otherwise so the
# script still works on images where these libraries are already present.
if command -v sudo >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    xvfb \
    libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
    libgbm1 libgtk-3-0t64 libasound2t64 libxkbcommon0 libpango-1.0-0 \
    libcairo2 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 \
    libxi6 libatspi2.0-0t64 libxshmfence1 libx11-xcb1 >/dev/null
fi

# --- Repository-pinned npm (package.json#packageManager) -------------------
# Installs the exact npm floor before dependencies; the repo rejects older npm.
npm run toolchain:bootstrap

# --- Project dependencies + native/Electron runtime ------------------------
# `npm ci` runs the repo postinstall (electron platform download + native
# dependency rebuild). node-pty is rebuilt for Electron; zeromq/koffi ship
# vendored prebuilt binaries, so npm 12's default script blocking is fine.
npm ci

echo "GooeyPi Cloud Agent install complete: node $(node -v), npm $(npm -v)."
