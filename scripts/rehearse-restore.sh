#!/usr/bin/env bash
#
# Drive a backup and restore rehearsal against a Kubernetes cluster.
#
# The backup is the backup service's: `backup` asks for one the way the Backups page does, as the
# seeded Administrator through PostgREST, waits for the `backups` row, and copies the directory it
# names off the backup volume. `restore` replays it with scripts/restore-databases.sh and puts the
# storage objects, the forge's volume and the broker's document back the way the runbook in
# supabase/README.md ("Backup and Recovery") says to. `assert` then asks for a second backup, so a
# green run also means the restored stack can back itself up.
#
# One process per phase, because every phase needs a port-forward to one or more Services and a
# tunnel started in one workflow step is not reliably reachable from the next. The same code runs
# by hand against any cluster: see deploy/k8s/README.md, "Rehearsing the restore".
#
# Subcommands, in the order the rehearsal uses them:
#
#   seed                  write known data into both databases, the storage volume, the forge and
#                         the broker's document
#   snapshot <file>       record the counts and digests that must not move
#   backup <dir>          take a backup through the service and copy it into <dir>/<stamp>
#   restore <dir> <stamp> restore that backup into a freshly installed stack
#   assert                everything a count cannot catch, then a backup of the restored stack
#   compare <a> <b>       diff two snapshots and explain what moved
#
# And the off-site case, around them: the backup service copies the backup, encrypted, to a MinIO
# that outlives the namespace, and the restore starts from the bucket.
#
#   offsite-setup <identity>        make an age key pair, the bucket, and set the destination
#   offsite-wait <stamp>            wait until the service has copied <stamp>
#   fetch <dir> <stamp> <identity>  every object of <stamp> from the bucket, decrypted and checked
#
# Needs kubectl, psql, pg_restore, curl, jq, tar and sha256sum on the machine it runs on, and for
# the off-site case age and the aws CLI.
#
# Environment: NS (namespace, default aber), RELEASE (default aber), and the credentials
# the chart was installed with. The defaults match values-dev.yaml, which is what CI installs;
# the forge and broker credentials are read from the release Secret when not set.
#
set -euo pipefail

NS="${NS:-aber}"
RELEASE="${RELEASE:-aber}"
FIXTURES="${FIXTURES:-$(cd "$(dirname "$0")/../test-harness/restore-rehearsal" && pwd)}"

# Local ports for the tunnels. Deliberately not 54322/5433: those are the dev loop's forwards,
# and a rehearsal that silently reached a developer's live stack instead of the cluster is the one
# mistake here that would be genuinely expensive.
SB_PORT="${SB_PORT:-54399}"
TS_PORT="${TS_PORT:-54398}"
AUTH_PORT="${AUTH_PORT:-9399}"
REST_PORT="${REST_PORT:-3399}"
FORGE_PORT="${FORGE_PORT:-3398}"

SB_USER="${SB_USER:-supabase_admin}"
SB_DB="${SB_DB:-postgres}"
SB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
TS_USER="${TS_USER:-postgres}"
TS_DB="${TS_DB:-postgres}"
TS_PASSWORD="${DB_PASSWORD:-postgres}"
GATEWAY_KEY="${SUPABASE_PUBLISHABLE_KEY:-}"

REHEARSAL_EMAIL="${REHEARSAL_EMAIL:-restore-rehearsal@example.invalid}"
REHEARSAL_PASSWORD="${REHEARSAL_PASSWORD:-rehearsal-Passw0rd!}"
REHEARSAL_OBJECT="${REHEARSAL_OBJECT:-rehearsal-canary.txt}"
REHEARSAL_OBJECT_BODY="${REHEARSAL_OBJECT_BODY:-rehearsal-object-contents}"
# The organisation every gateway repository lives in (supabase/functions/_shared/forge.ts), and
# the repository the rehearsal creates in it the way enrolment would.
FORGE_ORGANISATION="${FORGE_ORGANISATION:-gateways}"
REHEARSAL_REPOSITORY="${REHEARSAL_REPOSITORY:-rehearsal-gateway}"
# A broker account shaped like a gateway's, so the boot reconcile keeps it as one.
REHEARSAL_BROKER_CLIENT="${REHEARSAL_BROKER_CLIENT:-gwy0e0000000000400080000}"
REHEARSAL_BROKER_PASSWORD="${REHEARSAL_BROKER_PASSWORD:-rehearsal-broker-Passw0rd}"
# How long a backup may take before the rehearsal gives up on it.
BACKUP_TIMEOUT_SECONDS="${BACKUP_TIMEOUT_SECONDS:-600}"
# The off-site store (test-harness/restore-rehearsal/minio.yaml): its namespace, the address the
# backup service reaches it at, the local port of the tunnel, and the bucket's own credential.
OFFSITE_NS="${OFFSITE_NS:-rehearsal-offsite}"
OFFSITE_ENDPOINT="${OFFSITE_ENDPOINT:-http://minio.$OFFSITE_NS.svc.cluster.local:9000}"
MINIO_PORT="${MINIO_PORT:-9397}"
OFFSITE_REGION="${OFFSITE_REGION:-us-east-1}"
OFFSITE_BUCKET="${OFFSITE_BUCKET:-aber-rehearsal}"
OFFSITE_PREFIX="${OFFSITE_PREFIX:-rehearsal/backups}"
OFFSITE_KEY_ID="${OFFSITE_KEY_ID:-rehearsal}"
OFFSITE_SECRET="${OFFSITE_SECRET:-rehearsal-secret-key}"

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

