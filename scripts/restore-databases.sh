#!/usr/bin/env bash
#
# Tier 1 restore, in the one order that works.
#
# ORDER IS LOAD BEARING:
#
#   1. supabase-db   -- carries `public.telemetry`, which is a FOREIGN TABLE over the historian.
#                       Its foreign server, user mapping and RLS policies come back with it.
#   2. timescaledb   -- the hypertable the foreign table points at.
#                       A manifest reading timescaledb=physical has no dump: the historian was
#                       backed up by pgBackRest, and is restored with scripts/restore-historian.mjs
#                       BEFORE this script, so step 3 finds it.
#   3. verify        -- query `public.telemetry` THROUGH the wrapper. Neither restore proves the
#                       join works, and a broken wrapper surfaces as a relation-level PostgREST
#                       error that reads as a schema fault.
#
# ROLES MUST EXIST FIRST -- all nine. A dump keeps ownership, its RLS policies reference roles BY
# NAME, and it contains no CREATE ROLE. The preflight below refuses rather than failing several
# hundred statements in; see it for which roles come from where. Do not "fix" this with --no-owner.
#
# RESTORE INTO A FRESHLY INITIALISED DATABASE. --clean lets the dump replace the auth and storage
# schemas the image ships. What it cannot drop is a partition's inherited primary key, and a fresh
# stack always has partitions (Realtime's daily ones, digital_thread's monthly ones); the
# preflight below drops every partition first.
#
# Full runbook:  supabase/README.md -> "Backup and Recovery"
#
set -eu

# See the note in backup-databases.sh: Git Bash rewrites arguments that look like paths unless
# this is set. A no-op on Linux and macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_STAMP="${BACKUP_STAMP:-}"

SUPABASE_SERVICE="${SUPABASE_SERVICE:-supabase-db}"
# supabase_admin, NOT postgres -- see the note in backup-databases.sh. `postgres` is not a superuser
# in the supabase/postgres image and cannot drop the supabase_admin-owned event triggers that a
# --clean restore replaces.
SUPABASE_DB_USER="${SUPABASE_DB_USER:-supabase_admin}"
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
TIMESCALE_NAME=$(sed -n 's/^timescaledb=//p' "$MANIFEST")
TIMESCALE_FILE="$BACKUP_DIR/$TIMESCALE_NAME"
STORAGE_NAME=$(sed -n 's/^storage=//p' "$MANIFEST")

[ -f "$SUPABASE_FILE" ]  || die "missing $SUPABASE_FILE"
if [ "$TIMESCALE_NAME" = physical ]; then
  TIMESCALE_FILE="<pgBackRest; restore it first with scripts/restore-historian.mjs>"
else
  [ -f "$TIMESCALE_FILE" ] || die "missing $TIMESCALE_FILE"
fi

cat <<EOF

  RESTORE $BACKUP_STAMP  (format=$FORMAT)

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
    PGPASSWORD="$pw" pg_restore -h "$host" -p "$port" -U "$user" -d "$db" \
      --clean --if-exists "$file" || rc=$?
  else
    gunzip -c "$file" | PGPASSWORD="$pw" psql -v ON_ERROR_STOP=1 \
      -h "$host" -p "$port" -U "$user" -d "$db" || rc=$?
  fi

  [ "$rc" -eq 0 ] || return "$rc"
  log "  ok"
}

sb_query() {
  PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
    -h "$SUPABASE_DB_HOST" -p "$SUPABASE_DB_PORT" \
    -U "$SUPABASE_DB_USER" -d "$SUPABASE_DB_NAME" -tAc "$1"
}

ts_query() {
  PGPASSWORD="$TIMESCALE_DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
    -h "$TIMESCALE_DB_HOST" -p "$TIMESCALE_DB_PORT" \
    -U "$TIMESCALE_DB_USER" -d "$TIMESCALE_DB_NAME" -tAc "$1"
}

