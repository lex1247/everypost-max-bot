#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")"
mkdir -p backups state
exec 9>state/backup.lock
flock -n 9 || exit 0
archive=backups/everypost.dump
temp_archive=backups/everypost.dump.partial
trap 'rm -f -- "$temp_archive"' EXIT
docker compose exec -T db sh -c 'exec pg_dump --format=custom --no-owner --no-privileges --username="$POSTGRES_USER" "$POSTGRES_DB"' > "$temp_archive"
test -s "$temp_archive"
docker compose exec -T db pg_restore --list < "$temp_archive" >/dev/null
bash ./restore-check.sh "$temp_archive"
mv -- "$temp_archive" "$archive"
docker compose --profile maintenance run --rm -T backup backup --host everypost --tag scheduled /backup/everypost.dump /config
# Only a verified remote upload advances this timestamp.
date +%s > state/backup-success
docker compose --profile maintenance run --rm -T backup forget --host everypost --tag scheduled --keep-last 6 --keep-daily 7 --keep-weekly 4 --prune