# A tunnel, and proof it carries traffic before returning: `kubectl port-forward` prints
# "Forwarding from ..." immediately and can still fail to connect to the pod behind it.
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

sb() { PGPASSWORD="$SB_PASSWORD" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$SB_PORT" -U "$SB_USER" -d "$SB_DB" "$@"; }
ts() { PGPASSWORD="$TS_PASSWORD" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$TS_PORT" -U "$TS_USER" -d "$TS_DB" "$@"; }

pod_of() {
  kubectl -n "$NS" get pod -l "app.kubernetes.io/component=$1" \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'
}
storage_pod() { pod_of supabase-storage; }

has_deployment() { kubectl -n "$NS" get "deploy/$1" >/dev/null 2>&1; }

# A value from the release Secret, for the credentials this script is not handed.
secret_value() {
  kubectl -n "$NS" get secret "$RELEASE-secrets" -o "jsonpath={.data.$1}" | base64 -d
}

# -------------------------------------------------------------------------------------------------
# The seeded user, through GoTrue and PostgREST: the Backups page's own path.
# -------------------------------------------------------------------------------------------------
# A bearer token for the rehearsal user. The password was set before the backup, so a sign-in
# after the restore is the end-to-end check that GoTrue's schema and the JWT secret survived.
signin_token() {
  local code
  code=$(curl -s -o /tmp/signin.json -w '%{http_code}' \
    -X POST "http://127.0.0.1:$AUTH_PORT/token?grant_type=password" \
    -H 'Content-Type: application/json' \
    ${GATEWAY_KEY:+-H "apikey: $GATEWAY_KEY"} \
    -d "{\"email\":\"$REHEARSAL_EMAIL\",\"password\":\"$REHEARSAL_PASSWORD\"}" || true)
  [ "$code" = "200" ] || { cat /tmp/signin.json >&2 || true; die "the seeded user cannot sign in (HTTP $code) -- GoTrue's schema or the JWT secret did not survive"; }
  jq -er '.access_token' /tmp/signin.json \
    || die "GoTrue answered 200 with no access_token -- the JWT secret did not survive"
}

# rest <token> <method> <path> [json body]; prints the body, fails on a non-2xx.
rest() {
  local token="$1" method="$2" path="$3" body="${4:-}" code
  code=$(curl -s -o /tmp/rest.json -w '%{http_code}' -X "$method" "http://127.0.0.1:$REST_PORT$path" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -H 'Accept: application/json' ${body:+-d "$body"} || true)
  case "$code" in
    2??) cat /tmp/rest.json ;;
    *) cat /tmp/rest.json >&2 || true; die "PostgREST $method $path answered $code" ;;
  esac
}

# -------------------------------------------------------------------------------------------------
# The forge, as the machine account: the same door enrolment uses.
# -------------------------------------------------------------------------------------------------
forge_credentials() {
  FORGE_USER="${GITEA_MACHINE_USER:-$(kubectl -n "$NS" get deploy/gitea -o jsonpath='{.spec.template.spec.initContainers[0].env[?(@.name=="GITEA_MACHINE_USER")].value}')}"
  FORGE_PASSWORD="${GITEA_MACHINE_PASSWORD:-$(secret_value GITEA_MACHINE_PASSWORD)}"
  [ -n "$FORGE_USER" ] && [ -n "$FORGE_PASSWORD" ] || die "the forge's machine account is not configured (GITEA_MACHINE_USER / GITEA_MACHINE_PASSWORD)"
}

# forge <method> <path> [json body]; prints the status code, leaves the body in /tmp/forge.json.
forge() {
  local method="$1" path="$2" body="${3:-}"
  curl -s -o /tmp/forge.json -w '%{http_code}' -X "$method" "http://127.0.0.1:$FORGE_PORT/api/v1$path" \
    -u "$FORGE_USER:$FORGE_PASSWORD" -H 'Content-Type: application/json' -H 'Accept: application/json' \
    ${body:+-d "$body"} || true
}

forge_host_key_sha256() {
  curl -sf "http://127.0.0.1:$FORGE_PORT/assets/ssh_host_key.pub" | sha256sum | cut -d' ' -f1
}

# -------------------------------------------------------------------------------------------------
# The broker's document, through the plugin's own control tool and the file it writes.
# -------------------------------------------------------------------------------------------------
broker_credentials() {
  DYNSEC_USER="${MQTT_DYNSEC_ADMIN_USER:-$(secret_value MQTT_DYNSEC_ADMIN_USER)}"
  DYNSEC_PASSWORD="${MQTT_DYNSEC_ADMIN_PASSWORD:-$(secret_value MQTT_DYNSEC_ADMIN_PASSWORD)}"
}

dynsec() {
  kubectl -n "$NS" exec deploy/mosquitto -c mosquitto -- \
    mosquitto_ctrl -h 127.0.0.1 -u "$DYNSEC_USER" -P "$DYNSEC_PASSWORD" dynsec "$@"
}

