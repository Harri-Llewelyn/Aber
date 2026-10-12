#!/bin/bash
# Gitea provisioning, run by the chart's init containers before the server starts, from a mirror of
# this file. With no argument it calls the image's own setup rather than writing app.ini, runs as
# root and then as git, creates the administrator (INSTALL_LOCK closes the web installer) and the
# machine account the platform authenticates as, a bot, and publishes the SSH host key so an
# appliance can verify this forge instead of trusting it on first use. With `token` it runs as git
# and gives the bot its API token, written into one Secret through the Kubernetes API. Idempotent
# by inspection, never by `|| true`. Reasoning: forge/README.md, "Provisioning the server".
set -e

DB="${GITEA__database__PATH:-/data/gitea/gitea.db}"

# The scopes the platform's calls need, measured one by one (forge/README.md, "The machine
# account's token"), in the order Gitea normalises them to: a different order reads as changed
# scopes and mints a new token on every boot.
TOKEN_SCOPES="write:organization,write:issue,write:repository,read:user"
# The token's name in Gitea. A boot replaces the token of this name and no other.
TOKEN_NAME="aber-platform"

die() {
  for line in "$@"; do echo "[gitea-init] $line" >&2; done
  exit 1
}

# As git: the root init container switches to it; the token container already is it.
as_git() {
  if [ "$(id -u)" = 0 ]; then su-exec git "$@"; else "$@"; fi
}

# One read of Gitea's own database. The columns read here are named in forge/README.md, so a Gitea
# upgrade that moves them is found by this script failing rather than by guessing.
gitea_db() {
  as_git sqlite3 -bail "$DB" "$1"
}

# The machine account's name, checked before it is put into SQL.
machine_user() {
  case "$GITEA_MACHINE_USER" in
    *[!A-Za-z0-9._-]*) die "GITEA_MACHINE_USER '$GITEA_MACHINE_USER' is not a Gitea username." ;;
  esac
  printf '%s' "$GITEA_MACHINE_USER"
}

# ---------------------------------------------------------------------------------------------
# `token`: the bot's API token, kept while it is the one the forge holds, minted when it is not.
# ---------------------------------------------------------------------------------------------
SA_DIR=/var/run/secrets/kubernetes.io/serviceaccount

# kube <method> <path> [body]: the API server's answer to one request, retried while the API server
# is unreachable or answers 5xx. A 401, 403 or 404 is the chart's RBAC or a missing Secret, which no
# retry mends, so it fails at once.
kube() {
  host="${KUBERNETES_SERVICE_HOST:-kubernetes.default.svc}"
  case "$host" in *:*) host="[$host]" ;; esac
  url="https://$host:${KUBERNETES_SERVICE_PORT:-443}$2"
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    set +e
    if [ -n "$3" ]; then
      answer=$(printf '%s' "$3" | curl -sS --max-time 10 -w '\n%{http_code}' -X "$1" --cacert "$SA_DIR/ca.crt" \
        -H "Authorization: Bearer $(cat "$SA_DIR/token")" -H 'Content-Type: application/merge-patch+json' \
        --data-binary @- "$url" 2>&1)
    else
      answer=$(curl -sS --max-time 10 -w '\n%{http_code}' -X "$1" --cacert "$SA_DIR/ca.crt" \
        -H "Authorization: Bearer $(cat "$SA_DIR/token")" "$url" 2>&1)
    fi
    set -e
    code="${answer##*$'\n'}"
    body="${answer%$'\n'*}"
    said=$(printf '%s' "$body" | tr -s '\n ' '  ')
    case "$code" in
      2??) printf '%s' "$body"; return 0 ;;
      401|403|404)
        die "the Kubernetes API answered $code to $1 $2." \
          "The Role this chart gives the forge allows get and patch on the token Secret alone, and" \
          "the chart renders that Secret: check both exist ($said)." ;;
    esac
    echo "[gitea-init] the Kubernetes API did not answer $1 $2 (attempt $attempt of 12: ${said:-no answer}); retrying." >&2
    sleep 5
  done
  die "the Kubernetes API was unreachable for a minute, so the platform's forge token could not be" \
    "delivered and the forge is not started. Under networkPolicy.enabled, check that" \
    "networkPolicy.apiServerCidr covers the API server. The pod retries on its own."
}