# --- 0. Preflight: the roles the dump grants to must already exist -----------------------------
#
# A dump carries ownership and GRANTs but NO `CREATE ROLE` -- `grep -c '^CREATE ROLE'` on a dump of
# this stack is 0. Every role it references has to be there first, and they arrive from three
# different places:
#
#   * the supabase/postgres image     anon, authenticated, authenticator, service_role,
#                                     supabase_admin, supabase_auth_admin, supabase_storage_admin
#   * THE REALTIME CONTAINER, at boot supabase_realtime_admin
#   * the pg_net extension's setup    supabase_functions_admin
#
# THE LAST TWO ARE BOTH TRAPS, and together they are why "restore into a stack that has booted
# once" means the WHOLE stack, not just the database:
#
#   * Nothing in this repository creates supabase_realtime_admin -- supabase-realtime does, on its
#     first start.
#   * supabase_functions_admin LOOKS like it is created by the dump: there is a guarded
#     `CREATE USER supabase_functions_admin` in it. That statement is inside an event-trigger
#     function BODY, which a restore only defines and never executes, so the role is not created --
#     but a plain `GRANT USAGE ON SCHEMA net TO supabase_functions_admin` several thousand lines
#     later is executed, and fails.
#
# Either one kills a restore several hundred statements in. Checking first turns that into a
# refusal that names them.
#
# MUST RUN AFTER sb_query IS DEFINED. Shell resolves functions at call time, so a preflight placed
# above the definitions silently reports every role as missing.
REQUIRED_ROLES="${REQUIRED_ROLES:-anon authenticated authenticator service_role supabase_admin supabase_auth_admin supabase_storage_admin supabase_realtime_admin supabase_functions_admin}"

log "preflight: required roles"
missing=""
for role in $REQUIRED_ROLES; do
  have=$(sb_query "SELECT count(*) FROM pg_roles WHERE rolname = '$role'" | tr -d '\r\n ')
  [ "$have" = "1" ] || missing="$missing $role"
done
[ -z "$missing" ] || die "these roles do not exist in the target database:$missing

A dump contains no CREATE ROLE, so they must pre-exist. Restore into a stack that has FULLY booted
at least once -- supabase_realtime_admin is created by the supabase-realtime container, not by any
migration. Do NOT work around this with --no-owner: RLS policies reference roles by name, and a
dump stripped of ownership restores into a database where every policy denies."
log "  ok -- all $(echo "$REQUIRED_ROLES" | wc -w | tr -d ' ') present"

# --- 0b. Every partition of every partitioned table ------------------------------------------------
#
# A partition's primary key is inherited from its parent and cannot be dropped on its own, and
# `--clean` tries to, before any DROP TABLE:
#
#     ERROR:  cannot drop inherited constraint "messages_2026_09_24_pkey" of relation "messages_2026_09_24"
#     ERROR:  cannot drop inherited constraint "digital_thread_default_pkey" of relation "digital_thread_default"
#
# A freshly installed stack always holds partitions with the dump's names: Realtime creates its
# daily realtime.messages_* on every start, and 0001 creates digital_thread's monthly partitions
# and its DEFAULT. So every partition of every partitioned table is dropped first; the dump
# recreates each with its rows. CASCADE, because a view may read a partition by name
# (digital_thread_partition_health does), and the dump recreates the view too. Found by the first
# rehearsal to reach this step (docs/incidents.md, "The restore path never met a partitioned
# table").
log "preflight: dropping every partition the dump will recreate"
sb_query "DO \$\$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS p
             FROM pg_inherits i
             JOIN pg_class c ON c.oid = i.inhrelid
             JOIN pg_class parent ON parent.oid = i.inhparent
            WHERE parent.relkind = 'p'
            ORDER BY c.relkind = 'p' DESC
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %s CASCADE', r.p);
  END LOOP;
END \$\$" >/dev/null
log "  ok"