broker_document() {
  kubectl -n "$NS" exec deploy/mosquitto -c mosquitto -- cat /mosquitto/data/dynamic-security.json
}

# =================================================================================================
cmd_seed() {
  forward_databases
  log "seeding the Supabase database"
  sb -q -f "$FIXTURES/seed-supabase.sql"
  log "seeding the historian"
  ts -q -f "$FIXTURES/seed-timescale.sql"

  # An auth user, created through GoTrue rather than by inserting into auth.users, so the
  # post-restore sign-in exercises GoTrue's own hashing and the JWT secret. Through the admin
  # API as the service role: self-service signup is closed on this stack (GOTRUE_DISABLE_SIGNUP),
  # and /signup answers 422 whether or not the user exists.
  log "creating the rehearsal auth user through GoTrue"
  forward supabase-auth "$AUTH_PORT" 9999
  local service_key code
  service_key="${SUPABASE_SERVICE_ROLE_KEY:-$(secret_value SUPABASE_SERVICE_ROLE_KEY)}"
  [ -n "$service_key" ] || die "no service-role key (SUPABASE_SERVICE_ROLE_KEY) to create the rehearsal user with"
  code=$(curl -s -o /tmp/signup.json -w '%{http_code}' \
    -X POST "http://127.0.0.1:$AUTH_PORT/admin/users" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $service_key" \
    ${GATEWAY_KEY:+-H "apikey: $GATEWAY_KEY"} \
    -d "{\"email\":\"$REHEARSAL_EMAIL\",\"password\":\"$REHEARSAL_PASSWORD\",\"email_confirm\":true}" || true)
  case "$code" in
    200|201) log "  created" ;;
    422)
      grep -q -i 'already been registered' /tmp/signup.json \
        || { cat /tmp/signup.json >&2; die "GoTrue refused the rehearsal user"; }
      log "  already present (re-run)" ;;
    *)       cat /tmp/signup.json >&2 || true; die "GoTrue's admin API returned $code" ;;
  esac
  # And the password it was created with signs in now, so a failure after the restore is the
  # restore's.
  signin_token >/dev/null
  log "  signs in"

  # Administrator, because request_backup() and the backups table admit nobody else.
  log "making the rehearsal user an Administrator"
  sb -q -v email="$REHEARSAL_EMAIL" -f - <<'SQL'
INSERT INTO public.user_roles (user_id, role_id)
SELECT u.id::text, r.id
  FROM auth.users u
  JOIN public.roles r ON r.name = 'Administrator'
 WHERE u.email = :'email'
   AND NOT EXISTS (SELECT 1 FROM public.user_roles x WHERE x.user_id = u.id::text AND x.role_id = r.id);
SQL

  # A storage object, written onto the volume the backup archives. Through the pod's filesystem
  # rather than the Storage API, because what is being rehearsed is that the volume round-trips.
  log "writing the rehearsal storage object"
  local pod
  pod="$(storage_pod)"
  [ -n "$pod" ] || die "no supabase-storage pod found in namespace $NS"
  kubectl -n "$NS" exec "$pod" -- sh -c \
    "mkdir -p /var/lib/storage/rehearsal && printf '%s' '$REHEARSAL_OBJECT_BODY' > /var/lib/storage/rehearsal/$REHEARSAL_OBJECT"

  # A gateway repository, protected the way enrolment protects one (forge.ts): the organisation,
  # a private repository with an initial commit, and `main` closed to pushes behind a status check.
  if has_deployment gitea; then
    log "seeding the forge"
    forge_credentials
    forward gitea "$FORGE_PORT" 3000
    case "$(forge GET "/orgs/$FORGE_ORGANISATION")" in
      200) log "  organisation '$FORGE_ORGANISATION' present" ;;
      404) [ "$(forge POST /orgs "{\"username\":\"$FORGE_ORGANISATION\",\"full_name\":\"Gateways\",\"visibility\":\"private\",\"repo_admin_change_team_access\":false}")" = "201" ] \
             || { cat /tmp/forge.json >&2; die "could not create organisation '$FORGE_ORGANISATION'"; }
           log "  created organisation '$FORGE_ORGANISATION'" ;;
      *)   cat /tmp/forge.json >&2; die "could not read organisation '$FORGE_ORGANISATION'" ;;
    esac
    case "$(forge GET "/repos/$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY")" in
      200) log "  repository '$REHEARSAL_REPOSITORY' present (re-run)" ;;
      404) [ "$(forge POST "/orgs/$FORGE_ORGANISATION/repos" "{\"name\":\"$REHEARSAL_REPOSITORY\",\"description\":\"Seeded by the restore rehearsal.\",\"private\":true,\"auto_init\":true,\"default_branch\":\"main\"}")" = "201" ] \
             || { cat /tmp/forge.json >&2; die "could not create repository '$REHEARSAL_REPOSITORY'"; }
           log "  created repository '$REHEARSAL_REPOSITORY'" ;;
      *)   cat /tmp/forge.json >&2; die "could not read repository '$REHEARSAL_REPOSITORY'" ;;
    esac
    case "$(forge GET "/repos/$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY/branch_protections/main")" in
      200) log "  'main' already protected" ;;
      404) [ "$(forge POST "/repos/$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY/branch_protections" '{"branch_name":"main","enable_push":false,"required_approvals":1,"block_on_rejected_reviews":true,"dismiss_stale_approvals":true,"enable_status_check":true,"status_check_contexts":["aber/flow-shape"]}')" = "201" ] \
             || { cat /tmp/forge.json >&2; die "could not protect 'main' on '$REHEARSAL_REPOSITORY'"; }
           log "  protected 'main'" ;;
      *)   cat /tmp/forge.json >&2; die "could not read the branch protection on '$REHEARSAL_REPOSITORY'" ;;
    esac
    [ -n "$(forge_host_key_sha256)" ] || die "the forge publishes no SSH host key at /assets/ssh_host_key.pub"
  else
    log "no forge in this stack; not seeded"
  fi

  # A gateway account in the broker's Dynamic Security document, through the plugin's control
  # API, which is what rewrites the file on the broker's volume.
  if has_deployment mosquitto; then
    log "seeding the broker's document"
    broker_credentials
    if dynsec getClient "$REHEARSAL_BROKER_CLIENT" >/dev/null 2>&1; then
      log "  client '$REHEARSAL_BROKER_CLIENT' present (re-run)"
    else
      dynsec createClient "$REHEARSAL_BROKER_CLIENT" -p "$REHEARSAL_BROKER_PASSWORD" >/dev/null
      log "  created client '$REHEARSAL_BROKER_CLIENT'"
    fi
  else
    log "no broker in this stack; not seeded"
  fi
  log "seed complete"
}

