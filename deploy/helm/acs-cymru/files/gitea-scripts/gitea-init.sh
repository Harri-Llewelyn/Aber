#!/bin/bash
# =================================================================================================
# Gitea provisioning, run before the server starts, on both deployment targets.
#
# ONE FILE, MIRRORED, because it used to be two. Compose bind-mounts it into a one-shot service and
# the chart projects it through a ConfigMap onto an initContainer -- the same arrangement
# node-red-init.mjs has, and for the same reason: this is provisioning POLICY (which accounts exist,
# and what they may do), and policy that lives in two hand-copied shell blocks drifts. See
# scripts/sync-helm-chart-files.mjs, which fails CI if the chart's copy falls behind this one.
#
# -------------------------------------------------------------------------------------------------
# IT CALLS THE IMAGE'S OWN SETUP RATHER THAN WRITING app.ini ITSELF.
#
# Every `gitea` subcommand refuses to run without a config file -- the error names `--config` and
# reads as a broken image. /etc/s6/gitea/setup is what the SERVER runs to build one from the
# GITEA__section__KEY environment, so calling it here means the two containers cannot disagree about
# what they built. Re-running it is harmless: the template is expanded only when app.ini is absent,
# and environment-to-ini merges into it rather than replacing it.
#
# ROOT, THEN su-exec. The setup script chowns /data to the `git` user, which is the whole reason the
# server can read what this wrote; every gitea command after it runs AS that user, so nothing in the
# database or the repository tree ends up owned by root.
#
# -------------------------------------------------------------------------------------------------
# TWO ACCOUNTS, AND THE SECOND ONE IS THE POINT.
#
# The ADMINISTRATOR exists because `INSTALL_LOCK` closes the web installer: a forge on a plant
# network would otherwise be one HTTP request away from anybody making themselves its admin. It is
# for a human, rarely.
#
# The MACHINE ACCOUNT is what the platform authenticates as -- the platform's one machine account --
# and it is deliberately NOT an admin. It owns the per-gateway repositories, which is all the
# authority it needs to create one and attach a read-only deploy key to it. An admin token here
# would be able to read and rewrite every repository in the forge, including the platform playbook
# the whole fleet converges to, and it would be held by an edge function reachable from the network.
#
# IDEMPOTENT BY INSPECTION, not by `|| true`. Creating an account that already exists is the
# ordinary state of every boot after the first and exits non-zero; every OTHER non-zero exit -- an
# unwritable volume, a corrupt database -- has to keep failing. Swallowing the code would report
# both as provisioned.
# =================================================================================================
set -e

if [ -z "$GITEA_ADMIN_USER" ] || [ -z "$GITEA_ADMIN_PASSWORD" ]; then
  echo '[gitea-init] GITEA_ADMIN_USER and GITEA_ADMIN_PASSWORD must both be set.' >&2
  echo '[gitea-init] Gitea would otherwise come up with its web installer locked and no account' >&2
  echo '[gitea-init] able to open it -- a forge nobody can log into, on a stack that reports healthy.' >&2
  exit 1
fi

/etc/s6/gitea/setup
su-exec git gitea migrate

