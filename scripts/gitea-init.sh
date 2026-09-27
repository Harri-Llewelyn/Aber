#!/bin/bash
# Gitea provisioning, run by the chart's initContainer before the server starts, from a mirror of
# this file. It calls the image's own setup rather than writing app.ini, runs as root and then as
# git, creates the administrator (INSTALL_LOCK closes the web installer) and, when a password is
# set, the non-admin machine account the platform authenticates as, and publishes the SSH host key
# so an appliance can verify this forge instead of trusting it on first use. Idempotent by
# inspection, never by `|| true`. Reasoning: forge/README.md, "Provisioning the server".
set -e

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
create_account() {
  account_user="$1"
  account_password="$2"
  account_email="$3"
  account_kind="$4"

  set +e
  if [ "$account_kind" = "admin" ]; then
    OUT=$(su-exec git gitea admin user create --admin \
      --username "$account_user" --password "$account_password" --email "$account_email" \
      --must-change-password=false 2>&1)
  else
    OUT=$(su-exec git gitea admin user create \
      --username "$account_user" --password "$account_password" --email "$account_email" \
      --must-change-password=false 2>&1)
  fi
  RC=$?
  set -e

  if [ $RC -eq 0 ]; then
    echo "[gitea-init] created the $account_kind account '$account_user'."
  elif echo "$OUT" | grep -qi 'already exists'; then
    echo "[gitea-init] $account_kind account '$account_user' already exists; left alone."
  else
    echo "$OUT" >&2
    echo "[gitea-init] refusing to report success: creating '$account_user' failed for a reason" >&2
    echo "[gitea-init] other than the account already existing." >&2
    exit 1
  fi
}

create_account "$GITEA_ADMIN_USER" "$GITEA_ADMIN_PASSWORD" "$GITEA_ADMIN_EMAIL" admin

# Optional: unset is a deployment without the forge integration, and enroll-gateway behaves as it
# did before the forge existed. Not an admin: it owns the per-gateway repositories and nothing more,
# and it is held by a function reachable from the network.
if [ -n "$GITEA_MACHINE_PASSWORD" ]; then
  create_account "${GITEA_MACHINE_USER:-aber_platform}" "$GITEA_MACHINE_PASSWORD" \
    "${GITEA_MACHINE_EMAIL:-aber-platform@aber.invalid}" standard
else
  echo '[gitea-init] GITEA_MACHINE_PASSWORD is unset, so no machine account was created and the'
  echo '[gitea-init] platform will not create gateway repositories. This is a deployment choice,'
  echo '[gitea-init] not a fault; set GITEA_MACHINE_PASSWORD to enable it.'
fi