deliver_token() {
  [ -n "$GITEA_TOKEN_SECRET" ] || die "GITEA_TOKEN_SECRET must name the Secret the token is written into."
  user=$(machine_user)
  [ -n "$user" ] || die "GITEA_MACHINE_USER is empty, so there is no machine account to give a token to."
  namespace=$(cat "$SA_DIR/namespace")
  path="/api/v1/namespaces/$namespace/secrets/$GITEA_TOKEN_SECRET"

  uid=$(gitea_db "SELECT id FROM user WHERE lower_name = lower('$user') AND type = 4;")
  [ -n "$uid" ] || die "'$user' is not a bot account. The gitea-init container makes it one and runs first."

  # The Secret's current value. Its `data` block is the one place a "token" key sits at the start of
  # a line holding a string; managedFields carries "f:token" and an annotation would be escaped.
  secret=$(kube GET "$path")
  current=$(printf '%s\n' "$secret" | sed -n 's/^ *"token": *"\([A-Za-z0-9+/=]*\)".*$/\1/p' | head -n 1 | base64 -d)
  held=$(gitea_db "SELECT token_last_eight || ' ' || scope FROM access_token WHERE uid = $uid AND name = '$TOKEN_NAME';")

  # Kept when the forge holds a token of this name, with these scopes, ending as the delivered one
  # does. Gitea stores only a hash and the last eight characters, so this is as far as a check
  # without the running server reaches; a token refused for any other reason is replaced by
  # emptying the Secret and restarting the forge (forge/README.md, "Rotating the token").
  if [ -n "$current" ] && [ "$held" = "${current: -8} $TOKEN_SCOPES" ]; then
    echo "[gitea-init] the platform's token in Secret '$GITEA_TOKEN_SECRET' is the one the forge holds, with the scopes it needs; kept."
    return 0
  fi
  if [ -z "$current" ]; then reason="the Secret holds none"
  elif [ -z "$held" ]; then reason="the forge holds no token named '$TOKEN_NAME'"
  elif [ "${held%% *}" != "${current: -8}" ]; then reason="the forge's '$TOKEN_NAME' is not the delivered token"
  else reason="its scopes are now $TOKEN_SCOPES"
  fi

  # Removed by name before minting: the CLI refuses a name in use, and the replaced token must stop
  # working rather than pile up beside its successor. Gitea has no command that deletes a token.
  gitea_db "DELETE FROM access_token WHERE uid = $uid AND name = '$TOKEN_NAME';"
  # stdout is the token alone (--raw); the CLI's log lines go to stderr, kept in /tmp for a failure.
  set +e
  token=$(as_git gitea admin user generate-access-token --username "$user" --token-name "$TOKEN_NAME" \
    --scopes "$TOKEN_SCOPES" --raw 2>/tmp/generate.err)
  rc=$?
  set -e
  if [ $rc -ne 0 ] || ! printf '%s' "$token" | grep -Eq '^[0-9a-f]{40}$'; then
    cat /tmp/generate.err >&2
    die "Gitea did not mint a token for '$user' (exit $rc)."
  fi
  stored=$(gitea_db "SELECT scope FROM access_token WHERE uid = $uid AND name = '$TOKEN_NAME';")
  [ "$stored" = "$TOKEN_SCOPES" ] || die "Gitea stored the scopes as '$stored', not '$TOKEN_SCOPES'." \
    "TOKEN_SCOPES must be written in Gitea's order, or every boot mints a new token."

  kube PATCH "$path" "{\"data\":{\"token\":\"$(printf '%s' "$token" | base64 | tr -d '\n')\"}}" >/dev/null
  echo "[gitea-init] minted the platform's token ($reason) and wrote it into Secret '$GITEA_TOKEN_SECRET'."
  echo "[gitea-init] The functions pod reads it from its mount within about a minute."
}

if [ "$1" = "token" ]; then
  deliver_token
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# No argument: app.ini, the schema, the host key and the two accounts.
# ---------------------------------------------------------------------------------------------
if [ -z "$GITEA_ADMIN_USER" ] || [ -z "$GITEA_ADMIN_PASSWORD" ]; then
  echo '[gitea-init] GITEA_ADMIN_USER and GITEA_ADMIN_PASSWORD must both be set.' >&2
  echo '[gitea-init] Gitea would otherwise come up with its web installer locked and no account' >&2
  echo '[gitea-init] able to open it -- a forge nobody can log into, on a stack that reports healthy.' >&2
  exit 1
fi

# The server's own setup builds app.ini from the GITEA__section__KEY environment, so the two
# containers cannot disagree; re-running it is harmless. It chowns /data to git, which is why every
# gitea command after it runs as that user.
/etc/s6/gitea/setup
su-exec git gitea migrate

# The host key is public by construction (ssh-keyscan hands it to anyone). What makes it
# trustworthy is the channel: enroll-gateway returns it inside the TLS-authenticated enrolment
# response, so an appliance learns the forge's identity before its first clone and TOFU never
# happens. custom/public/ is served at /assets/, measured. ed25519 only: it is what bootstrap.mjs
# generates, so one line is a complete answer.
HOST_KEY_SRC=/data/ssh/ssh_host_ed25519_key.pub
HOST_KEY_DST=/data/gitea/public/assets/ssh_host_key.pub

