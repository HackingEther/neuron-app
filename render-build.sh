#!/usr/bin/env bash
set -euo pipefail
npm install
# Install semgrep via pipx for the container user
python3 -m pip install --user pipx
python3 -m pipx ensurepath
export PATH="$PATH:$HOME/.local/bin:$HOME/.local/pipx/venvs/semgrep/bin"
pipx install semgrep
echo "Semgrep installed at: $(command -v semgrep || true)"