# =================================================================================================
cmd_snapshot() {
  local out="${1:?usage: snapshot <file>}"
  forward_databases
  : > "$out"
  sb -tA -f "$FIXTURES/snapshot-supabase.sql" | sed 's/^/supabase:/' >> "$out"
  ts -tA -f "$FIXTURES/snapshot-timescale.sql" | sed 's/^/historian:/' >> "$out"
  # The storage object lives on a volume rather than in either database, so it is counted here.
  local pod
  pod="$(storage_pod)"
  printf 'storage:objects=%s\n' \
    "$(kubectl -n "$NS" exec "$pod" -- sh -c 'find /var/lib/storage -type f | wc -l' | tr -d ' \r')" >> "$out"
  # The forge: how many repositories the organisation holds, whether `main` is still closed on
  # the seeded one, and the SSH host key's digest. The key is what every appliance pins, so it
  # must come back byte for byte, not merely "a key".
  if has_deployment gitea; then
    forge_credentials
    forward gitea "$FORGE_PORT" 3000
    # A fresh forge has no organisation yet, which is zero repositories, not an error.
    case "$(forge GET "/orgs/$FORGE_ORGANISATION/repos?limit=50")" in
      200) printf 'forge:repositories=%s\n' "$(jq 'length' /tmp/forge.json)" >> "$out" ;;
      404) printf 'forge:repositories=0\n' >> "$out" ;;
      *)   cat /tmp/forge.json >&2; die "could not list the forge's repositories" ;;
    esac
    [ "$(forge GET "/repos/$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY/branch_protections/main")" = "200" ] \
      && printf 'forge:main_closed_to_pushes=%s\n' "$(jq '.enable_push == false' /tmp/forge.json)" >> "$out" \
      || printf 'forge:main_closed_to_pushes=absent\n' >> "$out"
    printf 'forge:host_key_sha256=%s\n' "$(forge_host_key_sha256)" >> "$out"
  fi
  # The broker: how many accounts the document holds.
  if has_deployment mosquitto; then
    printf 'broker:clients=%s\n' "$(broker_document | jq '.clients | length')" >> "$out"
  fi
  log "snapshot written to $out"
  cat "$out"
}

