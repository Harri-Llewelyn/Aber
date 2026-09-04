#!/usr/bin/env bash
#
# Drive a backup and restore rehearsal against a Kubernetes cluster.
#
# =================================================================================================
# AN UNTESTED BACKUP IS A BELIEF, NOT A CAPABILITY.
#
# backup-databases.sh ends with that line and this is what acts on it. The risk here is not that
# those scripts are wrong today -- the restore path was rehearsed by hand once (3bc6400) and the
# defects that rehearsal found are the argument for automating it. The risk is that the restore
# path depends on the shape of two databases, the Supabase role set, the pgsodium root key and the
# migration chain, ALL OF WHICH CHANGE. A restore that worked in August fails in November, and
# without this nobody finds out until it is needed.
#
# =================================================================================================
# WHY A SCRIPT AND NOT STEPS IN A WORKFLOW
#
# Port-forwards. Every phase below needs a tunnel to one or both databases, and a tunnel started in
# one workflow step is a background process another step cannot reliably reach. Holding each phase
# in one process makes the tunnel's lifetime a `trap` rather than a hope.
#
# It also means AN OPERATOR CAN REHEARSE BY HAND, against a real cluster, with the same code CI
# runs -- which matters more than the tidiness. A rehearsal only CI can perform is one nobody does
# before a migration they are nervous about.
#
# =================================================================================================
# SUBCOMMANDS, in the order the rehearsal uses them
#
#   seed                  write known data into both databases
#   snapshot <file>       record the counts that must not move
#   backup <dir>          dump both databases and the storage objects into <dir>
#   restore <dir> <stamp> restore that backup into a freshly installed stack
#   assert                everything a count cannot catch
#   compare <a> <b>       diff two snapshots and explain what moved
#
# Environment: NS (namespace, default acs-cymru), and the credentials the chart was installed with.
# The defaults match values-dev.yaml, which is what CI installs.
#
set -euo pipefail

NS="${NS:-acs-cymru}"
FIXTURES="${FIXTURES:-$(cd "$(dirname "$0")/../test-harness/restore-rehearsal" && pwd)}"

# Local ports for the tunnels. Deliberately not 54322/5433: those are what docker-compose publishes,
# and a rehearsal that silently reached a developer's live stack instead of the cluster is the one
# mistake here that would be genuinely expensive.
SB_PORT="${SB_PORT:-54399}"
TS_PORT="${TS_PORT:-54398}"
AUTH_PORT="${AUTH_PORT:-9399}"

SB_USER="${SB_USER:-supabase_admin}"
SB_DB="${SB_DB:-postgres}"
SB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
TS_USER="${TS_USER:-postgres}"
TS_DB="${TS_DB:-postgres}"
TS_PASSWORD="${DB_PASSWORD:-postgres}"
ANON_KEY="${SUPABASE_ANON_KEY:-}"

REHEARSAL_EMAIL="${REHEARSAL_EMAIL:-restore-rehearsal@example.invalid}"
REHEARSAL_PASSWORD="${REHEARSAL_PASSWORD:-rehearsal-Passw0rd!}"
REHEARSAL_OBJECT="${REHEARSAL_OBJECT:-rehearsal-canary.txt}"
REHEARSAL_OBJECT_BODY="${REHEARSAL_OBJECT_BODY:-rehearsal-object-contents}"

