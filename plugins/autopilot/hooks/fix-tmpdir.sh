#!/usr/bin/env bash
set -euo pipefail

# Bridge AUTOPILOT_TMPDIR into CLAUDE_ENV_FILE so TMPDIR is correct for
# all subsequent Bash calls (git, bun, etc.).
#
# The sandbox overrides TMPDIR to /tmp/claude/ which may not be writable.
# AUTOPILOT_TMPDIR (set by claude.ts) points to a per-agent temp directory
# that is explicitly added to the sandbox allowWrite list.
#
# See: github.com/anthropics/claude-code/issues/15700

if [[ -z "${CLAUDE_ENV_FILE:-}" ]]; then
  exit 0
fi

if [[ -n "${AUTOPILOT_TMPDIR:-}" ]]; then
  echo "export TMPDIR=\"${AUTOPILOT_TMPDIR}\"" >> "$CLAUDE_ENV_FILE"
  exit 0
fi

exit 0
