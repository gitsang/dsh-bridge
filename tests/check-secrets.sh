#!/usr/bin/env bash
# Fail if a tracked file looks like it contains a live credential.
#
# The project's live-test tooling reads ~/.dsh/.credentials.yaml at runtime,
# so this guard keeps a pasted secret from ever reaching the remote.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
# Files intentionally allowed to contain placeholders only.
scan() {
  local label="$1" pattern="$2"
  local hits
  hits=$(git grep -InE "$pattern" -- . \
    ':!tests/check-secrets.sh' \
    ':!*.lock' 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "✗ $label" >&2
    echo "$hits" >&2
    status=1
  fi
}

# dsh browser-session signing secret: 43 base64url chars (32 bytes).
scan "possible dsh browser-session secret" '(secret|SECRET)[A-Za-z_]*["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9_-]{43}\b'
# Provider API keys.
scan "possible API key" '(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})'
# A minted session cookie pasted into a file.
scan "possible minted dsh cookie" 'dsh-auth-[A-Za-z0-9_-]{20,}=v1\.'
# Absolute local paths to credential files are fine in prose, but not a value.
scan "possible inline credential value" 'payload:\s*\{?[^}]*secret:\s*[A-Za-z0-9_-]{20,}'

if [ "$status" -eq 0 ]; then
  echo "✓ no credential material found in tracked files"
fi
exit "$status"