log()  { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die()  { printf '::error::%s\n' "$*" >&2; exit 1; }

PF_PIDS=()
cleanup_pf() {
  for pid in "${PF_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  PF_PIDS=()
}
trap cleanup_pf EXIT

# A tunnel, and PROOF IT CARRIES TRAFFIC before returning. `kubectl port-forward` prints
# "Forwarding from ..." immediately and can still fail to connect to the pod behind it, so waiting
# on the process is not waiting on the tunnel.
forward() {
  local svc="$1" local_port="$2" remote_port="$3"
  kubectl -n "$NS" port-forward "svc/$svc" "$local_port:$remote_port" >/tmp/pf-$svc.log 2>&1 &
  PF_PIDS+=("$!")
  local i
  for i in $(seq 1 60); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$local_port") 2>/dev/null; then
      exec 3<&- 3>&-
      return 0
    fi
    sleep 1
  done
  cat "/tmp/pf-$svc.log" >&2 || true
  die "port-forward to svc/$svc never accepted a connection on $local_port"
}

forward_databases() {
  forward supabase-db "$SB_PORT" 5432
  forward timescaledb "$TS_PORT" 5432
}

sb() { PGPASSWORD="$SB_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$SB_PORT" -U "$SB_USER" -d "$SB_DB" "$@"; }
ts() { PGPASSWORD="$TS_PASSWORD" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$TS_PORT" -U "$TS_USER" -d "$TS_DB" "$@"; }

storage_pod() {
  kubectl -n "$NS" get pod \
    -l app.kubernetes.io/component=supabase-storage \
    -o jsonpath='{.items[0].metadata.name}'
}

# =================================================================================================
cmd_seed() {
  forward_databases
  log "seeding the Supabase database"
  sb -q -f "$FIXTURES/seed-supabase.sql"
  log "seeding the historian"
  ts -q -f "$FIXTURES/seed-timescale.sql"

  # An auth user, created THROUGH GoTrue rather than by inserting into auth.users. The point of the
  # post-restore check is that a password set before the backup still works after it, which
  # exercises the JWT secret and GoTrue's own hashing -- a hand-written bcrypt row would test this
  # script's ability to hash rather than the stack's.
  log "creating the rehearsal auth user through GoTrue"
  forward supabase-auth "$AUTH_PORT" 9999
  local code
  code=$(curl -s -o /tmp/signup.json -w '%{http_code}' \
    -X POST "http://127.0.0.1:$AUTH_PORT/signup" \
    -H 'Content-Type: application/json' \
    ${ANON_KEY:+-H "apikey: $ANON_KEY"} \
    -d "{\"email\":\"$REHEARSAL_EMAIL\",\"password\":\"$REHEARSAL_PASSWORD\"}" || true)
  # 422 is "already registered", which is the correct outcome of a second run.
  case "$code" in
    200|201) log "  created" ;;
    422)     log "  already present (re-run)" ;;
    *)       cat /tmp/signup.json >&2 || true; die "GoTrue signup returned $code" ;;
  esac

  # A storage object, written onto the volume the backup archives. Written through the pod's
  # filesystem rather than the Storage API because the API needs a bucket policy and a JWT this
  # script has no business minting -- and what is being rehearsed is that the VOLUME round-trips.
  log "writing the rehearsal storage object"
  local pod
  pod="$(storage_pod)"
  [ -n "$pod" ] || die "no supabase-storage pod found in namespace $NS"
  kubectl -n "$NS" exec "$pod" -- sh -c \
    "mkdir -p /var/lib/storage/rehearsal && printf '%s' '$REHEARSAL_OBJECT_BODY' > /var/lib/storage/rehearsal/$REHEARSAL_OBJECT"
  log "seed complete"
}

# =================================================================================================
cmd_snapshot() {
  local out="${1:?usage: snapshot <file>}"
  forward_databases
  : > "$out"
  sb -tA -f "$FIXTURES/snapshot-supabase.sql" | sed 's/^/supabase:/' >> "$out"
  ts -tA -f "$FIXTURES/snapshot-timescale.sql" | sed 's/^/historian:/' >> "$out"
  # The storage object is part of what must survive, and it lives on a volume rather than in either
  # database -- so it is counted here or nowhere.
  local pod
  pod="$(storage_pod)"
  printf 'storage:objects=%s\n' \
    "$(kubectl -n "$NS" exec "$pod" -- sh -c 'find /var/lib/storage -type f | wc -l' | tr -d ' \r')" >> "$out"
  log "snapshot written to $out"
  cat "$out"
}

# =================================================================================================
cmd_backup() {
  local dir="${1:?usage: backup <dir>}"
  mkdir -p "$dir"
  forward_databases

  # THE STORAGE OBJECTS COME OUT FIRST, and by hand. backup-databases.sh in direct mode refuses to
  # archive storage without STORAGE_HOST_PATH -- correctly, since the objects live on a volume it
  # has no way to reach over a database connection. Copying them to the runner first is what gives
  # it that path, and keeps the artefact identical in shape to the one Compose produces.
  local pod host_copy
  pod="$(storage_pod)"
  host_copy="$dir/.storage-objects"
  rm -rf "$host_copy"; mkdir -p "$host_copy"
  log "copying storage objects out of $pod"
  # A STREAMED TAR RATHER THAN `kubectl cp`, and not for speed. `kubectl cp` of a DIRECTORY differs
  # on whether the directory itself or its contents land at the destination, which decides whether
  # the objects come back at /var/lib/storage/... or at /var/lib/storage/storage/... -- a nesting
  # mistake that restores "successfully" and leaves every model URL dead. `tar -C <dir> .` says
  # which one it means, and it is the same shape backup-databases.sh uses for Compose.
  kubectl -n "$NS" exec "$pod" -- tar -czf - -C /var/lib/storage . | tar -xzf - -C "$host_copy"

  BACKUP_MODE=direct \
  BACKUP_DIR="$dir" \
  SUPABASE_DB_HOST=127.0.0.1 SUPABASE_DB_PORT="$SB_PORT" \
  SUPABASE_DB_USER="$SB_USER" SUPABASE_DB_NAME="$SB_DB" POSTGRES_PASSWORD="$SB_PASSWORD" \
  TIMESCALE_HOST=127.0.0.1 TIMESCALE_PORT="$TS_PORT" \
  DB_USER="$TS_USER" DB_NAME="$TS_DB" DB_PASSWORD="$TS_PASSWORD" \
  STORAGE_HOST_PATH="$host_copy" \
    "$(dirname "$0")/backup-databases.sh"

  rm -rf "$host_copy"
  log "backup complete"
  ls -la "$dir"
}