# -------------------------------------------------------------------------------------------------
# PUBLISH THE SSH HOST KEY, so an appliance can VERIFY this forge instead of trusting it on sight.
#
# THE PROBLEM THIS SOLVES. A gateway clones over SSH with its deploy key. With no `known_hosts` entry
# it must either accept whatever key answers on the first connection -- trust on first use, which is
# exactly the moment an attacker would choose -- or be told to skip verification, which this platform
# refuses outright. Neither is acceptable for a machine that will pull unattended for years.
#
# THE HOST KEY IS PUBLIC BY CONSTRUCTION. Anyone who can open a TCP connection to port 22 is handed
# it during the handshake; that is what `ssh-keyscan` does. Publishing it changes nothing about its
# secrecy, and it is the PRIVATE half in the same directory that matters -- which is why only the
# `.pub` is copied and why this refuses to run if that distinction ever blurs.
#
# WHAT MAKES IT TRUSTWORTHY IS THE CHANNEL IT ARRIVES ON, NOT THE FILE. `enroll-gateway` reads this
# over the internal network and returns it inside the enrolment response -- which the appliance
# already fetches over TLS, authenticated by a single-use token bound to one gateway row. So the
# appliance learns the forge's identity from the platform it already trusts, before its first clone,
# and TOFU never happens. An appliance fetching this URL directly would be back to trusting the
# network, so nothing in the bundle does.
#
# /data/gitea IS GITEA'S CUSTOM DIRECTORY, and `custom/public/` is served at `/assets/`. Measured
# against the running forge rather than assumed: the file appears at /assets/ssh_host_key.pub with no
# restart, which also means a rotated host key is republished by the next boot of this script.
#
# ED25519 ONLY, of the three sshd offers. `ssh` negotiates a host key algorithm it has a known key
# for, so one line is a complete answer rather than a partial one -- and ed25519 is what
# bootstrap.mjs generates its own key as, so an appliance needs no second algorithm anywhere.
#
# IT CALLS THE IMAGE'S OWN openssh SETUP FIRST, for exactly the reason it calls gitea's above. The
# host keys are generated by /etc/s6/openssh/setup, which runs when the SSHD SERVICE starts -- in
# the server container, after this one has already exited. On a fresh volume that ordering means
# there is no key here to publish, and every appliance enrolling before the next restart would get
# none. Calling it is idempotent (it generates only what is missing) and it is the same script the
# server will run, so the key published here is the key sshd will present.
# -------------------------------------------------------------------------------------------------
HOST_KEY_SRC=/data/ssh/ssh_host_ed25519_key.pub
HOST_KEY_DST=/data/gitea/public/assets/ssh_host_key.pub

if [ -x /etc/s6/openssh/setup ]; then
  /etc/s6/openssh/setup
fi

if [ -f "$HOST_KEY_SRC" ]; then
  # A .pub that does not start with the algorithm name is not a public key, and copying a PRIVATE
  # key into a directory served over unauthenticated HTTP is the one mistake here that would matter.
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
  # NOT FATAL, and the distinction is worth keeping: a forge with no host key still serves HTTP, so
  # the dashboard, the proposals and every existing appliance are unaffected. What is lost is new
  # appliances, which enrol with no known_hosts entry and decline to converge rather than trusting
  # an unverified forge. Stated rather than hidden, because nothing else would say so.
  echo "[gitea-init] no host key at $HOST_KEY_SRC and none could be generated, so none was" >&2
  echo '[gitea-init] published. Gateways enrolling now will get no known_hosts entry and will not' >&2
  echo '[gitea-init] converge until this container is restarted with a writable /data.' >&2
fi

# create_account <username> <password> <email> <admin|standard>
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

# -------------------------------------------------------------------------------------------------
# THE MACHINE ACCOUNT IS OPTIONAL, AND ITS ABSENCE IS A DEPLOYMENT WITHOUT THE FORGE INTEGRATION --
# not a broken one.
#
# `enroll-gateway` creates a gateway's repository and registers its deploy key only when it holds
# these same credentials; unset at both ends means enrolment behaves exactly as it did before the
# forge existed, and says so in its response rather than half-failing. Setting the password at one
# end and not the other is the case worth being loud about, so the platform logs what it could not
# reach rather than silently skipping.
# -------------------------------------------------------------------------------------------------
if [ -n "$GITEA_MACHINE_PASSWORD" ]; then
  create_account "${GITEA_MACHINE_USER:-acs_platform}" "$GITEA_MACHINE_PASSWORD" \
    "${GITEA_MACHINE_EMAIL:-acs-platform@acs-cymru.invalid}" standard
else
  echo '[gitea-init] GITEA_MACHINE_PASSWORD is unset, so no machine account was created and the'
  echo '[gitea-init] platform will not create gateway repositories. This is a deployment choice,'
  echo '[gitea-init] not a fault; set GITEA_MACHINE_PASSWORD to enable it.'
fi
