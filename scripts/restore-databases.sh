#!/usr/bin/env bash
#
# Tier 1 restore, in the one order that works.
#
# ORDER IS LOAD BEARING:
#
#   1. supabase-db   -- carries `public.telemetry`, which is a FOREIGN TABLE over the historian.
#                       Its foreign server, user mapping and RLS policies come back with it.
#   2. timescaledb   -- the hypertable the foreign table points at.
#   3. verify        -- query `public.telemetry` THROUGH the wrapper. Neither restore proves the
#                       join works, and a broken wrapper surfaces as a relation-level PostgREST
#                       error that reads as a schema fault.
#
# ROLES MUST EXIST FIRST. A dump keeps ownership and its RLS policies reference roles BY NAME, so
# restoring into a database without `supabase_auth_admin`, `authenticator` and
# `supabase_storage_admin` produces a database where every policy denies. On a stack that has
# booted once, db-roles-init has already created them. Do not "fix" a restore with --no-owner.
#
# Full runbook:  supabase/README.md -> "Backup and Recovery"
#
set -eu

# See the note in backup-databases.sh: Git Bash rewrites container paths passed to `docker compose
# exec` unless this is set. A no-op on Linux and macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

BACKUP_MODE="${BACKUP_MODE:-docker}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_STAMP="${BACKUP_STAMP:-}"

SUPABASE_SERVICE="${SUPABASE_SERVICE:-supabase-db}"
SUPABASE_DB_USER="${SUPABASE_DB_USER:-postgres}"
SUPABASE_DB_NAME="${SUPABASE_DB_NAME:-postgres}"
SUPABASE_DB_HOST="${SUPABASE_DB_HOST:-localhost}"
SUPABASE_DB_PORT="${SUPABASE_DB_PORT:-54322}"
SUPABASE_DB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"

TIMESCALE_SERVICE="${TIMESCALE_SERVICE:-timescaledb}"
TIMESCALE_DB_USER="${DB_USER:-postgres}"
TIMESCALE_DB_NAME="${DB_NAME:-postgres}"
TIMESCALE_DB_HOST="${TIMESCALE_HOST:-localhost}"
TIMESCALE_DB_PORT="${TIMESCALE_PORT:-5433}"
TIMESCALE_DB_PASSWORD="${DB_PASSWORD:-postgres}"

STORAGE_SERVICE="${STORAGE_SERVICE:-supabase-storage}"
STORAGE_CONTAINER_PATH="${STORAGE_CONTAINER_PATH:-/var/lib/storage}"
RESTORE_STORAGE="${RESTORE_STORAGE:-true}"

COMPOSE="${COMPOSE:-docker compose}"
ASSUME_YES="${ASSUME_YES:-false}"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$BACKUP_STAMP" ] || die "set BACKUP_STAMP=<stamp>. Available:
$(ls -1 "$BACKUP_DIR" 2>/dev/null | sed -n 's/^manifest-\(.*\)\.txt$/  \1/p' || echo '  (none found)')"

MANIFEST="$BACKUP_DIR/manifest-${BACKUP_STAMP}.txt"
[ -f "$MANIFEST" ] || die "no manifest at $MANIFEST"

# shellcheck disable=SC1090
FORMAT=$(sed -n 's/^format=//p' "$MANIFEST")
SUPABASE_FILE="$BACKUP_DIR/$(sed -n 's/^supabase_db=//p' "$MANIFEST")"
TIMESCALE_FILE="$BACKUP_DIR/$(sed -n 's/^timescaledb=//p' "$MANIFEST")"
STORAGE_NAME=$(sed -n 's/^storage=//p' "$MANIFEST")

[ -f "$SUPABASE_FILE" ]  || die "missing $SUPABASE_FILE"
[ -f "$TIMESCALE_FILE" ] || die "missing $TIMESCALE_FILE"

