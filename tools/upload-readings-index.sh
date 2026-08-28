#!/usr/bin/env bash
#
# Upload a project's reading index to a deployment.
#
#   export the production admin passphrase into the environment, then:
#     bash tools/upload-readings-index.sh ppol5013
#
# Run this after every corpus rebuild. The index is a derived copy of
# copyrighted PDFs, so it is never committed and never ships with a deploy; the
# deployment reads it from a mounted volume, and this is the only thing that
# puts it there.
#
# The deployment must have READINGS_INDEX_<SLUG> pointing at a path on that
# volume (e.g. READINGS_INDEX_PPOL5013=/data/ppol5013-readings.db). Without it
# the API refuses the upload rather than writing to a container filesystem that
# the next redeploy erases.
#
# Full re-deploy procedure after a syllabus change:
#   1. python3 tools/build-ppol-corpus.py --gloss
#   2. bash tools/upload-readings-index.sh ppol5013   (with the passphrase exported)
#   3. git add projects/<slug>/content/readings/grounding.md && commit && push
#      (the grounding map IS committed; the index is not)

set -euo pipefail

SLUG="${1:?usage: upload-readings-index.sh <project-slug> [--url <base-url>]}"
shift || true

# No default deployment URL: the production hostname is not published in this
# repository, and a wrong default would upload a 20 MB index to somewhere
# unintended. Set DEPLOY_URL (it is in the untracked root .env) or pass --url.
BASE_URL="${DEPLOY_URL:-}"
if [[ "${1:-}" == "--url" ]]; then
  BASE_URL="${2:?--url needs a value}"
fi
if [[ -z "$BASE_URL" ]]; then
  echo "error: no deployment URL. Set DEPLOY_URL or pass --url <base-url>." >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$REPO_ROOT/projects/$SLUG/content/readings/readings.db"

if [[ -z "${ADMIN_PASSPHRASE:-}" ]]; then
  echo "error: ADMIN_PASSPHRASE is not set." >&2
  echo "       Export it from the production value kept in the untracked root" >&2
  echo "       .env, then run this script. Never paste the passphrase inline." >&2
  exit 2
fi

if [[ ! -f "$INDEX" ]]; then
  echo "error: no index at $INDEX" >&2
  echo "       Build it first: python3 tools/build-ppol-corpus.py --gloss" >&2
  exit 2
fi

# A WAL sidecar means the last build did not checkpoint; uploading the .db alone
# would ship an index missing its most recent writes.
if [[ -f "$INDEX-wal" ]]; then
  echo "error: $INDEX-wal exists, so the database has uncheckpointed writes." >&2
  echo "       Re-run the build (it VACUUMs and closes cleanly) before uploading." >&2
  exit 2
fi

SIZE=$(wc -c < "$INDEX" | tr -d ' ')
echo "Index:      $INDEX ($((SIZE / 1000000)) MB)"
echo "Deployment: $BASE_URL"
echo "Project:    $SLUG"

echo "Authenticating..."
TOKEN=$(curl -fsS -X POST "$BASE_URL/api/admin/login" \
  -H 'Content-Type: application/json' \
  -H "X-Project: $SLUG" \
  -d "{\"passphrase\": $(printf '%s' "$ADMIN_PASSPHRASE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

echo "Uploading..."
curl -fsS -X POST "$BASE_URL/api/admin/readings-index" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Project: $SLUG" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@$INDEX" \
  | python3 -m json.tool

echo "Done. Verify with:"
echo "  curl -s '$BASE_URL/api/health' -H 'X-Project: $SLUG'"
