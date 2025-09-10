#!/usr/bin/env bash
set -euo pipefail

echo ">>> running render-build.sh"

# Install Node dependencies
npm install

# Install semgrep globally (no --user)
pip install semgrep

echo ">>> Semgrep installed at: $(command -v semgrep || true)"
semgrep --version || true