# =================================================================================================
# The backup, through the service. What comes out is <dir>/<stamp>/, the directory the `backups`
# row names, copied off the backup volume: the files restore-databases.sh reads plus the archives.
# =================================================================================================
cmd_backup() {
  local dir="${1:?usage: backup <dir>}"
  mkdir -p "$dir"
  forward supabase-auth "$AUTH_PORT" 9999
  forward supabase-rest "$REST_PORT" 3000
  local token job status backup_id stamp
  token="$(signin_token)"

  log "asking for a backup as the rehearsal Administrator"
  job=$(rest "$token" POST /rpc/request_backup '{"p_note":"restore rehearsal"}' | jq -r '.')
  [[ "$job" =~ ^[0-9a-f-]{36}$ ]] || die "request_backup() did not return a job id: $job"
  log "  job $job queued"

  local waited=0
  while :; do
    rest "$token" GET "/backup_jobs?id=eq.$job&select=status,error,backup_id" > /tmp/job.json
    status=$(jq -r '.[0].status // empty' /tmp/job.json)
    case "$status" in
      COMPLETED) backup_id=$(jq -r '.[0].backup_id' /tmp/job.json); break ;;
      FAILED)    die "the backup service failed the job: $(jq -r '.[0].error' /tmp/job.json)" ;;
      CANCELLED) die "the job was cancelled" ;;
      PENDING|RUNNING) ;;
      *) die "job $job is not visible to the rehearsal user (status '$status')" ;;
    esac
    if [ "$status" = "PENDING" ] && [ "$waited" -ge 60 ]; then
      die "the job has been PENDING for ${waited}s: no backup service is claiming it (is backupService.enabled set?)"
    fi
    [ "$waited" -lt "$BACKUP_TIMEOUT_SECONDS" ] || die "the backup did not finish within ${BACKUP_TIMEOUT_SECONDS}s (status $status)"
    sleep 5; waited=$((waited + 5))
  done
  rest "$token" GET "/backups?id=eq.$backup_id&select=stamp,location,components,size_bytes" > /tmp/backup.json
  stamp=$(jq -r '.[0].stamp' /tmp/backup.json)
  [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "the backups row carries no stamp"
  log "  backup $stamp taken in ${waited}s: $(jq -r '[.[0].components[].name] | join(", ")' /tmp/backup.json)"

  # Off the volume, as a streamed tar: the same shape the runbook's `kubectl cp` produces, without
  # the directory-or-contents ambiguity a directory copy has.
  local pod
  pod="$(pod_of backup-service)"
  [ -n "$pod" ] || die "no backup-service pod found in namespace $NS"
  rm -rf "${dir:?}/$stamp"
  log "copying $stamp off the backup volume"
  kubectl -n "$NS" exec "$pod" -- tar -czf - -C /backups "$stamp" | tar -xzf - -C "$dir"

  # The digests the row records, against the bytes that arrived; and the row against the manifest,
  # since the row is what the page shows.
  log "verifying the digests"
  local name file want have
  while IFS=$'\t' read -r name file want; do
    have=$(sha256sum "$dir/$stamp/$file" | cut -d' ' -f1)
    [ "$have" = "$want" ] || die "$file: sha256 $have does not match the manifest's $want"
    log "  ok $name ($file)"
  done < <(jq -r '.components[] | [.name, .file, .sha256] | @tsv' "$dir/$stamp/manifest.json")
  diff <(jq -S '.components' "$dir/$stamp/manifest.json") <(jq -S '.[0].components' /tmp/backup.json) \
    || die "the backups row and manifest.json disagree about the components"
  grep -q "^stamp=$stamp\$" "$dir/$stamp/manifest-$stamp.txt" || die "manifest-$stamp.txt does not carry its own stamp"
  log "backup complete: $dir/$stamp"
  ls -la "$dir/$stamp"
}

# =================================================================================================
# The volumes come back through a helper pod holding the same claim, with the workload scaled to
# zero: the runbook's steps, verbatim. The helper runs the workload's own image, which the node
# already holds.
# =================================================================================================
restore_volume() {
  local deploy="$1" archive="$2" claim image helper
  claim=$(kubectl -n "$NS" get "deploy/$deploy" -o jsonpath='{.spec.template.spec.volumes[?(@.name=="data")].persistentVolumeClaim.claimName}')
  image=$(kubectl -n "$NS" get "deploy/$deploy" -o jsonpath='{.spec.template.spec.containers[0].image}')
  [ -n "$claim" ] && [ -n "$image" ] || die "deploy/$deploy has no 'data' claim to restore into"
  helper="volume-restore-$deploy"
  log "restoring $claim from $(basename "$archive") with $deploy scaled to zero"
  kubectl -n "$NS" scale "deploy/$deploy" --replicas=0 >/dev/null
  kubectl -n "$NS" wait --for=delete pod -l "app.kubernetes.io/component=$deploy" --timeout=5m
  kubectl -n "$NS" delete pod "$helper" --ignore-not-found --wait >/dev/null
  kubectl -n "$NS" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $helper
spec:
  restartPolicy: Never
  securityContext:
    runAsUser: 0
  containers:
    - name: restore
      image: "$image"
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
      volumeMounts:
        - name: data
          mountPath: /volume
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: $claim
EOF
  kubectl -n "$NS" wait --for=condition=Ready "pod/$helper" --timeout=5m
  kubectl -n "$NS" exec -i "$helper" -- sh -c 'rm -rf /volume/* /volume/.[!.]* 2>/dev/null; tar -xzf - -C /volume' < "$archive"
  kubectl -n "$NS" exec "$helper" -- sh -c 'find /volume -type f | wc -l' | { read -r n; log "  $n file(s) on the volume"; }
  kubectl -n "$NS" delete pod "$helper" --wait >/dev/null
  kubectl -n "$NS" scale "deploy/$deploy" --replicas=1 >/dev/null
  kubectl -n "$NS" rollout status "deploy/$deploy" --timeout=10m
}

