#!/usr/bin/env bash
#
# Tier 1 logical backup: both databases plus the storage objects of every bucket.
#
# Runs against any reachable PostgreSQL: the two databases through `npm run dev:forward` or a
# port-forward of your own, an edge appliance, or a CI job. The in-cluster equivalent is the backup
# service (`backupService.enabled=true`), which writes the same artefacts from the Backups page.
#
# WHAT THIS DOES NOT DO. It is a logical dump, not PITR: recovery is to the last run and no finer.
# It also does not capture roles -- `supabase_auth_admin`, `authenticator` and
# `supabase_storage_admin` are recreated by db-roles-init, which must have run before a restore.
#
# NOR DOES IT CAPTURE THE LOG STORE, which is a decision and is recorded so that its absence from
# this list reads as one. `loki_data` holds thirty days of container logs and is not a database of
# record: the durable half of everything that matters is already in the dump as rows --
# audit_trail, which is the audit trail and the conformance record both, and platform_alerts --
# while the logs are the volatile half, there to be queried during an incident rather than
# restored after one. See the Loki values in the chart for the full argument.
#
# Full runbook, including the two-tier strategy this is tier 1 of:
#   supabase/README.md -> "Backup and Recovery"
#
set -eu

# GIT BASH REWRITES ARGUMENTS THAT LOOK LIKE PATHS. Without this, `-C /var/lib/storage` becomes
# `C:/Program Files/Git/var/lib/storage` and tar fails with "can't change directory". A no-op on
# Linux and macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# -------------------------------------------------------------------------------------------------
# Configuration. Every value is env-overridable; the defaults are the dev loop's port-forwards.
# -------------------------------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# plain -> .sql.gz, restorable with psql and greppable.
# custom -> .dump (pg_dump -Fc), restorable SELECTIVELY with pg_restore. This is what the chart's
#           CronJob and the backup service write, so use it when a by-hand backup has to be
#           restorable by the same runbook.
BACKUP_FORMAT="${BACKUP_FORMAT:-plain}"

# supabase_admin, NOT postgres. `postgres` is not a superuser in the supabase/postgres image, and
# the six event triggers (pgrst_ddl_watch, pgrst_drop_watch, issue_pg_cron_access, ...) are owned by
# supabase_admin. A restore connected as postgres dies on the first of them with
# `must be owner of event trigger pgrst_drop_watch`, so the dump is taken as the role that can
# also replay it.
SUPABASE_DB_USER="${SUPABASE_DB_USER:-supabase_admin}"
SUPABASE_DB_NAME="${SUPABASE_DB_NAME:-postgres}"
SUPABASE_DB_HOST="${SUPABASE_DB_HOST:-localhost}"
SUPABASE_DB_PORT="${SUPABASE_DB_PORT:-54322}"
SUPABASE_DB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"

# false where pgBackRest backs the historian up (timescaledb.physicalBackup): the manifest records
# timescaledb=physical and restore-databases.sh leaves the historian to scripts/restore-historian.mjs.
DUMP_TIMESCALE="${DUMP_TIMESCALE:-true}"
TIMESCALE_DB_USER="${DB_USER:-postgres}"
TIMESCALE_DB_NAME="${DB_NAME:-postgres}"
TIMESCALE_DB_HOST="${TIMESCALE_HOST:-localhost}"
TIMESCALE_DB_PORT="${TIMESCALE_PORT:-5433}"
TIMESCALE_DB_PASSWORD="${DB_PASSWORD:-postgres}"

# The storage volume's directory on this host, which is tarred. The objects live on a volume, not
# in a database, so while INCLUDE_STORAGE is true the run does not start without it.
STORAGE_HOST_PATH="${STORAGE_HOST_PATH:-}"
INCLUDE_STORAGE="${INCLUDE_STORAGE:-true}"