# The image generates host keys when sshd starts, in the server container after this one has
# exited; calling its setup here means a fresh volume has a key to publish.
if [ -x /etc/s6/openssh/setup ]; then
  /etc/s6/openssh/setup
fi

if [ -f "$HOST_KEY_SRC" ]; then
  # Copying a PRIVATE key into a directory served over HTTP is the one mistake here that would matter.
  if head -c 11 "$HOST_KEY_SRC" | grep -q '^ssh-ed25519'; then
    mkdir -p "$(dirname "$HOST_KEY_DST")"
    cp "$HOST_KEY_SRC" "$HOST_KEY_DST"
    chmod 644 "$HOST_KEY_DST"
    echo "[gitea-init] published the SSH host key at /assets/ssh_host_key.pub for appliance known_hosts."
  else
    echo "[gitea-init] $HOST_KEY_SRC does not look like an ed25519 PUBLIC key; refusing to publish it." >&2
    echo '[gitea-init] Serving a private key over HTTP is the one failure worth stopping for.' >&2
    exit 1
  fi
else
  # Not fatal: the forge still serves HTTP, so only newly enrolling appliances are affected, and
  # they decline to converge rather than trust an unverified forge.
  echo "[gitea-init] no host key at $HOST_KEY_SRC and none could be generated, so none was" >&2
  echo '[gitea-init] published. Gateways enrolling now will get no known_hosts entry and will not' >&2
  echo '[gitea-init] converge until this container is restarted with a writable /data.' >&2
fi

# Idempotent by inspection: "already exists" is the ordinary state of every boot after the first;
# every other non-zero exit keeps failing.
create_admin() {
  set +e
  OUT=$(su-exec git gitea admin user create --admin \
    --username "$1" --password "$2" --email "$3" --must-change-password=false 2>&1)
  RC=$?
  set -e

  if [ $RC -eq 0 ]; then
    echo "[gitea-init] created the admin account '$1'."
  elif echo "$OUT" | grep -qi 'already exists'; then
    echo "[gitea-init] admin account '$1' already exists; left alone."
  else
    echo "$OUT" >&2
    die "refusing to report success: creating '$1' failed for a reason" \
      "other than the account already existing."
  fi
}

# The machine account is a bot: it holds no password, cannot sign in to the web UI, and no
# reverse-proxy header names it in. An account an earlier release made as a person, with a
# password, is converted in place; the password it still stores no longer signs in. Type 0 is a
# person and 4 a bot in Gitea's `user` table.
ensure_bot() {
  user=$(machine_user)
  type=$(gitea_db "SELECT type FROM user WHERE lower_name = lower('$user');")
  case "$type" in
    "")
      set +e
      OUT=$(su-exec git gitea admin user create --user-type bot --username "$user" --email "$1" 2>&1)
      RC=$?
      set -e
      [ $RC -eq 0 ] || { echo "$OUT" >&2; die "creating the bot account '$user' failed."; }
      echo "[gitea-init] created the bot account '$user'." ;;
    4)
      echo "[gitea-init] bot account '$user' already exists; left alone." ;;
    0)
      set +e
      OUT=$(su-exec git gitea admin user change-type --username "$user" --user-type Bot 2>&1)
      RC=$?
      set -e
      [ $RC -eq 0 ] || { echo "$OUT" >&2; die "converting '$user' to a bot failed. A site administrator" \
        "cannot be a bot: if someone made '$user' one, take that away first."; }
      echo "[gitea-init] converted '$user' to a bot; its password no longer signs in." ;;
    *)
      die "'$user' is neither a person's account nor a bot (type $type), so it is left alone and" \
        "the forge is not started. gitea.machineUser must name an account the platform may own." ;;
  esac
}

create_admin "$GITEA_ADMIN_USER" "$GITEA_ADMIN_PASSWORD" "$GITEA_ADMIN_EMAIL"

# Optional: an empty name is a deployment without the forge integration, and enroll-gateway behaves
# as it did before the forge existed. Not an admin: it owns the per-gateway repositories and
# nothing more, and its token is held by functions reachable from the network.
if [ -n "$GITEA_MACHINE_USER" ]; then
  ensure_bot "${GITEA_MACHINE_EMAIL:-aber-platform@aber.invalid}"
else
  echo '[gitea-init] GITEA_MACHINE_USER is empty, so there is no machine account and the platform'
  echo '[gitea-init] will not create gateway repositories. This is a deployment choice, not a fault;'
  echo '[gitea-init] set gitea.machineUser to enable it.'
fi
