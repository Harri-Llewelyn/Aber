#!/usr/bin/env sh
#
# Block until the ingestion daemon is actually consuming Sparkplug messages.
#
# =================================================================================================
# WHY "ROLLED OUT" IS NOT "CONSUMING", AND WHY CI KEEPS BELIEVING IT IS
#
# `kubectl rollout status deployment/ingestion` reports success the moment the container PROCESS
# starts. The daemon then connects to the broker and subscribes, and the gap between those two
# events is unbounded -- on a loaded runner it has been over two minutes, most of it spent in the
# init containers waiting for Kong and the telemetry table.
#
# validate.py runs immediately afterwards and starts publishing. Nothing waited. The whole suite
# then completes in fifteen seconds, failing fast, because the records each check polls for were
# never going to arrive: the daemon was not subscribed when the messages went past.
#
# The signature is a BLOCK of checks failing together -- DBIRTH parameters, telemetry, rename
# propagation, alias resolution, rebirth NCMD -- which is not what any single defect looks like.
# It has also been seen as ONE check failing, the first one, when the daemon came up midway
# through: the shape scales with how late it was.
#
# =================================================================================================
# WHY NOT A READINESS PROBE, WHICH IS THE OBVIOUS FIX
#
# Because `apps/ingestion.yaml` argues against it and is right:
#
#   readiness would gate scraping, and the moment worth scraping is the one where the daemon is
#   unhealthy. `acs_ingestion_up` and a flat `messages_total` say "running but consuming nothing",
#   which is a diagnosis; a target that has vanished says only that something is wrong somewhere.
#
# A probe would also pull the pod out of `ingestion-metrics` -- which sets
# `publishNotReadyAddresses: true` precisely so it does not -- exactly when its metrics matter
# most. The gate belongs in CI. This is that gate.
#
# =================================================================================================
# WHAT IT ACTUALLY WAITS FOR
#
#   acs_ingestion_up 1                     the endpoint is being served
#   sum(acs_ingestion_messages_total) > 0  and something has been consumed
#
# THE SECOND CONDITION IS THE ONE THAT MATTERS. `acs_ingestion_up` is 1 as soon as the HTTP server
# is listening, which happens before the MQTT subscription is live -- so waiting on it alone
# reproduces the bug with extra steps. A non-zero message count cannot be reached without a
# delivered message, and the simulators publish continuously, so a genuinely subscribed daemon
# gets there in seconds.
#
# SUMMED ACROSS THE LABELLED SERIES, because `messages_total` is deliberately NOT exported --
# metrics.py: "it is the sum of the labelled series above, and a scraper summing them would
# double-count." Grepping for a bare `acs_ingestion_messages_total ` finds nothing, forever.
#
# =================================================================================================
# SEQUENCE GAP WARNINGS ARE EXPECTED WHILE THIS WAITS
#
# The simulators publish throughout the daemon's init wait and those messages are gone. When it
# does subscribe, `_last_seq` sees a jump and logs a burst of `SEQUENCE GAP` warnings. That is the
# gap detection working, not a regression -- do not read it as one, and do not "fix" it by
# relaxing the check.
#
# Usage:
#   WAIT_MODE=compose scripts/wait-for-ingestion-consuming.sh
#   WAIT_MODE=k8s NS=acs-cymru scripts/wait-for-ingestion-consuming.sh
#
set -eu

MODE="${WAIT_MODE:-compose}"
TIMEOUT="${WAIT_TIMEOUT_SECONDS:-180}"
INTERVAL="${WAIT_INTERVAL_SECONDS:-3}"
PORT="${INGESTION_METRICS_PORT:-9108}"
NS="${NS:-acs-cymru}"

# -------------------------------------------------------------------------------------------------
# Fetching the endpoint, which is the only part that differs between targets.
#
# COMPOSE publishes 9108 to the host deliberately -- "the endpoint is how the daemon is INSPECTED"
# -- so a plain curl reaches it.
#
# KUBERNETES does not. `ingestion-metrics` is headless and cluster-internal, so this execs into the
# pod and asks it for its own endpoint. WITH PYTHON, NOT CURL: the image is python:3.10-slim and
# carries no curl, which a first attempt discovers as `executable file not found`. Spawning a curl
# pod per poll was the alternative and costs a pod creation every three seconds for something the
# container can already answer.
# -------------------------------------------------------------------------------------------------
fetch() {
  case "$MODE" in
    compose)
      curl -sf --max-time 5 "http://localhost:${PORT}/metrics" 2>/dev/null || true
      ;;
    k8s)
      kubectl -n "$NS" exec deploy/ingestion -c ingestion -- \
        python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${PORT}/metrics',timeout=5).read().decode())" \
        2>/dev/null || true
      ;;
    *)
      echo "wait-for-ingestion-consuming: unknown WAIT_MODE '$MODE' (expected compose or k8s)" >&2
      exit 2
      ;;
  esac
}

echo "waiting up to ${TIMEOUT}s for the ingestion daemon to be consuming (mode=${MODE})..."

elapsed=0
last_up="none"
last_msgs="none"

while [ "$elapsed" -lt "$TIMEOUT" ]; do
  body="$(fetch)"

  if [ -n "$body" ]; then
    # `$2` on the bare gauge line; the sum of the last field across every labelled counter series.
    last_up="$(printf '%s\n' "$body" | awk '/^acs_ingestion_up /{print $2; found=1} END{if(!found) print "absent"}')"
    last_msgs="$(printf '%s\n' "$body" | awk '/^acs_ingestion_messages_total\{/{s+=$NF} END{printf "%d", s+0}')"

    if [ "$last_up" = "1" ] && [ "$last_msgs" -gt 0 ] 2>/dev/null; then
      echo "ingestion is consuming: acs_ingestion_up=1, sum(acs_ingestion_messages_total)=${last_msgs} after ${elapsed}s"
      exit 0
    fi
  fi

  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

# -------------------------------------------------------------------------------------------------
# THE FAILURE NAMES THE WAIT, which is the whole point of having one.
#
# Without this step the same situation surfaced as validate.py reporting ten unrelated conformance
# failures -- none of which mentioned timing, and every one of which sent the reader to look at the
# feature it named.
# -------------------------------------------------------------------------------------------------
echo "" >&2
echo "TIMED OUT after ${TIMEOUT}s: the ingestion daemon is not consuming." >&2
echo "" >&2
echo "  last acs_ingestion_up:                  ${last_up}" >&2
echo "  last sum(acs_ingestion_messages_total): ${last_msgs}" >&2
echo "" >&2
if [ "$last_up" = "none" ]; then
  echo "The metrics endpoint answered nothing at all. The daemon is not serving on ${PORT} --" >&2
  echo "check whether it is still in its init containers, or halted at startup: it refuses to" >&2
  echo "start its MQTT loop without SUPABASE_INGESTION_KEY and says so in its own logs." >&2
elif [ "$last_msgs" = "0" ]; then
  echo "The endpoint is up and NOTHING has been consumed. The daemon is running and not" >&2
  echo "subscribed -- which is the state acs_ingestion_up exists to distinguish from a dead" >&2
  echo "target. Check the broker credential and the MQTT connection in the daemon's logs." >&2
fi
echo "" >&2
echo "validate.py is NOT run after this failure, deliberately: it would report a block of" >&2
echo "conformance failures for a cause none of them describes. See issue #47." >&2
exit 1