# =================================================================================================
cmd_restore() {
  local dir="${1:?usage: restore <dir> <stamp>}"
  local stamp="${2:?usage: restore <dir> <stamp>}"
  forward_databases

  ASSUME_YES=true \
  BACKUP_MODE=direct \
  BACKUP_DIR="$dir" BACKUP_STAMP="$stamp" \
  SUPABASE_DB_HOST=127.0.0.1 SUPABASE_DB_PORT="$SB_PORT" \
  SUPABASE_DB_USER="$SB_USER" SUPABASE_DB_NAME="$SB_DB" POSTGRES_PASSWORD="$SB_PASSWORD" \
  TIMESCALE_HOST=127.0.0.1 TIMESCALE_PORT="$TS_PORT" \
  DB_USER="$TS_USER" DB_NAME="$TS_DB" DB_PASSWORD="$TS_PASSWORD" \
    "$(dirname "$0")/restore-databases.sh"

  # THE HALF restore-databases.sh CANNOT DO, and says so: in direct mode it cannot reach the
  # volume, so it logs "SKIPPED" and moves on. Left there, `devices.model_3d_path` would come back
  # pointing at objects that do not exist -- which the AAS exporter cannot detect, because it
  # composes the URL from the key without fetching it.
  local archive pod unpack
  archive="$dir/storage-objects-${stamp}.tar.gz"
  if [ -f "$archive" ]; then
    pod="$(storage_pod)"
    unpack="$dir/.storage-restore"
    rm -rf "$unpack"; mkdir -p "$unpack"
    tar -xzf "$archive" -C "$unpack"
    log "copying storage objects back into $pod"
    # Symmetric with the extraction above, and unambiguous for the same reason.
    tar -czf - -C "$unpack" . | kubectl -n "$NS" exec -i "$pod" -- tar -xzf - -C /var/lib/storage
    rm -rf "$unpack"
  else
    die "no storage archive at $archive -- the backup did not include one"
  fi
  log "restore complete"
}

# =================================================================================================
cmd_assert() {
  forward_databases
  log "asserting the Supabase side"
  sb -f "$FIXTURES/assert-supabase.sql"
  log "asserting the historian"
  ts -f "$FIXTURES/assert-timescale.sql"

  # The storage object, byte for byte. The count in the snapshot says one file came back; this says
  # it is the same file.
  log "asserting the storage object round-tripped"
  local pod body
  pod="$(storage_pod)"
  body=$(kubectl -n "$NS" exec "$pod" -- sh -c "cat /var/lib/storage/rehearsal/$REHEARSAL_OBJECT" 2>/dev/null || true)
  [ "$body" = "$REHEARSAL_OBJECT_BODY" ] \
    || die "the rehearsal storage object did not survive: expected '$REHEARSAL_OBJECT_BODY', got '$body'"

  # SIGN IN WITH THE PASSWORD SET BEFORE THE BACKUP. This is the end-to-end check that GoTrue's
  # schema AND the JWT secret both survived: a restore that lost either returns 400 here while
  # every table in auth looks perfectly populated.
  log "asserting the seeded user can still sign in"
  forward supabase-auth "$AUTH_PORT" 9999
  local code
  code=$(curl -s -o /tmp/signin.json -w '%{http_code}' \
    -X POST "http://127.0.0.1:$AUTH_PORT/token?grant_type=password" \
    -H 'Content-Type: application/json' \
    ${ANON_KEY:+-H "apikey: $ANON_KEY"} \
    -d "{\"email\":\"$REHEARSAL_EMAIL\",\"password\":\"$REHEARSAL_PASSWORD\"}" || true)
  [ "$code" = "200" ] || { cat /tmp/signin.json >&2 || true; die "the seeded user cannot sign in after the restore (HTTP $code) -- GoTrue's schema or the JWT secret did not survive"; }
  grep -q 'access_token' /tmp/signin.json \
    || die "GoTrue answered 200 with no access_token -- the JWT secret did not survive"

  log "PASS: every assertion held after the restore"
}

# =================================================================================================
cmd_compare() {
  local before="${1:?usage: compare <before> <after>}"
  local after="${2:?usage: compare <before> <after>}"
  if diff -u "$before" "$after"; then
    log "PASS: every count is identical either side of the restore"
    return 0
  fi
  die "counts moved across the restore -- the lines above are before(-) and after(+). A count that
DROPPED is data the restore did not bring back. A count that ROSE is the rehearsal's own writes
landing twice, which means the namespace was not actually destroyed between the two installs."
}

# =================================================================================================
case "${1:-}" in
  seed)     shift; cmd_seed "$@" ;;
  snapshot) shift; cmd_snapshot "$@" ;;
  backup)   shift; cmd_backup "$@" ;;
  restore)  shift; cmd_restore "$@" ;;
  assert)   shift; cmd_assert "$@" ;;
  compare)  shift; cmd_compare "$@" ;;
  *) die "usage: $0 {seed|snapshot <file>|backup <dir>|restore <dir> <stamp>|assert|compare <a> <b>}" ;;
esac
