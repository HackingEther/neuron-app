#!/usr/bin/env bash
set -euo pipefail

echo ">>> Neuron LLM build: installing Node dependencies"
if command -v npm >/dev/null 2>&1; then
  # Prefer reproducible installs if lockfile exists
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
else
  echo "npm not found on build image"; exit 1
fi

echo ">>> Build complete"