cat <<EOF

  RESTORE $BACKUP_STAMP  (format=$FORMAT mode=$BACKUP_MODE)

    supabase-db  <- $SUPABASE_FILE
    timescaledb  <- $TIMESCALE_FILE
    storage      <- ${STORAGE_NAME:-<not in this backup>}

  THIS OVERWRITES BOTH DATABASES. Every logged-in browser is invalidated, because auth.sessions
  is replaced along with everything else.

EOF

if [ "$ASSUME_YES" != "true" ]; then
  printf 'Type RESTORE to continue: '
  read -r reply
  [ "$reply" = "RESTORE" ] || die "aborted"
fi

# RETURNS THE RESTORE'S STATUS EXPLICITLY. `set -e` is suspended inside a function invoked as the
# left side of `||`, which the historian below needs -- so a bare `set -e` here would let a failed
# psql fall through to `log "  ok"` and return 0.
#
# `a | b` reports b's status, so psql's ON_ERROR_STOP result is what gets captured.
restore_db() {
  name="$1"; service="$2"; user="$3"; db="$4"; host="$5"; port="$6"; pw="$7"; file="$8"
  rc=0

  log "restoring $name from $(basename "$file")"
  if [ "$FORMAT" = "custom" ]; then
    if [ "$BACKUP_MODE" = "docker" ]; then
      $COMPOSE exec -T -e PGPASSWORD="$pw" "$service" \
        pg_restore -U "$user" -d "$db" --clean --if-exists < "$file" || rc=$?
    else
      PGPASSWORD="$pw" pg_restore -h "$host" -p "$port" -U "$user" -d "$db" \
        --clean --if-exists "$file" || rc=$?
    fi
  else
    if [ "$BACKUP_MODE" = "docker" ]; then
      gunzip -c "$file" | $COMPOSE exec -T -e PGPASSWORD="$pw" "$service" \
        psql -v ON_ERROR_STOP=1 -U "$user" -d "$db" || rc=$?
    else
      gunzip -c "$file" | PGPASSWORD="$pw" psql -v ON_ERROR_STOP=1 \
        -h "$host" -p "$port" -U "$user" -d "$db" || rc=$?
    fi
  fi

  [ "$rc" -eq 0 ] || return "$rc"
  log "  ok"
}

sb_query() {
  if [ "$BACKUP_MODE" = "docker" ]; then
    $COMPOSE exec -T -e PGPASSWORD="$SUPABASE_DB_PASSWORD" "$SUPABASE_SERVICE" \
      psql -v ON_ERROR_STOP=1 -U "$SUPABASE_DB_USER" -d "$SUPABASE_DB_NAME" -tAc "$1"
  else
    PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
      -h "$SUPABASE_DB_HOST" -p "$SUPABASE_DB_PORT" \
      -U "$SUPABASE_DB_USER" -d "$SUPABASE_DB_NAME" -tAc "$1"
  fi
}

ts_query() {
  if [ "$BACKUP_MODE" = "docker" ]; then
    $COMPOSE exec -T -e PGPASSWORD="$TIMESCALE_DB_PASSWORD" "$TIMESCALE_SERVICE" \
      psql -v ON_ERROR_STOP=1 -U "$TIMESCALE_DB_USER" -d "$TIMESCALE_DB_NAME" -tAc "$1"
  else
    PGPASSWORD="$TIMESCALE_DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
      -h "$TIMESCALE_DB_HOST" -p "$TIMESCALE_DB_PORT" \
      -U "$TIMESCALE_DB_USER" -d "$TIMESCALE_DB_NAME" -tAc "$1"
  fi
}

# --- 1. Supabase first -----------------------------------------------------------------------
restore_db "supabase-db" "$SUPABASE_SERVICE" "$SUPABASE_DB_USER" "$SUPABASE_DB_NAME" \
           "$SUPABASE_DB_HOST" "$SUPABASE_DB_PORT" "$SUPABASE_DB_PASSWORD" "$SUPABASE_FILE"

