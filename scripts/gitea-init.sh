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
# The MACHINE ACCOUNT is what the platform authenticates as -- roadmap 7's "one machine account" --
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
  echo '[gitea-init] not a fault -- see docs/roadmap.md 7.'
fi
