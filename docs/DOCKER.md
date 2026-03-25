# Docker Quick Start

## 1) Stop local processes using the same ports

Your app uses `3000`. If local Node/Mongo are already running, stop them first.

## 2) Build and start containers

```bash
docker compose up --build -d
```

## 3) Check status/logs

```bash
docker compose ps
docker compose logs -f app
```

## 4) Open app

- http://localhost:3000

## 5) Stop containers

```bash
docker compose down
```

## 6) Stop and remove containers + Mongo volume (deletes Docker DB data)

```bash
docker compose down -v
```

## Notes

- `docker-compose.yml` forces app Mongo URI to:
  - `mongodb://mongo:27017/terzocloud_assets`
- Mongo data persists in Docker volume:
  - `mongo-data`

## DB Backup / Restore

### Backup Docker Mongo to local file

```bash
npm run db:backup
```

Optional custom args:

```bash
./scripts/db-backup.sh terzocloud_assets backups/my-snapshot.archive.gz
```

### One-line restore (with automatic pre-restore backup)

```bash
npm run db:restore -- seed.gz
```

The restore script will:
- Create a safety backup first in `backups/`
- Restore `seed.gz` into `terzocloud_assets` with `--drop`
- Print `users/assets/supportrequests` counts

## Safe Seed (does not delete collections)

Use this when you want to refresh baseline users/assets without wiping request data:

```bash
npm run seed:docker:safe
```

`--safe` mode upserts users and assets; it does not run `deleteMany` on collections.
