#!/bin/sh
# The historian's scheduled physical backup: the `pgbackrest` sidecar in the timescaledb pod.
#
# At start: waits for the server and for the maintenance Job's physical_backup.sql, creates the
# stanza (a no-op once it exists), checks that WAL archiving reaches the repository, and takes a
# full backup if the repository holds none. Then, once a minute, asks physical_backup_missed_slot()
# whether the day's BACKUP_HOUR_UTC slot has passed with no backup attempted since, and if so takes
# one: the type physical_backup_type() names (full on BACKUP_FULL_ON, 0 = Sunday, or when the
# newest full is over seven days old; a differential otherwise). A restart, a suspended host and a
# missed hour all meet the same rule, so a missed slot is taken late, once. The same step takes a
# differential when the Backups page has asked for one (physical_backup_requests). pgBackRest
# expires what retention no longer needs at the end of each backup.
#
# Every run is recorded in public.physical_backup_runs, which the Historian Backup Stale alert
# reads. A failed run is recorded and counts as the slot's attempt.
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

# The slot to take now as "EPOCH|YYYY-MM-DD HH:MM", or nothing when none is due.
due_slot() {
  psql_run -v hour="$HOUR" -f - <<'SQL'
SELECT extract(epoch FROM s)::bigint || '|' || to_char(s AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')
  FROM public.physical_backup_missed_slot(:'hour'::integer) s WHERE s IS NOT NULL;
SQL
}

# slot_type EPOCH -- full or diff for that slot, from the repository's newest full.
slot_type() {
  info=$(pgbackrest --stanza="$STANZA" --output=json info 2>/dev/null) || info='[]'
  psql_run -v full_on="$FULL_ON" -v slot="$1" -v info="$info" -f - <<'SQL'
SELECT public.physical_backup_type(:'full_on'::integer, to_timestamp(:'slot'::bigint), :'info'::jsonb);
SQL
}

# The id of a backup the Backups page asked for, now claimed, or nothing.
claim_request() {
  psql_run -c 'SELECT public.physical_backup_claim_request()'
}

next_slot() {
  now=$(date -u +%s)
  next=$(( now - now % 86400 + HOUR * 3600 ))
  [ "$next" -gt "$now" ] || next=$(( next + 86400 ))
  log "next backup at $(date -u -d "@$next" +%Y-%m-%dT%H:%MZ)"
}

until pg_isready -q -h "$SOCKET"; do sleep 5; done
# The functions are created by the maintenance Job, which runs after the server is up on a fresh
# install and after this container restarts on an upgrade; a backup taken before them would be
# missing from the table the alert reads. Waits for the newest one this script calls.
until [ "$(psql_run -c "SELECT to_regprocedure('public.physical_backup_claim_request()') IS NOT NULL" 2>/dev/null)" = t ]; do
  sleep 10
done

case "${1:-}" in
  full|diff|incr) backup "$1"; exit $? ;;
esac

# Stop promptly: the shell is PID 1 and would otherwise ignore SIGTERM for the pod's whole grace
# period while it sleeps.
trap 'log "stopping"; exit 0' TERM INT
log "server is up"
# What the Backups page reads to say when the next backup is due.
psql_run -v hour="$HOUR" -v full_on="$FULL_ON" -f - >/dev/null <<'SQL' || log "could not record the schedule"
SELECT public.physical_backup_record_schedule(:'hour'::integer, :'full_on'::integer);
SQL

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

# The last slot this process attempted, so a run that could not be recorded is not repeated.
last=''
announced=''
failing=''
while :; do
  if slot=$(due_slot 2>"$OUT.err"); then
    failing=''
  else
    [ -n "$failing" ] || log "could not ask whether a backup is due: $(tail -n 1 "$OUT.err")"
    failing=1
    slot=''
  fi
  request=$(claim_request 2>/dev/null) || request=''
  if [ -n "$slot" ] && [ "$slot" != "$last" ]; then
    last=$slot
    at=${slot%%|*}
    type=$(slot_type "$at" 2>/dev/null) || type=''
    [ -n "$type" ] || type=diff
    # Up to a few minutes late is this loop's step; beyond that the slot was missed.
    if [ $(( $(date -u +%s) - at )) -gt 300 ]; then
      log "missed the ${slot#*|} UTC backup; taking it now ($type)"
    fi
    [ -z "$request" ] || log "this backup also answers the one asked for on the Backups page"
    backup "$type" || true
    announced=''
  elif [ -n "$request" ]; then
    log "a backup was asked for on the Backups page; taking a differential now"
    backup diff || true
    announced=''
  elif [ -z "$announced" ]; then
    next_slot
    announced=1
  fi
  # In the background and waited on, so the TERM trap runs without waiting out the sleep.
  sleep 60 &
  wait $!
done