cmd_restore() {
  local dir="${1:?usage: restore <dir> <stamp>}"
  local stamp="${2:?usage: restore <dir> <stamp>}"
  local backup="$dir/$stamp" manifest
  manifest="$backup/manifest-$stamp.txt"
  [ -f "$manifest" ] || die "no manifest at $manifest"

  # pgsodium's root key, onto the fresh database's volume and into a restarted server before the
  # dump: Vault's rows are ciphertext under it, and the fresh server minted its own. Before the
  # tunnels, which the restart would drop.
  if grep -q '^vault_key=' "$manifest"; then
    log "placing the pgsodium root key and restarting supabase-db"
    kubectl -n "$NS" exec -i statefulset/supabase-db -c supabase-db -- \
      sh -c 'umask 077; cat > /var/lib/postgresql/data/pgsodium_root.key' \
      < "$backup/$(sed -n 's/^vault_key=//p' "$manifest")"
    kubectl -n "$NS" delete pod supabase-db-0 --wait
    kubectl -n "$NS" rollout status statefulset/supabase-db --timeout=10m
  else
    log "no root key in this backup: Vault's secrets will not decrypt after the restore"
  fi
  forward_databases

  ASSUME_YES=true \
  BACKUP_DIR="$backup" BACKUP_STAMP="$stamp" \
  SUPABASE_DB_HOST=127.0.0.1 SUPABASE_DB_PORT="$SB_PORT" \
  SUPABASE_DB_USER="$SB_USER" SUPABASE_DB_NAME="$SB_DB" POSTGRES_PASSWORD="$SB_PASSWORD" \
  TIMESCALE_HOST=127.0.0.1 TIMESCALE_PORT="$TS_PORT" \
  DB_USER="$TS_USER" DB_NAME="$TS_DB" DB_PASSWORD="$TS_PASSWORD" \
    bash "$(dirname "$0")/restore-databases.sh"

  # The half restore-databases.sh cannot do, and says so: it cannot reach a volume. Left there,
  # `devices.model_3d_path` would come back pointing at objects that do not exist.
  local archive pod unpack
  archive="$backup/$(sed -n 's/^storage=//p' "$manifest")"
  [ -f "$archive" ] || die "no storage archive in this backup"
  pod="$(storage_pod)"
  unpack="$dir/.storage-restore"
  rm -rf "$unpack"; mkdir -p "$unpack"
  tar -xzf "$archive" -C "$unpack"
  log "copying storage objects back into $pod"
  tar -czf - -C "$unpack" . | kubectl -n "$NS" exec -i "$pod" -- tar -xzf - -C /var/lib/storage
  rm -rf "$unpack"

  # The forge's volume: every repository, the SQLite database and the SSH host keys.
  archive="$backup/$(sed -n 's/^forge=//p' "$manifest")"
  if grep -q '^forge=' "$manifest"; then
    has_deployment gitea || die "the backup holds a forge archive and this stack has no forge"
    restore_volume gitea "$archive"
  else
    log "no forge archive in this backup"
  fi

  # The broker's volume: the Dynamic Security document, every issued gateway account.
  archive="$backup/$(sed -n 's/^broker=//p' "$manifest")"
  if grep -q '^broker=' "$manifest"; then
    has_deployment mosquitto || die "the backup holds a broker archive and this stack has no broker"
    restore_volume mosquitto "$archive"
  else
    log "no broker archive in this backup"
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

  # The storage object, byte for byte: the count says one file came back, this says which.
  log "asserting the storage object round-tripped"
  local pod body
  pod="$(storage_pod)"
  body=$(kubectl -n "$NS" exec "$pod" -- sh -c "cat /var/lib/storage/rehearsal/$REHEARSAL_OBJECT" 2>/dev/null || true)
  [ "$body" = "$REHEARSAL_OBJECT_BODY" ] \
    || die "the rehearsal storage object did not survive: expected '$REHEARSAL_OBJECT_BODY', got '$body'"

  # The forge: the seeded repository is back with its first commit, `main` is still closed to
  # pushes, and the host key the forge publishes is the one on the restored volume. The digest
  # against the pre-backup key is compare's job; this is that a key is served at all.
  if has_deployment gitea; then
    log "asserting the forge"
    forge_credentials
    forward gitea "$FORGE_PORT" 3000
    [ "$(forge GET "/repos/$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY")" = "200" ] \
      || die "the seeded repository '$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY' did not survive the restore"
    [ "$(forge GET "/repos/$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY/branches/main")" = "200" ] \
      || die "'main' on the restored repository has no commit -- the repository tree did not come back with the database"
    [ "$(forge GET "/repos/$FORGE_ORGANISATION/$REHEARSAL_REPOSITORY/branch_protections/main")" = "200" ] \
      || die "the branch protection on '$REHEARSAL_REPOSITORY' did not survive the restore"
    [ "$(jq '.enable_push == false and (.status_check_contexts | index("aber/flow-shape") != null)' /tmp/forge.json)" = "true" ] \
      || die "'main' on the restored repository admits pushes or lost its status check"
    [ -n "$(forge_host_key_sha256)" ] || die "the restored forge publishes no SSH host key"
    log "  ok"
  fi

  # The broker: the seeded account is in the restored document, and the plugin answers for it.
  if has_deployment mosquitto; then
    log "asserting the broker's document"
    broker_credentials
    dynsec getClient "$REHEARSAL_BROKER_CLIENT" >/dev/null \
      || die "the broker account '$REHEARSAL_BROKER_CLIENT' did not survive the restore -- every gateway would be re-issued"
    log "  ok"
  fi

  # Sign in with the password set before the backup: GoTrue's schema and the JWT secret both.
  log "asserting the seeded user can still sign in"
  forward supabase-auth "$AUTH_PORT" 9999
  forward supabase-rest "$REST_PORT" 3000
  local token
  token="$(signin_token)"

  # The job the backup was taken during is RUNNING in the dump, and only the service can fail it.
  # A restored stack whose backup service never noticed would refuse every new backup.
  if has_deployment backup-service; then
    log "asserting the service failed the job the dump carries as RUNNING"
    local running i
    for i in $(seq 1 24); do
      running=$(rest "$token" GET '/backup_jobs?status=eq.RUNNING&select=id' | jq 'length')
      [ "$running" = "0" ] && break
      sleep 5
    done
    [ "$running" = "0" ] || die "a backup_jobs row is still RUNNING after the restore: the backup service did not reconcile it, so request_backup() refuses"

    # And the restored stack can back itself up: the same request, to completion.
    log "asserting the restored stack can take a backup"
    local job status
    job=$(rest "$token" POST /rpc/request_backup '{"p_note":"restore rehearsal, after the restore"}' | jq -r '.')
    for _ in $(seq 1 120); do
      status=$(rest "$token" GET "/backup_jobs?id=eq.$job&select=status,error" | jq -r '.[0].status')
      case "$status" in
        COMPLETED) break ;;
        FAILED) die "the post-restore backup failed: $(jq -r '.[0].error' /tmp/rest.json)" ;;
      esac
      sleep 5
    done
    [ "$status" = "COMPLETED" ] || die "the post-restore backup did not complete (status $status)"
    log "  ok: $(rest "$token" GET "/backups?job_id=eq.$job&select=stamp,components" | jq -r '.[0] | .stamp + " with " + ([.components[].name] | join(", "))')"

    # With a destination in the restored database, the restored Vault must still decrypt its key.
    if [ "$(rest "$token" POST /rpc/backup_offsite_credential_is_set '{}')" = "true" ]; then
      log "asserting the restored stack copies its backup off site"
      local stamp state
      stamp=$(rest "$token" GET "/backups?job_id=eq.$job&select=stamp" | jq -r '.[0].stamp')
      for _ in $(seq 1 120); do
        state=$(rest "$token" GET "/backups?stamp=eq.$stamp&select=offsite_state" | jq -r '.[0].offsite_state')
        [ "$state" = "COPIED" ] && break
        sleep 5
      done
      [ "$state" = "COPIED" ] || die "the restored stack did not copy $stamp off site (state $state): $(rest "$token" GET "/backups?stamp=eq.$stamp&select=offsite_error" | jq -r '.[0].offsite_error')"
      log "  ok: $stamp copied"
    fi
  fi

  log "PASS: every assertion held after the restore"
}

