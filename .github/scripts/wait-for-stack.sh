#!/usr/bin/env bash
#
# Wait for an installed chart to be genuinely usable, not merely created.
#
# WHY THIS IS A SCRIPT AND NOT TWO `kubectl wait` LINES IN THE WORKFLOW: the restore rehearsal
# installs the chart TWICE and both installs have to reach exactly the same state before the next
# phase touches them. Two copies of this drifting apart would produce a rehearsal that waited
# properly before the backup and not before the restore -- which fails as "the restore did not
# work" rather than as "the stack was not ready".
#
# THE ORDER IS THE ORDER THINGS CAN FAIL IN. Hooks first, because every workload's initContainer is
# waiting on a role the hooks create; then rollouts, so a component left behind names itself here
# rather than surfacing later as an unexplained assertion failure.
#
set -euo pipefail

NS="${NS:-acs-cymru}"
RELEASE="${RELEASE:-acs-cymru}"

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# --- 1. The post-install hooks ------------------------------------------------------------------
#
# db-roles-init sets the passwords for `authenticator`, `supabase_auth_admin` and
# `supabase_storage_admin`, which do not exist until it runs; db-init applies the migration chain;
# storage-init creates the asset-3d-models bucket through the Storage API. Every one of the three
# is a precondition for something the rehearsal asserts.
for job in db-roles-init db-init storage-init; do
  log "waiting for job/$RELEASE-$job"
  if ! kubectl -n "$NS" wait --for=condition=complete "job/$RELEASE-$job" --timeout=10m; then
    echo "::error::$RELEASE-$job did not complete"
    kubectl -n "$NS" logs "job/$RELEASE-$job" --tail=80 || true
    exit 1
  fi
done

# --- 2. Every workload -------------------------------------------------------------------------
#
# Named one at a time: `kubectl rollout status <type>` with no name is an error rather than a sweep,
# and would fail this for a reason unrelated to any workload's health.
for w in $(kubectl -n "$NS" get statefulset,deploy -o name); do
  log "waiting for $w"
  kubectl -n "$NS" rollout status "$w" --timeout=10m
done

# --- 3. Realtime has actually created its role --------------------------------------------------
#
# NOT THE SAME QUESTION AS "IS THE POD READY", and this is the wait that would otherwise be missing.
# `supabase_realtime_admin` is created by the Realtime container during its own boot, and
# restore-databases.sh refuses the whole restore without it. A pod reporting Ready a moment before
# it has run that statement gives a preflight failure several steps later that names roles rather
# than timing, which is a genuinely confusing place to start debugging.
log "waiting for supabase_realtime_admin to exist"
for _ in $(seq 1 60); do
  HAVE=$(kubectl -n "$NS" exec statefulset/supabase-db -- \
           psql -U postgres -d postgres -tAc \
           "SELECT count(*) FROM pg_roles WHERE rolname = 'supabase_realtime_admin'" 2>/dev/null \
         | tr -d ' \r' || true)
  [ "$HAVE" = "1" ] && break
  sleep 5
done
if [ "${HAVE:-0}" != "1" ]; then
  echo "::error::supabase_realtime_admin was never created -- restore-databases.sh will refuse to run"
  kubectl -n "$NS" logs deploy/supabase-realtime --tail=60 || true
  exit 1
fi

log "the stack is ready"
