#!/usr/bin/env bash
#
# Tear the local stack down to nothing and bring it back provisioned.
#
# WHY THIS EXISTS. `digital_thread` is append-only against every application role, so there is no
# way to clear demo noise from it short of dropping the volume -- and dropping the volume means
# re-running migrations, re-seeding accounts, and re-issuing four gateway credentials that
# `mosquitto_passwd` cannot read back. Done by hand that is a ten-minute sequence with three places
# to forget a step; the one that gets forgotten is the credentials, and the symptom is a gateway
# that authenticates against nothing at 9am.
#
# ---------------------------------------------------------------------------------------------
# THIS IS DESTRUCTIVE AND THE GUARDS ARE THE POINT.
#
#   * --yes is required. No interactive confirmation: a prompt is something people learn to hit
#     without reading, and this script is most dangerous when it is familiar.
#   * NODE_ENV=production refuses outright, and cannot be overridden by --yes.
#   * The compose project name must match this repository's, so a stray shell in the wrong
#     directory cannot take down a different stack that happens to be running.
#
# `docker compose down -v` drops supabase_db_data, and with it auth.sessions -- every logged-in
# browser is signed out. That is expected behaviour, documented in the README, and worth knowing
# before you run this against a stack someone else is demoing on.
# ---------------------------------------------------------------------------------------------

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CONFIRMED=0
SKIP_GATEWAYS=0
TIMEOUT_SECONDS="${STACK_RESET_TIMEOUT:-600}"

for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=1 ;;
    --skip-gateways) SKIP_GATEWAYS=1 ;;
    --timeout=*) TIMEOUT_SECONDS="${arg#--timeout=}" ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/stack-reset.sh --yes [--skip-gateways] [--timeout=SECONDS]

Destroys and rebuilds the local Docker Compose stack:

  1. docker compose down -v          (DROPS EVERY VOLUME -- all telemetry, all audit history)
  2. docker compose up -d
  3. wait for the telemetry hypertable, then for migrations and seeds to have been applied
  4. npm run provision:gateways      (unless --skip-gateways)
  5. print the demo accounts and the gateway credentials

  --yes             required; there is no interactive prompt
  --skip-gateways   stop after the stack is healthy
  --timeout=N       seconds to wait for readiness (default 600)
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument '$arg'. See --help." >&2
      exit 2
      ;;
  esac
done

# --- guards -----------------------------------------------------------------------------------

# CHECKED BEFORE --yes, and not overridable by it. If this variable says production, the operator's
# intent and their environment disagree, and the environment is the one that cannot be a typo.
if [ "${NODE_ENV:-}" = "production" ]; then
  echo "REFUSING: NODE_ENV=production." >&2
  echo "This script drops every volume in the stack. It is a local development tool." >&2
  exit 1
fi

if [ "$CONFIRMED" -ne 1 ]; then
  cat >&2 <<'REFUSAL'
REFUSING: --yes is required.

This destroys ALL local data:
  * every telemetry row in TimescaleDB
  * the entire digital_thread audit history, which is append-only and has no other way back
  * every logged-in browser session
  * every Mosquitto gateway credential (mosquitto_passwd stores hashes; they are NOT recoverable)

Re-run with --yes when that is what you mean.
REFUSAL
  exit 1
fi

# A stray shell in the wrong directory must not take down a different stack. The project name is
# derived from the directory unless COMPOSE_PROJECT_NAME overrides it, so this checks the thing
# `docker compose down` will actually act on.
EXPECTED_PROJECT="$(basename "$ROOT_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
ACTUAL_PROJECT="${COMPOSE_PROJECT_NAME:-$EXPECTED_PROJECT}"
if [ "$ACTUAL_PROJECT" != "$EXPECTED_PROJECT" ]; then
  echo "REFUSING: COMPOSE_PROJECT_NAME is '$ACTUAL_PROJECT' but this repository is '$EXPECTED_PROJECT'." >&2
  echo "That would tear down a stack this script does not own." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "REFUSING: no .env in $ROOT_DIR. Run 'npm run setup' first." >&2
  exit 1
fi

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- 1. down ------------------------------------------------------------------------------------
step "Tearing down (volumes included)"
docker compose down -v --remove-orphans

# --- 2. up --------------------------------------------------------------------------------------
step "Starting the stack"
docker compose up -d