# -------------------------------------------------------------------------------------------------
# The off-site copy: a MinIO in its own namespace (test-harness/restore-rehearsal/minio.yaml), which
# outlives the release's namespace and the backup volume in it.
# -------------------------------------------------------------------------------------------------
forward_minio() {
  kubectl -n "$OFFSITE_NS" port-forward svc/minio "$MINIO_PORT:9000" >/tmp/pf-minio.log 2>&1 &
  PF_PIDS+=("$!")
  local i
  for i in $(seq 1 60); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$MINIO_PORT") 2>/dev/null; then
      exec 3<&- 3>&-
      return 0
    fi
    sleep 1
  done
  cat /tmp/pf-minio.log >&2 || true
  die "port-forward to $OFFSITE_NS/minio never accepted a connection on $MINIO_PORT"
}

# The aws CLI against the forwarded MinIO, path-style, with the bucket's own credential.
offsite_aws() {
  printf '[default]\ns3 =\n  addressing_style = path\n' > /tmp/rehearsal-aws-config
  AWS_CONFIG_FILE=/tmp/rehearsal-aws-config AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_ACCESS_KEY_ID="$OFFSITE_KEY_ID" AWS_SECRET_ACCESS_KEY="$OFFSITE_SECRET" \
  AWS_DEFAULT_REGION="$OFFSITE_REGION" AWS_EC2_METADATA_DISABLED=true AWS_PAGER='' \
    aws --endpoint-url "http://127.0.0.1:$MINIO_PORT" "$@"
}

# =================================================================================================
# A key pair, the bucket, and the destination set the way the Backups page's dialog sets it. The
# identity stays in <identity>, on this machine, as it must stay off the stack it decrypts.
cmd_offsite_setup() {
  local identity="${1:?usage: offsite-setup <identity file>}"
  command -v age-keygen >/dev/null || die "age-keygen is not installed"
  command -v aws >/dev/null || die "the aws CLI is not installed"
  [ -s "$identity" ] || age-keygen -o "$identity" 2>/dev/null
  local recipient
  recipient=$(age-keygen -y "$identity")
  log "the recipient is $recipient; its identity is $identity"

  forward_minio
  if ! offsite_aws s3api head-bucket --bucket "$OFFSITE_BUCKET" >/dev/null 2>&1; then
    offsite_aws s3api create-bucket --bucket "$OFFSITE_BUCKET" >/dev/null || die "could not create bucket $OFFSITE_BUCKET"
  fi
  log "bucket $OFFSITE_BUCKET is ready"

  forward supabase-auth "$AUTH_PORT" 9999
  forward supabase-rest "$REST_PORT" 3000
  local token
  token="$(signin_token)"
  rest "$token" POST /rpc/set_backup_offsite_destination "$(jq -n \
    --arg e "$OFFSITE_ENDPOINT" --arg r "$OFFSITE_REGION" --arg b "$OFFSITE_BUCKET" \
    --arg p "$OFFSITE_PREFIX" --arg k "$OFFSITE_KEY_ID" --arg c "$recipient" \
    '{p_endpoint:$e, p_region:$r, p_bucket:$b, p_prefix:$p, p_access_key_id:$k, p_recipient:$c, p_path_style:true}')" >/dev/null
  rest "$token" POST /rpc/set_backup_offsite_credential "$(jq -n --arg s "$OFFSITE_SECRET" '{p_secret:$s}')" >/dev/null
  log "the destination is $OFFSITE_ENDPOINT/$OFFSITE_BUCKET/$OFFSITE_PREFIX/"
}