# --- 0c. Default privileges, suspended for the replay --------------------------------------------
#
# The supabase/postgres image declares default privileges: every table, sequence and function
# created in `public` by supabase_admin or postgres is granted ALL to anon, authenticated and
# service_role at creation. A dump's GRANT and REVOKE statements are a diff from PostgreSQL's
# built-in default, not from those, so a replay creates each object with the surplus and then
# grants what the source had on top of it: service_role could UPDATE digital_thread after a
# restore, and anon could execute every function 0101 revoked from PostgREST roles. Every default
# ACL is revoked here for every grantee but its owner and PUBLIC; the dump's own
# ALTER DEFAULT PRIVILEGES statements, which pg_dump writes after every object and grant,
# put them back. Found by the first rehearsal to reach the assertions (docs/incidents.md,
# "The restored schema was more permissive than the dumped one").
log "preflight: suspending default privileges, which the dump re-declares last"
sb_query "DO \$\$ DECLARE r record; BEGIN
  FOR r IN SELECT d.defaclrole::regrole AS owner, n.nspname AS schema, d.defaclobjtype AS kind,
                  a.grantee::regrole AS grantee
             FROM pg_default_acl d
             LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
                  LATERAL aclexplode(d.defaclacl) a
            WHERE a.grantee <> 0 AND a.grantee <> d.defaclrole
            GROUP BY 1, 2, 3, 4
  LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %s %s REVOKE ALL ON %s FROM %s',
      r.owner,
      CASE WHEN r.schema IS NULL THEN '' ELSE format('IN SCHEMA %I', r.schema) END,
      CASE r.kind WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS'
                  WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END,
      r.grantee);
  END LOOP;
END \$\$" >/dev/null
log "  ok"

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
if [ "$TIMESCALE_NAME" = physical ]; then
  log "timescaledb: backed up by pgBackRest, so not restored here (scripts/restore-historian.mjs)"
else
  log "timescaledb: entering pre-restore mode (stops background workers)"
  ts_query "SELECT timescaledb_pre_restore()" >/dev/null

  restore_rc=0
  restore_db "timescaledb" "$TIMESCALE_SERVICE" "$TIMESCALE_DB_USER" "$TIMESCALE_DB_NAME" \
             "$TIMESCALE_DB_HOST" "$TIMESCALE_DB_PORT" "$TIMESCALE_DB_PASSWORD" "$TIMESCALE_FILE" \
             || restore_rc=$?

  log "timescaledb: leaving pre-restore mode"
  ts_query "SELECT timescaledb_post_restore()" >/dev/null

  [ "$restore_rc" -eq 0 ] || die "timescaledb restore failed (exit $restore_rc); background workers have been restarted"
fi

AGGS=$(ts_query "SELECT count(*) FROM timescaledb_information.continuous_aggregates")
log "  ok -- $AGGS continuous aggregate(s) present"

# --- 3. Storage objects ------------------------------------------------------------------------
if [ "$RESTORE_STORAGE" = "true" ] && [ -n "$STORAGE_NAME" ]; then
  log "restoring 3D model objects"
  log "  SKIPPED: this script cannot reach the volume. Untar $STORAGE_NAME into the storage path."
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

# --- 5. Verify Vault decrypts ------------------------------------------------------------------
# Every row present and none readable is what a root key other than the dump's looks like. The
# key is on the data volume, not in the dump; the backup service carries it as vault-key-<stamp>,
# and it goes onto the target's volume, with a server restart, BEFORE this script runs.
log "verifying Vault decrypts under this server's pgsodium root key"
sb_query "SELECT count(decrypted_secret) FROM vault.decrypted_secrets" >/dev/null \
  || die "vault.decrypted_secrets cannot be read: this server's pgsodium root key is not the one the dump was encrypted under. Put the backup's vault-key file at /var/lib/postgresql/data/pgsodium_root.key, restart the server, and restore again (supabase/README.md, Backup and Recovery)."

log "PASS: both databases restored and public.telemetry is queryable through postgres_fdw."
log "Sign in again -- auth.sessions was replaced, so every existing browser session is void."
