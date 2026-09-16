#!/usr/bin/env bash
# Restore a dump into a fresh disposable database, never into the live database.
set -euo pipefail
cd -- "$(dirname -- "$0")"
archive=${1:-backups/everypost.dump}
test -s "$archive"
scratch="ep_restore_check_$(date +%s)_$$"
cleanup() {
  docker compose exec -T db sh -c 'exec dropdb --if-exists -U "$POSTGRES_USER" "$1"' sh "$scratch" >/dev/null
}
docker compose exec -T db sh -c 'exec createdb -U "$POSTGRES_USER" "$1"' sh "$scratch"
trap cleanup EXIT
docker compose exec -T db sh -c 'exec pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -U "$POSTGRES_USER" -d "$1"' sh "$scratch" < "$archive"
docker compose exec -T db sh -c 'exec psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"' sh "$scratch" <<'SQL'
SELECT 'max_posts='||count(*) FROM public.ep_posts;
SELECT 'max_schedules='||count(*) FROM public.ep_schedules;
SELECT 'candidates='||count(*) FROM public.ep_content_candidates;
SELECT 'telegram_posts='||count(*) FROM repost_bot.ed_posts;
SELECT 'telegram_deliveries='||count(*) FROM repost_bot.deliveries;
SQL