# =================================================================================================
# Until the service has copied <stamp> and checked every object. A FAILED copy is retried by the
# service, so it is reported and waited through, up to the timeout.
cmd_offsite_wait() {
  local stamp="${1:?usage: offsite-wait <stamp>}"
  forward supabase-auth "$AUTH_PORT" 9999
  forward supabase-rest "$REST_PORT" 3000
  local token state waited=0
  token="$(signin_token)"
  while :; do
    rest "$token" GET "/backups?stamp=eq.$stamp&select=offsite_state,offsite_error,offsite_location,offsite_objects" > /tmp/offsite.json
    state=$(jq -r '.[0].offsite_state // empty' /tmp/offsite.json)
    case "$state" in
      COPIED) break ;;
      FAILED) log "  the copy failed and will be retried: $(jq -r '.[0].offsite_error' /tmp/offsite.json)" ;;
      PENDING) ;;
      *) die "no backups row for $stamp is visible to the rehearsal user" ;;
    esac
    [ "$waited" -lt "$BACKUP_TIMEOUT_SECONDS" ] || die "the off-site copy of $stamp did not complete within ${BACKUP_TIMEOUT_SECONDS}s (state $state)"
    sleep 5; waited=$((waited + 5))
  done
  log "copied in about ${waited}s to $(jq -r '.[0].offsite_location' /tmp/offsite.json): $(jq -r '[.[0].offsite_objects[].file] | join(", ")' /tmp/offsite.json)"
}

# =================================================================================================
# The runbook's first step when the pod and its volume are gone: every object of <stamp> from the
# bucket, each decrypted with the identity, and the plaintext checked against manifest.json.
cmd_fetch() {
  local dir="${1:?usage: fetch <dir> <stamp> <identity>}"
  local stamp="${2:?usage: fetch <dir> <stamp> <identity>}"
  local identity="${3:?usage: fetch <dir> <stamp> <identity>}"
  command -v age >/dev/null || die "age is not installed"
  forward_minio
  rm -rf "${dir:?}/$stamp"
  mkdir -p "$dir/$stamp"
  log "fetching $stamp from s3://$OFFSITE_BUCKET/$OFFSITE_PREFIX/$stamp/"
  offsite_aws s3 cp --recursive --only-show-errors "s3://$OFFSITE_BUCKET/$OFFSITE_PREFIX/$stamp/" "$dir/$stamp/"
  [ -f "$dir/$stamp/manifest.json.age" ] || die "the bucket holds no manifest.json.age for $stamp: the copy is incomplete"
  local f
  for f in "$dir/$stamp"/*.age; do
    age -d -i "$identity" -o "${f%.age}" "$f" || die "$(basename "$f") did not decrypt with $identity"
    rm -f "$f"
  done
  log "verifying the decrypted files against the manifest"
  local name file want have
  while IFS=$'\t' read -r name file want; do
    have=$(sha256sum "$dir/$stamp/$file" | cut -d' ' -f1)
    [ "$have" = "$want" ] || die "$file: sha256 $have does not match the manifest's $want"
    log "  ok $name ($file)"
  done < <(jq -r '.components[] | [.name, .file, .sha256] | @tsv' "$dir/$stamp/manifest.json")
  log "fetched: $dir/$stamp"
}

# =================================================================================================
cmd_compare() {
  local before="${1:?usage: compare <before> <after>}"
  local after="${2:?usage: compare <before> <after>}"
  if diff -u "$before" "$after"; then
    log "PASS: every count and digest is identical either side of the restore"
    return 0
  fi
  die "counts moved across the restore -- the lines above are before(-) and after(+). A count that
DROPPED is data the restore did not bring back. A count that ROSE is the rehearsal's own writes
landing twice, which means the namespace was not actually destroyed between the two installs. A
CHANGED host key digest means the forge's volume did not come back: every appliance would refuse
to clone."
}

# =================================================================================================
case "${1:-}" in
  seed)     shift; cmd_seed "$@" ;;
  snapshot) shift; cmd_snapshot "$@" ;;
  backup)   shift; cmd_backup "$@" ;;
  restore)  shift; cmd_restore "$@" ;;
  assert)   shift; cmd_assert "$@" ;;
  compare)  shift; cmd_compare "$@" ;;
  offsite-setup) shift; cmd_offsite_setup "$@" ;;
  offsite-wait)  shift; cmd_offsite_wait "$@" ;;
  fetch)    shift; cmd_fetch "$@" ;;
  *) die "usage: $0 {seed|snapshot <file>|backup <dir>|restore <dir> <stamp>|assert|compare <a> <b>|offsite-setup <identity>|offsite-wait <stamp>|fetch <dir> <stamp> <identity>}" ;;
esac