# A dump smaller than this is treated as a failure. pg_dump exits non-zero on a mid-flight error,
# but an empty database, a wrong -d, or a container that died mid-write can all produce a
# well-formed short file -- and a backup that is silently empty is worse than one that failed.
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-2048}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log()  { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --clean --if-exists ON THE PLAIN FORMAT IS NOT OPTIONAL, and a restore rehearsal is the only way
# to find that out. A plain dump is replayed by psql, which simply executes what it is given -- so
# without DROP guards the very first statement to touch an object the target already has fails:
#
#     ERROR:  schema "auth" already exists
#
# and the real target ALWAYS has that object, because `auth`, `storage` and the Supabase roles ship
# in the supabase/postgres image. The custom format never showed this because its restore path is
# `pg_restore --clean --if-exists`, which carries the same behaviour as a flag at restore time.
case "$BACKUP_FORMAT" in
  plain)  DUMP_EXT="sql.gz"; DUMP_ARGS="-Fp -Z6 --clean --if-exists" ;;
  custom) DUMP_EXT="dump";   DUMP_ARGS="-Fc" ;;
  *) die "BACKUP_FORMAT must be 'plain' or 'custom', got '$BACKUP_FORMAT'" ;;
esac

# -------------------------------------------------------------------------------------------------
# EVERY PRECONDITION IS CHECKED BEFORE THE FIRST DUMP. restore-databases.sh finds a backup through
# its manifest, which is written last, so a run that stops part way leaves dumps no restore can
# use. A run either writes a complete backup or stops having written nothing.
# -------------------------------------------------------------------------------------------------
for setting in INCLUDE_STORAGE DUMP_TIMESCALE; do
  case "${!setting}" in
    true|false) ;;
    *) die "$setting must be 'true' or 'false', got '${!setting}'" ;;
  esac
done
# Bounded, because `[ -gt ]` errors on a number past bash's integer range, and inside an `if` that
# error reads as false.
[[ "$MIN_DUMP_BYTES" =~ ^[0-9]{1,18}$ ]] \
  || die "MIN_DUMP_BYTES must be a whole number of at most 18 digits, got '$MIN_DUMP_BYTES'"
[[ "$BACKUP_RETENTION_DAYS" =~ ^-?[0-9]{1,5}$ ]] \
  || die "BACKUP_RETENTION_DAYS must be a whole number of at most 5 digits (0 disables pruning), got '$BACKUP_RETENTION_DAYS'"

if [ "$INCLUDE_STORAGE" = "true" ]; then
  FIXES="Nothing was written. Name the storage volume's directory on this host, or leave the objects out:
  STORAGE_HOST_PATH=<path> $0
  INCLUDE_STORAGE=false $0"
  [ -n "$STORAGE_HOST_PATH" ] \
    || die "INCLUDE_STORAGE is true and STORAGE_HOST_PATH is empty, so the storage objects cannot be archived. $FIXES"
  [ -d "$STORAGE_HOST_PATH" ] && [ -r "$STORAGE_HOST_PATH" ] \
    || die "STORAGE_HOST_PATH '$STORAGE_HOST_PATH' is not a readable directory. $FIXES"
fi

TOOLS="pg_dump"
if [ "$INCLUDE_STORAGE" = "true" ]; then TOOLS="$TOOLS tar gzip"; fi
for tool in $TOOLS; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH. Nothing was written."
done

mkdir -p "$BACKUP_DIR" || die "cannot create BACKUP_DIR '$BACKUP_DIR'"
[ -w "$BACKUP_DIR" ] || die "BACKUP_DIR '$BACKUP_DIR' is not writable. Nothing was written."

