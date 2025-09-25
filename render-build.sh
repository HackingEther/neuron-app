#!/usr/bin/env bash
set -euo pipefail

echo ">>> Neuron LLM build: installing Node dependencies"

if ! command -v npm >/dev/null 2>&1; then
  echo "[build] npm not found on build image"; exit 1
fi

if [ -f package-lock.json ]; then
  echo "[build] package-lock.json found; attempting npm ci (strict install)"
  if npm ci; then
    echo "[build] npm ci succeeded"
  else
    echo "[build] npm ci failed due to lock mismatch — falling back to npm install"
    npm install
  fi
else
  echo "[build] no package-lock.json; running npm install"
  npm install
fi

echo ">>> Build complete"
