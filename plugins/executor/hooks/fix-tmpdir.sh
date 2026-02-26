#!/usr/bin/env bash
set -euo pipefail

# Bridge AUTOPILOT_TMPDIR (set by claude.ts) into CLAUDE_ENV_FILE so it
# persists as TMPDIR for all subsequent Bash calls (git, bun, etc.).
# This works around Claude Code's sandbox overriding TMPDIR to a broken
# /tmp/claude/ path. See: github.com/anthropics/claude-code/issues/15700

if [[ -z "${CLAUDE_ENV_FILE:-}" ]]; then
  exit 0
fi

if [[ -n "${AUTOPILOT_TMPDIR:-}" ]] && [[ -d "${AUTOPILOT_TMPDIR}" ]]; then
  echo "export TMPDIR=\"${AUTOPILOT_TMPDIR}\"" >> "$CLAUDE_ENV_FILE"
  exit 0
fi

# Fallback: probe for a writable path if AUTOPILOT_TMPDIR wasn't set
uid=$(id -u)
for candidate in "${TMPDIR:-}" "/tmp/claude-${uid}" "/tmp"; do
  [[ -z "$candidate" ]] && continue
  mkdir -p "$candidate" 2>/dev/null || continue
  if touch "$candidate/.tmpdir-test" 2>/dev/null; then
    rm -f "$candidate/.tmpdir-test"
    echo "export TMPDIR=\"${candidate}\"" >> "$CLAUDE_ENV_FILE"
    exit 0
  fi
done

exit 0
