#!/bin/bash
# Boots every edge function in a build step that has no network (RUN --network=none in the
# Dockerfile), so an import the image did not pre-resolve fails the build instead of a site with no
# internet route. Prints one line per function; the image keeps that output.
set -euo pipefail

FUNCTIONS=/home/deno/functions
PORT=9000

# Placeholders so a function that builds a client at load time can boot. Nothing answers on port 9.
export SUPABASE_URL=http://127.0.0.1:9 SUPABASE_PUBLISHABLE_KEY=offline-check SUPABASE_SERVICE_ROLE_KEY=offline-check

edge-runtime start --main-service "$FUNCTIONS/main" --port "$PORT" >/tmp/edge-runtime.log 2>&1 &
runtime=$!
trap 'kill "$runtime" 2>/dev/null || true' EXIT

listening() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
for _ in $(seq 100); do
  listening && break
  kill -0 "$runtime" 2>/dev/null || break
  sleep 0.1
done
if ! listening; then
  echo "FAIL the main service did not start"
  tail -20 /tmp/edge-runtime.log
  exit 1
fi

request() {
  exec 3<>"/dev/tcp/127.0.0.1/$PORT"
  printf 'GET /%s HTTP/1.0\r\nHost: localhost\r\n\r\n' "$1" >&3
  timeout 60 cat <&3
  exec 3<&-
}

failed=0
for dir in "$FUNCTIONS"/*/; do
  name=$(basename "$dir")
  [[ $name == _shared || $name == main ]] && continue
  response=$(request "$name" || true)
  status=$(head -1 <<<"$response" | tr -d '\r')
  # The router's own answers (main/index.ts): a worker that failed to load, and a name not in
  # FUNCTION_REGISTRY. Any other response came from the function itself, so it loaded.
  if [[ -z $response ]] || grep -qF "\"Failed to invoke '$name'\"" <<<"$response" \
    || grep -qF "\"Function '$name' not found\"" <<<"$response"; then
    echo "FAIL $name: ${status:-no response}"
    failed=1
  else
    echo "ok   $name: $status"
  fi
done

if (( failed )); then
  echo
  grep -E 'boot error|Import|failed' /tmp/edge-runtime.log | sort -u | head -20
  exit 1
fi