# --- 2. Then the historian, WRAPPED IN TimescaleDB's RESTORE GUARDS ---------------------------
#
# NOT OPTIONAL, and the reason is not obvious from the dump. TimescaleDB keeps its own catalogue in
# `_timescaledb_catalog`, whose `continuous_agg` table carries CIRCULAR foreign keys -- pg_dump says
# so at dump time. Restoring that catalogue with the extension's background workers live and its
# triggers armed either fails outright or leaves the rollups (migration 0010 defines three) present
# in the catalogue but not refreshing.
#
# `timescaledb_pre_restore()` stops the workers and disarms the triggers; `post_restore()` restores
# them and re-registers the jobs. The setting is applied with ALTER DATABASE, so it persists across
# the separate psql sessions below rather than needing one long connection.
#
# post_restore RUNS EVEN IF THE RESTORE FAILS. Skipping it would leave the database with its
# background workers stopped -- no retention, no compression, no continuous-aggregate refresh -- and
# nothing about the running stack would look wrong until the disk filled.
log "timescaledb: entering pre-restore mode (stops background workers)"
ts_query "SELECT timescaledb_pre_restore()" >/dev/null

restore_rc=0
restore_db "timescaledb" "$TIMESCALE_SERVICE" "$TIMESCALE_DB_USER" "$TIMESCALE_DB_NAME" \
           "$TIMESCALE_DB_HOST" "$TIMESCALE_DB_PORT" "$TIMESCALE_DB_PASSWORD" "$TIMESCALE_FILE" \
           || restore_rc=$?

log "timescaledb: leaving pre-restore mode"
ts_query "SELECT timescaledb_post_restore()" >/dev/null

[ "$restore_rc" -eq 0 ] || die "timescaledb restore failed (exit $restore_rc); background workers have been restarted"

AGGS=$(ts_query "SELECT count(*) FROM timescaledb_information.continuous_aggregates")
log "  ok -- $AGGS continuous aggregate(s) present"

# --- 3. Storage objects ------------------------------------------------------------------------
if [ "$RESTORE_STORAGE" = "true" ] && [ -n "$STORAGE_NAME" ]; then
  log "restoring 3D model objects"
  if [ "$BACKUP_MODE" = "docker" ]; then
    $COMPOSE exec -T "$STORAGE_SERVICE" \
      tar -xzf - -C "$STORAGE_CONTAINER_PATH" < "$BACKUP_DIR/$STORAGE_NAME"
    log "  ok"
  else
    log "  SKIPPED: direct mode cannot reach the volume. Untar $STORAGE_NAME into the storage path."
  fi
elif [ -z "$STORAGE_NAME" ]; then
  log "no storage archive in this backup -- devices.model_3d_path will point at absent objects"
fi

# --- 4. Verify postgres_fdw --------------------------------------------------------------------
# SELECT 1 would prove nothing: it never crosses the wrapper. The query must touch the foreign
# table, and a bounded window keeps postgres_fdw from materialising the whole range (it pushes
# WHERE to the remote but not LIMIT).
log "verifying postgres_fdw reaches the historian"

SRV=$(sb_query "SELECT count(*) FROM pg_foreign_server WHERE srvname = 'timescaledb_server'")
[ "$SRV" = "1" ] || die "foreign server 'timescaledb_server' is missing after restore -- the Supabase dump did not carry it"

sb_query "SELECT count(*) FROM public.telemetry WHERE time > now() - interval '1 hour'" >/dev/null \
  || die "public.telemetry is not queryable through postgres_fdw. Check the historian is up and that TIMESCALE_PORT matches what 0001 registered on the foreign server."

# Through the app-facing role too: a restore that loses grants queries fine as postgres and fails
# for every actual caller.
sb_query "SET ROLE authenticated; SELECT count(*) FROM public.telemetry WHERE time > now() - interval '1 hour'" >/dev/null \
  || die "public.telemetry is unreachable as 'authenticated' -- grants or RLS did not survive the restore"

log "PASS: both databases restored and public.telemetry is queryable through postgres_fdw."
log "Sign in again -- auth.sessions was replaced, so every existing browser session is void."
