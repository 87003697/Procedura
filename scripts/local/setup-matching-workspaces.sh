#!/usr/bin/env bash
set -euo pipefail

# Create any number of ready-to-run worktrees.
# Usage: bash scripts/local/setup-matching-workspaces.sh [--ref REF] PATH [PATH ...]

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REF="HEAD"
DIRS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) [ "$#" -ge 2 ] || { echo "--ref needs a value" >&2; exit 2; }; REF="$2"; shift 2 ;;
    -h|--help) sed -n '4,5p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) DIRS+=("$1"); shift ;;
  esac
done
[ "${#DIRS[@]}" -gt 0 ] || { echo "at least one workspace path is required" >&2; exit 2; }

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required; run scripts/install-deps.sh" >&2; exit 1; }
git -C "$REPO" rev-parse "$REF" >/dev/null || { echo "invalid git ref: $REF" >&2; exit 1; }

for dir in "${DIRS[@]}"; do
  if [ -e "$dir" ]; then
    echo "workspace already exists: $dir" >&2
    exit 1
  fi
  git -C "$REPO" worktree add --detach "$dir" "$REF"
  ( cd "$dir"
    test -w . || { echo "workspace is not writable: $dir" >&2; exit 1; }
    bun install --offline >/dev/null
  )
  echo "ready: $dir"
done
