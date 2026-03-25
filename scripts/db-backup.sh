#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${1:-terzocloud_assets}"
OUT_FILE="${2:-backups/${DB_NAME}-$(date +%Y%m%d-%H%M%S).archive.gz}"

mkdir -p "$(dirname "$OUT_FILE")"

docker compose exec -T mongo mongodump \
  --uri="mongodb://127.0.0.1:27017/${DB_NAME}" \
  --archive \
  --gzip > "$OUT_FILE"

echo "Backup created: $OUT_FILE"