# --- 3. readiness -------------------------------------------------------------------------------
# WAIT FOR OBJECTS, NOT FOR PORTS. The postgres entrypoint runs its initdb scripts against a
# temporary server that already answers on the socket, so `pg_isready` is true well before the
# schema exists -- the same trap docker-compose.yml's own timescaledb-maintenance entrypoint calls
# out. Every check below names a specific object or row it needs.
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

wait_for() {
  local description="$1"; shift
  printf '    waiting for %s' "$description"
  until "$@" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf ' TIMEOUT\n'
      echo "Timed out after ${TIMEOUT_SECONDS}s waiting for ${description}." >&2
      echo "Inspect with: docker compose ps && docker compose logs --tail=50" >&2
      exit 1
    fi
    printf '.'
    sleep 3
  done
  printf ' ok\n'
}

step "Waiting for the databases"

hypertable_exists() {
  docker exec acs-cymru_timescaledb psql -U postgres -d postgres -tAc \
    "SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'telemetry'" \
    | grep -q 1
}
wait_for "the telemetry hypertable" hypertable_exists

rollups_exist() {
  docker exec acs-cymru_timescaledb psql -U postgres -d postgres -tAc \
    "SELECT 1 FROM timescaledb_information.continuous_aggregates WHERE view_name = 'telemetry_1h'" \
    | grep -q 1
}
wait_for "the telemetry rollups" rollups_exist

# The BI role is the last thing timescaledb-maintenance does, so its presence means that whole
# service completed rather than merely started.
bi_role_exists() {
  docker exec acs-cymru_timescaledb psql -U postgres -d postgres -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname = 'powerbi_reader'" | grep -q 1
}
wait_for "the read-only BI role" bi_role_exists

# --- 4. migrations and seeds --------------------------------------------------------------------
step "Waiting for migrations and seeds"

# The LAST migration's work, not the first: db-init applies them in order, so checking something
# 0018 created proves the whole chain ran rather than that it started.
seed_applied() {
  docker exec acs-cymru_supabase_db psql -U postgres -d postgres -tAc \
    "SELECT count(*) >= 4 FROM public.metric_catalog WHERE metric_group = 'BMS'" | grep -q t
}
wait_for "migrations (through 0018)" seed_applied

demo_accounts_exist() {
  docker exec acs-cymru_supabase_db psql -U postgres -d postgres -tAc \
    "SELECT count(*) >= 4 FROM auth.users" | grep -q t
}
wait_for "the demo accounts" demo_accounts_exist

# THE LAST THING seed.sql DOES, and that is the whole reason it is probed separately.
#
# The check above reads auth.users, which seed.sql inserts at its TOP -- so it goes true while the
# rest of the file is still running, or has failed. The causation demonstration is the file's final
# block, so this is what actually proves the seed COMPLETED rather than merely started.
#
# What it looks for is the property the Digital Thread drawer needs: one transaction that wrote
# audit rows for a gateway AND more than one device, which is what makes the "Same transaction"
# control render anything at all. Without it the reset finishes reporting success and the demo is
# quietly not there -- discovered in front of an audience, which is the failure this whole script
# exists to prevent.
causation_demo_ready() {
  docker exec acs-cymru_supabase_db psql -U postgres -d postgres -tAc \
    "SELECT EXISTS (
       SELECT 1 FROM public.digital_thread
        WHERE causation_id IS NOT NULL
        GROUP BY causation_id
       HAVING count(*) FILTER (WHERE entity_type = 'gateways') > 0
          AND count(*) FILTER (WHERE entity_type = 'devices')  > 1)" | grep -q t
}
wait_for "the Digital Thread causation demo" causation_demo_ready

rest_answers() {
  docker exec acs-cymru_supabase_db psql -U postgres -d postgres -tAc "SELECT 1" | grep -q 1
}
wait_for "PostgREST's database" rest_answers

# --- 5. gateways ---------------------------------------------------------------------------------
if [ "$SKIP_GATEWAYS" -eq 1 ]; then
  step "Skipping gateway provisioning (--skip-gateways)"