# -------------------------------------------------------------------------------------------------
# NO PIPE INTO gzip, DELIBERATELY. `pg_dump | gzip` reports gzip's exit status, so a pg_dump that
# dies half way produces a valid .gz holding half a database and a zero exit code. pg_dump's own
# -Z does the compression, so the process that can fail is also the process whose status is read.
# -------------------------------------------------------------------------------------------------
dump_db() {
  name="$1"; user="$2"; db="$3"; host="$4"; port="$5"; pw="$6"
  out="$BACKUP_DIR/${name}-${STAMP}.${DUMP_EXT}"

  log "dumping $name -> $out"
  # shellcheck disable=SC2086
  PGPASSWORD="$pw" pg_dump $DUMP_ARGS -h "$host" -p "$port" -U "$user" -d "$db" -f "$out"

  size=$(wc -c < "$out" | tr -d ' ')
  [ "$size" -ge "$MIN_DUMP_BYTES" ] || die "$out is only ${size} bytes -- refusing to record a short dump as a backup"
  log "  ok ${size} bytes"
}

dump_storage() {
  out="$BACKUP_DIR/storage-objects-${STAMP}.tar.gz"
  log "archiving the storage objects (every bucket) -> $out"
  tar -czf "$out" -C "$STORAGE_HOST_PATH" .
  log "  ok $(wc -c < "$out" | tr -d ' ') bytes"
}

# -------------------------------------------------------------------------------------------------
log "backup $STAMP  (format=$BACKUP_FORMAT dir=$BACKUP_DIR)"

# A run that fails from here on (a database unreachable, a short dump, an unreadable object, an
# interrupt) removes what it wrote: a dump without its manifest is one no restore can find.
discard_partial() {
  status=$?
  [ "$status" -ne 0 ] || return 0
  rm -f "$BACKUP_DIR"/*-"$STAMP".*
  printf 'Removed the files this run wrote: a backup without its manifest cannot be restored.\n' >&2
}
trap discard_partial EXIT
# A signal ends the run through `exit`: after an untrapped one, bash runs the EXIT trap with $? 0.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

dump_db "supabase-db" "$SUPABASE_DB_USER" "$SUPABASE_DB_NAME" \
        "$SUPABASE_DB_HOST" "$SUPABASE_DB_PORT" "$SUPABASE_DB_PASSWORD"

if [ "$DUMP_TIMESCALE" = "true" ]; then
  dump_db "timescaledb" "$TIMESCALE_DB_USER" "$TIMESCALE_DB_NAME" \
          "$TIMESCALE_DB_HOST" "$TIMESCALE_DB_PORT" "$TIMESCALE_DB_PASSWORD"
else
  log "skipping the historian (DUMP_TIMESCALE=false): pgBackRest backs it up"
fi

if [ "$INCLUDE_STORAGE" = "true" ]; then
  dump_storage
else
  log "skipping storage objects (INCLUDE_STORAGE=false)"
  log "  NOTE: devices.model_3d_path is dumped but the objects it points at are not -- an AAS"
  log "        export will emit a File element with a dead URL, and nothing detects it."
fi

# A manifest, so a restore does not have to infer which files belong together from their names.
MANIFEST="$BACKUP_DIR/manifest-${STAMP}.txt"
{
  echo "stamp=$STAMP"
  echo "format=$BACKUP_FORMAT"
  echo "supabase_db=supabase-db-${STAMP}.${DUMP_EXT}"
  if [ "$DUMP_TIMESCALE" = "true" ]; then echo "timescaledb=timescaledb-${STAMP}.${DUMP_EXT}"; else echo "timescaledb=physical"; fi
  [ "$INCLUDE_STORAGE" = "true" ] && echo "storage=storage-objects-${STAMP}.tar.gz"
  echo "created_by=scripts/backup-databases.sh"
} > "$MANIFEST"
# The backup is complete once its manifest exists, so nothing after this may discard it.
trap - EXIT

if [ "$BACKUP_RETENTION_DAYS" -gt 0 ]; then
  log "pruning artefacts older than ${BACKUP_RETENTION_DAYS} days"
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name '*.sql.gz' -o -name '*.dump' -o -name '*.tar.gz' -o -name 'manifest-*.txt' \) \
    -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete || true
fi

log "done. Restore with:  BACKUP_STAMP=$STAMP scripts/restore-databases.sh"
log "An untested backup is a belief, not a capability -- rehearse the restore."
