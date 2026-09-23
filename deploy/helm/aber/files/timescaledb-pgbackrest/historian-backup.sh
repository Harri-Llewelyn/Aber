#!/bin/sh
# The historian's scheduled physical backup: the `pgbackrest` sidecar in the timescaledb pod.
#
# At start: waits for the server and for the maintenance Job's physical_backup.sql, creates the
# stanza (a no-op once it exists), checks that WAL archiving reaches the repository, and takes a
# full backup if the repository holds none. Then once a day at BACKUP_HOUR_UTC: a full backup on
# day BACKUP_FULL_ON (0 = Sunday), a differential otherwise. pgBackRest expires what retention no
# longer needs at the end of each backup.
#
# Every run is recorded in public.physical_backup_runs, which the Historian Backup Stale alert
# reads. A failed run is recorded and the loop carries on to the next day.
#
# One backup now, recorded like a scheduled one, from outside the pod:
#   kubectl exec timescaledb-0 -c pgbackrest -- /bin/sh /opt/aber/historian-backup.sh full
set -u

STANZA=historian
HOUR=${BACKUP_HOUR_UTC:-1}
FULL_ON=${BACKUP_FULL_ON:-0}
SOCKET=/var/run/postgresql
OUT=/tmp/historian-backup.$$

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) historian-backup: $*"; }

psql_run() {
  psql -X -q -At -v ON_ERROR_STOP=1 -h "$SOCKET" -U "${POSTGRES_USER:-postgres}" \
       -d "${POSTGRES_DB:-postgres}" "$@"
}

# record KIND STARTED OK -- the SQL is read from stdin so psql substitutes the variables (it does
# not with -c). The detail is the tail of $OUT for a failure.
record() {
  if [ "$3" = true ]; then detail=''; else detail=$(tail -n 20 "$OUT"); fi
  info=$(pgbackrest --stanza="$STANZA" --output=json info 2>/dev/null) || info='[]'
  psql_run -v kind="$1" -v started="$2" -v ok="$3" -v detail="$detail" -v info="$info" -f - \
      >/dev/null <<'SQL' || log "could not record the $1 run in physical_backup_runs"
SELECT public.physical_backup_record(:'kind', :'started'::timestamptz, :'ok'::boolean,
                                     :'detail', :'info'::jsonb);
SQL
}

# backup TYPE -- one recorded backup; its status is the backup's.
backup() {
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  log "$1 backup starting"
  if pgbackrest --stanza="$STANZA" --type="$1" backup >"$OUT" 2>&1; then ok=true; else ok=false; fi
  cat "$OUT"
  if [ "$ok" = true ]; then log "$1 backup succeeded"; else log "$1 backup FAILED"; fi
  record "$1" "$started" "$ok"
  [ "$ok" = true ]
}

until pg_isready -q -h "$SOCKET"; do sleep 5; done
# The record is created by the maintenance Job, which runs after the server is up on a fresh
# install; a backup taken before it would be missing from the table the alert reads.
until [ "$(psql_run -c "SELECT to_regprocedure('public.physical_backup_record(text, timestamptz, boolean, text, jsonb)') IS NOT NULL" 2>/dev/null)" = t ]; do
  sleep 10
done

case "${1:-}" in
  full|diff|incr) backup "$1"; exit $? ;;
esac

# Stop promptly: the shell is PID 1 and would otherwise ignore SIGTERM for the pod's whole grace
# period while it sleeps.
trap 'log "stopping"; exit 0' TERM INT
log "server is up"

# stanza-create succeeds on a stanza that exists and matches this database. It fails when the
# repository holds a different database's stanza, which needs a person: see the runbook.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if pgbackrest --stanza="$STANZA" stanza-create >"$OUT" 2>&1 \
   && pgbackrest --stanza="$STANZA" check >>"$OUT" 2>&1; then ok=true; else ok=false; fi
cat "$OUT"
if [ "$ok" = true ]; then log "archive check succeeded"; else log "archive check FAILED"; fi
record check "$started" "$ok"

if pgbackrest --stanza="$STANZA" --output=json info 2>/dev/null | grep -q '"backup":\[\]'; then
  log "the repository holds no backup; taking a full one now"
  backup full || true
fi

while :; do
  now=$(date -u +%s)
  next=$(( now - now % 86400 + HOUR * 3600 ))
  [ "$next" -gt "$now" ] || next=$(( next + 86400 ))
  log "next backup at $(date -u -d "@$next" +%Y-%m-%dT%H:%MZ)"
  # In the background and waited on, so the TERM trap runs without waiting out the sleep.
  sleep $(( next - now )) &
  wait $!
  if [ "$(date -u +%w)" = "$FULL_ON" ]; then type=full; else type=diff; fi
  backup "$type" || true
done
