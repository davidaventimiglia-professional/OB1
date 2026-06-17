#!/usr/bin/env bash
#
# Deploy a repo edge-function to Supabase.
#
# The committed source for each function lives in a top-level directory (e.g.
# ./server, ./oauth-consent). The Supabase deploy bundler runs in a container and
# cannot follow the directory symlinks under supabase/functions/, so this script
# materializes the runtime sources into supabase/functions/<name>/ (a gitignored
# build artifact) and then deploys. Re-running regenerates that copy, so the
# top-level source dir stays the single source of truth.
#
# Usage:
#   scripts/deploy-function.sh <function-name> [src-dir]
#
#   <function-name>  Function name on Supabase and under supabase/functions/
#                    (e.g. oauth-consent, open-brain-mcp).
#   [src-dir]        Committed source directory. Defaults to ./<function-name>.
#
# Examples:
#   scripts/deploy-function.sh oauth-consent
#   scripts/deploy-function.sh open-brain-mcp ./server
#
set -euo pipefail

NAME="${1:?usage: scripts/deploy-function.sh <function-name> [src-dir]}"
SRC="${2:-./$NAME}"

# Run from the repo root regardless of where the script is invoked.
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

if [[ ! -f "$SRC/index.ts" ]]; then
  echo "error: entrypoint not found at $SRC/index.ts" >&2
  exit 1
fi

DEST="supabase/functions/$NAME"

echo "==> Materializing runtime sources: $SRC -> $DEST"
# Remove any prior copy or symlink (rm on a symlink removes the link, not its target).
rm -rf "$DEST"
mkdir -p "$DEST"
# Copy .ts sources and deno.json, excluding test files.
find "$SRC" -maxdepth 1 -type f \( -name '*.ts' -o -name 'deno.json' \) \
  ! -name '*_test.ts' -print -exec cp {} "$DEST/" \;

echo "==> Deploying $NAME (verify_jwt disabled; the function owns its own auth)"
supabase functions deploy "$NAME" --no-verify-jwt

echo "==> Done. Function: $NAME"
