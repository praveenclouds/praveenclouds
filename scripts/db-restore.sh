#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_FILE="${1:-}"
DB_NAME="${2:-terzocloud_assets}"

if [[ -z "$ARCHIVE_FILE" ]]; then
  echo "Usage: ./scripts/db-restore.sh <archive.gz> [db_name]"
  exit 1
fi

if [[ ! -f "$ARCHIVE_FILE" ]]; then
  echo "Archive not found: $ARCHIVE_FILE"
  exit 1
fi

PRE_BACKUP="backups/${DB_NAME}-pre-restore-$(date +%Y%m%d-%H%M%S).archive.gz"
mkdir -p backups

echo "Creating safety backup before restore: $PRE_BACKUP"
docker compose exec -T mongo mongodump \
  --uri="mongodb://127.0.0.1:27017/${DB_NAME}" \
  --archive \
  --gzip > "$PRE_BACKUP"

echo "Restoring $ARCHIVE_FILE into ${DB_NAME} (drop namespace first)..."
docker compose exec -T mongo mongorestore \
  --gzip \
  --archive \
  --drop \
  "--nsInclude=${DB_NAME}.*" < "$ARCHIVE_FILE"

echo "Restore completed. Current document counts:"
docker compose exec -T mongo mongosh --quiet --eval "
const d = db.getSiblingDB('${DB_NAME}');
print('users=' + d.users.countDocuments());
print('assets=' + d.assets.countDocuments());
print('supportrequests=' + d.supportrequests.countDocuments());
"