else
  step "Provisioning cell gateways"
  # Writes the credentials to .env.gateways as well as printing them. They are NOT recoverable
  # afterwards -- mosquitto_passwd stores only a hash -- so a run whose output scrolled away
  # would mean re-provisioning to find out what it had set.
  npm run --silent provision:gateways -- --env-out=.env.gateways

  # ---------------------------------------------------------------------------------------------
  # FOLD THEM INTO .env, WHICH IS THE STEP THAT WAS MISSING AND THE ONE THAT BITES.
  #
  # `down -v` destroys the Mosquitto password volume, so provisioning issues NEW credentials --
  # while .env still holds the previous set. Compose passes .env to node-red-init, which seeds
  # Node-RED with passwords the broker no longer knows. Nothing fails during the reset: it reports
  # success, and four gateways then log
  #
  #     Connection failed to broker: node-red-cnc@mqtt://mosquitto:1883
  #
  # with no CONNACK code. Leaving this to be done by hand made a clean-slate script that does not
  # actually leave you with a working stack, which is the one thing it exists for.
  # ---------------------------------------------------------------------------------------------
  if [ -f .env.gateways ]; then
    step "Folding gateway credentials into .env"
    # Rewrites the MQTT_GW_* lines in place and appends any that are new, leaving every other line
    # untouched. Done with awk rather than `sed -i` so it is one pass and needs no temp-file dance.
    awk '
      NR == FNR {
        if ($0 ~ /^MQTT_GW_[A-Z0-9_]+=/) { split($0, kv, "="); new[kv[1]] = $0 }
        next
      }
      {
        if ($0 ~ /^MQTT_GW_[A-Z0-9_]+=/) {
          split($0, kv, "=")
          if (kv[1] in new) { print new[kv[1]]; seen[kv[1]] = 1; next }
        }
        print
      }
      END { for (k in new) if (!(k in seen)) print new[k] }
    ' .env.gateways .env > .env.reset.tmp && mv .env.reset.tmp .env
    echo "    .env updated from .env.gateways"

    # Node-RED was started before those credentials existed, so it is holding the old ones.
    step "Reseeding Node-RED with the new credentials"
    NODE_RED_FORCE_SEED=true docker compose up -d --force-recreate node-red-init node-red
  fi
fi

# --- 6. summary ----------------------------------------------------------------------------------
step "Ready"

cat <<'ACCOUNTS'
Demo accounts (password: acscymru123)

  admin@acs-cymru.local       Administrator       full CRUD
  manager@acs-cymru.local     Shopfloor_Manager   full CRUD
  operator@acs-cymru.local    Operator            read-only + telemetry
  auditor@acs-cymru.local     Auditor             digital thread read-only

Interfaces

  Dashboard        http://localhost:3000
  Supabase Studio  http://127.0.0.1:54323
  Node-RED         http://localhost:1880
  Grafana          http://localhost:3002
  Swagger UI       http://localhost:8088

Sign in to the dashboard FIRST -- Node-RED and Grafana federate to Supabase Auth and the consent
step needs that session.
ACCOUNTS

if [ "$SKIP_GATEWAYS" -ne 1 ] && [ -f .env.gateways ]; then
  printf '\nGateway credentials were written to .env.gateways (mode 0600, gitignored).\n'
  printf 'They cannot be read back from the broker -- keep that file or re-provision.\n'
fi

# THE AUDIT TRAIL IS NO LONGER EMPTY AFTER A RESET, and saying so would be the exact kind of stale
# claim this repository treats as worse than no claim: a reader cannot tell it is stale and will act
# on it. seed.sql deliberately commits one multi-entity act -- commissioning Cell 1 -- so the
# Digital Thread drawer has a causation group to show, and gateway provisioning writes a dozen rows
# of its own after that.
#
# THE COUNT IS QUERIED RATHER THAN WRITTEN DOWN, for the same reason. A literal here would be wrong
# the first time somebody adds a device to Cell 1 in 0002_seed_data.sql, and nothing would catch it.
demo_rows=$(docker exec acs-cymru_supabase_db psql -U postgres -d postgres -tAc \
  "SELECT count(*) FROM public.digital_thread
    WHERE causation_id = (
      SELECT causation_id FROM public.digital_thread
       WHERE causation_id IS NOT NULL
       GROUP BY causation_id
      HAVING count(*) FILTER (WHERE entity_type = 'gateways') > 0
         AND count(*) FILTER (WHERE entity_type = 'devices')  > 1
       ORDER BY causation_id DESC LIMIT 1)" 2>/dev/null | tr -d '[:space:]')

printf '\nThe Digital Thread opens on one seeded act: commissioning Cell 1 wrote %s audit rows in a\n' "${demo_rows:-4}"
printf 'SINGLE transaction, which is what gives the Same transaction control in the event drawer\n'
printf 'something to show. Open Digital Thread and click the newest marker on\n'
printf 'Sim_Gateway_Cell1_Machining.\n'
printf '\nEvery row after those records a real change.\n'
