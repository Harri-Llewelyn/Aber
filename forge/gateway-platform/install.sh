#!/bin/bash
# Aber gateway appliance installer.
#
# Served by the platform's gateway-install function to the command the dashboard shows, which has
# already fetched the platform's root over plain HTTP, checked it against the pin the dashboard
# minted beside the token, and installed it; everything this script fetches is over TLS that pin
# has verified. The token arrives as ABER_ENROLMENT_TOKEN in the environment, never in this text.
#
# INSTALL FIRST, ENROL LAST. Packages, Docker and the playbook take minutes and can fail; every
# step before enrolment is idempotent and can be re-run with the same command, and the token is
# spent only by the enrolment that also writes the broker credential. The body is one function
# invoked on the last line, so a truncated download runs nothing.
#
# __PLATFORM_URL__ and __PUBLISHABLE_KEY__ are substituted by the platform when it serves this;
# both are public. __GATEWAY_NAME__ and __SPARKPLUG_ID__ say which gateway the token was minted for.

aber_install() {
  set -euo pipefail

  local PLATFORM_URL="__PLATFORM_URL__"
  local PUBLISHABLE_KEY="__PUBLISHABLE_KEY__"
  local GATEWAY="__GATEWAY_NAME__ (__SPARKPLUG_ID__)"
  local TOKEN="${ABER_ENROLMENT_TOKEN:-}"
  local PIN="${ABER_CA_PIN:-}"
  local STATE_DIR="${ABER_STATE_DIR:-/var/lib/aber-gateway}"
  local DATA_DIR="$STATE_DIR/data"
  local COMPOSE_DIR="/opt/aber-gateway"
  local WORK_DIR="$STATE_DIR/install"
  # Where stage 0 installed the root it checked against the pin. Must agree with installCommand()
  # in gateway-bundle.
  local HOST_ROOT="/usr/local/share/ca-certificates/aber.crt"

  say() { echo "[aber-gateway-install] $*"; }
  die() { echo "[aber-gateway-install] FAILED: $*" >&2; exit 1; }
  fetch() {
    # $1 query, $2 destination. The apikey passes the platform's key check; the token authorises.
    curl -fsSL -H "apikey: $PUBLISHABLE_KEY" -H "X-Enrolment-Token: $TOKEN" \
      "$PLATFORM_URL/functions/v1/gateway-install$1" -o "$2"
  }
  # The pin of a PEM, as stage 0 computes it.
  pin_of() {
    openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64
  }

  [ "$(id -u)" -eq 0 ] || die "run as root: the command the dashboard shows ends in 'sudo ... bash'"
  [ -n "$TOKEN" ] || die "ABER_ENROLMENT_TOKEN is not set; paste the whole command the dashboard shows"
  command -v curl >/dev/null || die "curl is not installed"

  if [ -f "$DATA_DIR/.enrolled.json" ]; then
    die "this appliance is already enrolled ($(jq -r '.sparkplug_id // "?"' "$DATA_DIR/.enrolled.json" 2>/dev/null)); refusing to run again. To start over, remove $DATA_DIR and $COMPOSE_DIR and re-issue the command."
  fi

  say "installing $GATEWAY from $PLATFORM_URL"
  mkdir -p "$STATE_DIR" "$WORK_DIR"
  chmod 750 "$STATE_DIR"

  # 1. What the playbook itself needs to run. The playbook installs everything else.
  say "1/5 packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git jq python3 python3-yaml ansible-core >/dev/null

  # 2. The platform playbook, from the platform (the forge refuses anonymous reads, and this
  #    appliance has no key until it enrols). The same content the tag in the forge carries.
  say "2/5 the platform playbook"
  fetch "?file=platform.zip" "$WORK_DIR/platform.zip"
  rm -rf "$WORK_DIR/platform"
  python3 -m zipfile -e "$WORK_DIR/platform.zip" "$WORK_DIR/platform"
  [ -f "$WORK_DIR/platform/site.yml" ] || die "the platform playbook did not unpack"

  # 3. Converge the host: packages, upgrades, chrony, Docker, the compose project and the timer.
  #    No .env yet, so the project is laid down and not started.
  say "3/5 the platform playbook (this takes a few minutes the first time)"
  ( cd "$WORK_DIR/platform" && ANSIBLE_LOCALHOST_WARNING=false ansible-playbook -i localhost, site.yml )

  # 4. The appliance's .env: written once. A second run keeps the one it has, because the
  #    credential secret in it is what will encrypt the broker password.
  say "4/5 the appliance's .env and the platform's root"
  if [ ! -f "$COMPOSE_DIR/.env" ]; then
    fetch "?file=env" "$COMPOSE_DIR/.env.tmp"
    chmod 600 "$COMPOSE_DIR/.env.tmp"
    mv "$COMPOSE_DIR/.env.tmp" "$COMPOSE_DIR/.env"
  else
    say "keeping the .env already at $COMPOSE_DIR/.env"
  fi
  #    The root, beside the compose project, for bootstrap's container (NODE_EXTRA_CA_CERTS): it
  #    trusts Node's bundled roots and not this host's store. Empty when the command pinned none.
  if [ -n "$PIN" ]; then
    [ -f "$HOST_ROOT" ] || die "$HOST_ROOT is missing; paste the whole command the dashboard shows, which installs it"
    [ "$(pin_of "$HOST_ROOT")" = "$PIN" ] || die "$HOST_ROOT does not match the pin; paste the whole command the dashboard shows"
    install -m 644 "$HOST_ROOT" "$COMPOSE_DIR/platform-root.pem"
  else
    install -m 644 /dev/null "$COMPOSE_DIR/platform-root.pem"
  fi

  # 5. Enrol: build the appliance image, run bootstrap once (it spends the token and writes the
  #    broker credential, the deploy key and the forge's host key under /data), start Node-RED.
  say "5/5 enrolment"
  ( cd "$COMPOSE_DIR" && docker compose up -d --build )
  ( cd "$COMPOSE_DIR" && docker compose wait bootstrap >/dev/null ) || true
  if [ ! -f "$DATA_DIR/.enrolled.json" ]; then
    ( cd "$COMPOSE_DIR" && docker compose logs --no-log-prefix bootstrap ) >&2 || true
    die "enrolment did not complete; the bootstrap log above says why. If the token was refused, re-issue the command from the dashboard; otherwise fix what it names and run the same command again."
  fi

  # The root the appliance enrolled with, against the pin the dashboard minted. The broker's root
  # and the API's are allowed to differ, and this one arrived over TLS the pin already verified,
  # so a difference is noted rather than refused.
  if [ -n "$PIN" ] && [ -f "$DATA_DIR/certs/ca.crt" ] && command -v openssl >/dev/null; then
    if [ "$(pin_of "$DATA_DIR/certs/ca.crt")" = "$PIN" ]; then
      say "the broker's root is the pinned root"
    else
      say "NOTE: the broker's root differs from the pinned root; both arrived over verified channels, and this deployment may issue the two from different roots"
    fi
  fi

  # The first convergence from the forge, with the key enrolment just registered. Not fatal: the
  # timer the playbook installed tries again within the hour.
  if command -v aber-gateway-converge >/dev/null; then
    say "converging from the forge"
    aber-gateway-converge || say "the first convergence from the forge failed; the timer retries hourly, and journalctl -u aber-gateway-converge says why"
  fi

  say "done. The Node-RED editor password was printed ONCE above, by bootstrap; the gateway shows ONLINE in the dashboard within a minute."
  ( cd "$COMPOSE_DIR" && docker compose logs --no-log-prefix bootstrap 2>/dev/null | grep -A 4 "NODE-RED EDITOR LOGIN" ) || true
}

aber_install "$@"
