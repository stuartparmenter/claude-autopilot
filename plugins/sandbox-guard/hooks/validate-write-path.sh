#!/usr/bin/env bash
# Sandbox guard: deny Write/Edit to paths outside the agent's working directory.
# Compensates for bwrap sandbox not covering built-in file tools.
set -euo pipefail

input=$(cat)

cwd=$(echo "$input" | jq -r '.cwd // empty')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "$file_path" ]]; then
  exit 0  # No file_path (e.g. some Edit calls) — allow
fi

if [[ -z "$cwd" ]]; then
  exit 0  # Can't enforce without knowing cwd — allow
fi

# Resolve to absolute path (handle relative paths and ~)
if [[ "$file_path" == "~"* ]]; then
  file_path="${HOME}${file_path:1}"
fi
if [[ "$file_path" != /* ]]; then
  file_path="$cwd/$file_path"
fi

# Normalize: collapse // and resolve . and .. components
# Use readlink -m which resolves without requiring the path to exist
resolved=$(readlink -m "$file_path")

# Normalize cwd too
resolved_cwd=$(readlink -m "$cwd")

# Allow: under cwd
if [[ "$resolved" == "$resolved_cwd"/* || "$resolved" == "$resolved_cwd" ]]; then
  exit 0
fi

# Allow: under /tmp
if [[ "$resolved" == /tmp/* || "$resolved" == /tmp ]]; then
  exit 0
fi

# Allow: under agent's TMPDIR (if set)
if [[ -n "${TMPDIR:-}" ]]; then
  resolved_tmpdir=$(readlink -m "$TMPDIR")
  if [[ "$resolved" == "$resolved_tmpdir"/* || "$resolved" == "$resolved_tmpdir" ]]; then
    exit 0
  fi
fi

# Deny everything else
tool_name=$(echo "$input" | jq -r '.tool_name // "Write"')
cat >&2 <<DENY
{"hookSpecificOutput":{"permissionDecision":"deny"},"systemMessage":"[sandbox-guard] ${tool_name} to '${file_path}' blocked: path is outside the working directory (${cwd}). Only write to files within your working directory or /tmp."}
DENY
exit 2
