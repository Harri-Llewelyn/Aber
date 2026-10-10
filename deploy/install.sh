#!/bin/sh
# Aber's server installer: from a fresh Ubuntu machine to a running site and its first administrator.
#
#   curl -sfL https://raw.githubusercontent.com/Harri-Llewelyn/Aber/v<version>/deploy/install.sh | sudo sh -
#   ... | sudo sh -s -- --domain=aber.plant.example --admin-email=you@plant.example --site-name=plant1 --yes
#
# It does what docs/install.md *Run it on a site* does by hand (steps 2 and 4 to 8); `--help` lists
# the flags. Every step skips what an earlier run finished, so running it again resumes an
# interrupted install or upgrades a finished one. Answers and credentials are kept in /etc/aber.
#
# The body is functions called on the last line, so a truncated download runs nothing. stdin is
# this script when it is piped, so questions read /dev/tty and every command reads /dev/null.
# POSIX sh (Ubuntu's dash): no `local`, no pipefail, so downloads land in a file before they run.

# The release this file belongs to and installs, and the cert-manager it applies. check-docs-drift
# holds them to Chart.yaml's `version:`, the installer URL in docs/install.md, and step 4's pin.
ABER_VERSION=1.2.0
CERT_MANAGER_VERSION=v1.16.2

REPO_URL=https://github.com/Harri-Llewelyn/Aber
CHART=oci://ghcr.io/harri-llewelyn/aber/aber
ETC=/etc/aber
VALUES=$ETC/values-local.yaml
SITE=$ETC/site.yaml
CA_FILE=$ETC/aber-ca.crt
K3S_CONFIG=/etc/rancher/k3s/k3s.yaml
# The forge's SSH port, which `npm run setup` writes into the values file so the machine keeps 22.
FORGE_SSH_PORT=2222
# The minimum (docs/install.md) as a machine reports it: one sold with 8 GiB shows a little less
# in /proc/meminfo, and a 100 GiB disk a little less in df once partitioned and formatted.
MIN_CPUS=4
MIN_MEMORY_KIB=7864320   # 7.5 GiB
MIN_DISK_KIB=94371840    # 90 GiB
# The chart's kubeVersion floor and the oldest Helm that installs from an OCI registry. Node.js
# older than MIN_NODE is replaced with NodeSource's 24, as docs/install.md step 2 installs.
MIN_K3S=1.25
MIN_HELM=3.8
MIN_NODE=20.0

say() { printf '%s\n' "$*"; }
warn() { printf '\nWARNING: %s\n' "$*" >&2; }
die() {
  printf '\nSTOPPED: %s\n' "$*" >&2
  exit 1
}
step() {
  STEP=$((STEP + 1))
  printf '\n[%s/8] %s\n' "$STEP" "$*"
}
kc() { k3s kubectl "$@"; }

# Runs a command, or only prints it on a dry run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$1" = kc ]; then shift && say "  would run: kubectl $*"; else say "  would run: $*"; fi
    return 0
  fi
  "$@"
}

# Downloads an installer script, then runs it with $2. A failed download stops here, where
# `curl | sh` would run nothing and report success.
run_remote() {
  if [ "$DRY_RUN" = 1 ]; then
    say "  would run: curl -fsSL $1 | $2 -"
    return 0
  fi
  rr_file=$WORK/$(basename "$1")
  curl -fsSL "$1" -o "$rr_file" || die "could not download $1. Check that this machine can reach it, then run this again."
  "$2" "$rr_file" || die "$1 failed. Its messages are above: fix what they name, then run this again."
}

# Whether MAJOR.MINOR[.PATCH] $1 is at least MAJOR.MINOR $2.
version_at_least() {
  va_major=${1%%.*}
  va_minor=${1#*.}
  va_minor=${va_minor%%.*}
  vb_major=${2%%.*}
  vb_minor=${2#*.}
  [ "$va_major" -gt "$vb_major" ] || { [ "$va_major" -eq "$vb_major" ] && [ "$va_minor" -ge "$vb_minor" ]; }
}

# KiB as GiB to one decimal, rounded down so a figure just under a floor never prints as the floor.
gib() { awk -v k="$1" 'BEGIN { printf "%.1f", int(k * 10 / 1048576) / 10 }'; }

# The value of the first `key: value` line in file $1, quotes removed.
yaml_value() {
  sed -n "s/^[[:space:]]*$2:[[:space:]]*[\"']\{0,1\}\([^\"'#]*[^\"'#[:space:]]\)[\"']\{0,1\}[[:space:]]*\(#.*\)\{0,1\}\$/\1/p" "$1" | head -n 1
}

usage() {
  cat <<EOF
Installs Aber $ABER_VERSION on this machine: k3s, Helm and Node.js where they are missing, then Aber.

  curl -sfL https://raw.githubusercontent.com/Harri-Llewelyn/Aber/v$ABER_VERSION/deploy/install.sh | sudo sh -s -- [flags]

Answers, asked on the terminal when a flag does not give them:
  --domain=NAME          the domain every part of Aber is published under, such as aber.plant.example
  --admin-email=EMAIL    the first administrator's email
  --site-name=NAME       a short name for the site, such as plant1; it can never change
  --address=IPV4         this machine's address on the site network, which gateways connect to
  --base-iri=URL         the start of every asset id; permanent once an asset shell is exported

Other flags:
  --yes, -y              accept the suggested address and base IRI, and do not ask to continue
  --dry-run              run every check and question, then print what would run; change nothing
  --source-dir=DIR       use a checkout of Aber instead of downloading the release
                         (or set ABER_SOURCE_DIR)
  --skip-hardware-check  carry on below the minimum machine size; for testing only
  --help, -h             show this

The guide: $REPO_URL/blob/v$ABER_VERSION/docs/install.md
EOF
}

parse_args() {
  for arg in "$@"; do
    case $arg in
      --domain=*) F_DOMAIN=${arg#*=} ;;
      --admin-email=*) F_EMAIL=${arg#*=} ;;
      --site-name=*) F_SITE=${arg#*=} ;;
      --address=*) F_ADDRESS=${arg#*=} ;;
      --base-iri=*) F_IRI=${arg#*=} ;;
      --source-dir=*) SOURCE_DIR=${arg#*=} ;;
      --yes | -y) YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --skip-hardware-check) SKIP_HARDWARE=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) die "'$arg' is not a flag this installer knows. --help lists them." ;;
    esac
  done
}

# --- Checks: each reads, none changes anything ------------------------------------------------

os_field() { sed -n "s/^$1=//p" /etc/os-release 2>/dev/null | tr -d '"' | head -n 1; }

check_platform() {
  [ "$(id -u)" -eq 0 ] || die "run this as root: pipe it to 'sudo sh -', as docs/install.md shows."
  cp_id=$(os_field ID)
  cp_version=$(os_field VERSION_ID)
  cp_name=$(os_field PRETTY_NAME)
  cp_arch=$(uname -m)
  case "$cp_id $cp_version $cp_arch" in
    "ubuntu 22.04 x86_64" | "ubuntu 24.04 x86_64") ;;
    *) die "this installer supports Ubuntu 22.04 and 24.04 on amd64 (x86_64).
This machine runs ${cp_name:-an unknown system} on $cp_arch.
On another Linux, follow the numbered steps in docs/install.md by hand." ;;
  esac
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed. Install it with 'sudo apt-get install -y $tool', then run this again."
  done
  say "  System     $cp_name on $cp_arch"
}

check_hardware() {
  hw_cpus=$(nproc)
  hw_memory=$(awk '$1 == "MemTotal:" { print $2 }' /proc/meminfo)
  # k3s keeps its images and every volume under /var/lib/rancher; before it exists, the
  # filesystem it will be created on.
  hw_dir=/var/lib/rancher
  while [ ! -d "$hw_dir" ]; do hw_dir=$(dirname "$hw_dir"); done
  hw_disk=$(df -Pk "$hw_dir" | awk 'NR == 2 { print $2 }')
  hw_mount=$(df -Pk "$hw_dir" | awk 'NR == 2 { print $6 }')

  hw_short=
  hw_cpu_note=ok
  hw_memory_note=ok
  hw_disk_note=ok
  if [ "$hw_cpus" -lt "$MIN_CPUS" ]; then
    hw_cpu_note="too few: Aber needs $MIN_CPUS"
    hw_short=1
  fi
  if [ "$hw_memory" -lt "$MIN_MEMORY_KIB" ]; then
    hw_memory_note="too little: Aber needs 8 GiB"
    hw_short=1
  fi
  if [ "$hw_disk" -lt "$MIN_DISK_KIB" ]; then
    hw_disk_note="too small: Aber needs 100 GiB"
    hw_short=1
  fi
  printf '  %-10s %-32s %s\n' "CPU cores" "$hw_cpus" "$hw_cpu_note"
  printf '  %-10s %-32s %s\n' "Memory" "$(gib "$hw_memory") GiB" "$hw_memory_note"
  printf '  %-10s %-32s %s\n' "Disk" "$(gib "$hw_disk") GiB on $hw_mount" "$hw_disk_note"
  [ -n "$hw_short" ] || return 0

  if [ "$SKIP_HARDWARE" = 1 ]; then
    warn "--skip-hardware-check: carrying on below the minimum of $MIN_CPUS CPU cores, 8 GiB of memory
and 100 GiB of disk. Parts of Aber may never start: they wait as Pending, with nothing in any log.
Use this flag for testing only."
    return 0
  fi
  hw_hint=
  if [ "$hw_disk_note" != ok ]; then
    hw_hint="
If the disk is bigger than $hw_mount shows, Ubuntu's installer may have left the rest unused:
'sudo vgs' shows any free space. On Ubuntu's default layout this grows $hw_mount into it:
  sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv"
  fi
  die "this machine is smaller than Aber needs (the lines above say which part).
On a smaller machine parts of Aber never start. Use a machine with at least $MIN_CPUS CPU cores,
8 GiB of memory and 100 GiB of disk under $hw_mount.$hw_hint"
}

# Whether something listens on TCP port $1; sets PORT_HOLDER to who. Read from /proc, which needs
# no package the machine may lack.
port_listener() {
  pl_hex=$(printf '%04X' "$1")
  pl_files=
  for pl_file in /proc/net/tcp /proc/net/tcp6; do
    if [ -r "$pl_file" ]; then pl_files="$pl_files $pl_file"; fi
  done
  # shellcheck disable=SC2086 # one word per file
  pl_inode=$(awk -v port="$pl_hex" 'FNR > 1 && $4 == "0A" {
      n = split($2, a, ":"); if (toupper(a[n]) == port) { print $10; exit } }' $pl_files)
  [ -n "$pl_inode" ] || return 1
  pl_fd=$(find /proc/[0-9]*/fd -maxdepth 1 -lname "socket:\\[$pl_inode\\]" 2>/dev/null | head -n 1)
  pl_pid=$(printf '%s' "$pl_fd" | cut -d/ -f3)
  if [ -n "$pl_pid" ]; then
    PORT_HOLDER="$(cat "/proc/$pl_pid/comm" 2>/dev/null || echo unknown) (process $pl_pid)"
  else
    PORT_HOLDER="a process this installer cannot name (socket $pl_inode)"
  fi
}

check_forge_port() {
  if port_listener "$FORGE_SSH_PORT"; then
    die "port $FORGE_SSH_PORT is in use, by $PORT_HOLDER.
Aber's forge serves git over SSH to gateways on port $FORGE_SSH_PORT, and k3s gives it that port on
this machine's address. Whatever listens there now would stop being reachable.
Move it to another port, then run this again. If it is this machine's own SSH, moved there by an
older version of docs/install.md, it can go back to port 22: Aber leaves that port alone."
  fi
  say "  Port $FORGE_SSH_PORT  free for the forge"
}

check_existing_install() {
  if [ -f "$VALUES" ]; then RERUN=1; fi
  if command -v k3s >/dev/null 2>&1 && kc get --raw /readyz >/dev/null 2>&1; then CLUSTER_UP=1; fi
  if [ "$CLUSTER_UP" = 0 ] || [ "$RERUN" = 1 ]; then return 0; fi
  if command -v helm >/dev/null 2>&1 && helm status aber -n aber >/dev/null 2>&1; then
    die "Aber is already installed on this cluster, but not by this installer: $VALUES does not exist.
Running it would give every part of Aber new passwords that its databases do not know.
Upgrade it as the runbook says (deploy/k8s/README.md, Upgrade / uninstall). Or copy its values
file to $VALUES and its site.yaml to $SITE, then run this again."
  fi
}

# --- The five questions ---------------------------------------------------------------------
# Each check sets CHECKED to the value as it will be used, or REASON to why it cannot be.

check_domain() {
  CHECKED=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case $CHECKED in
    '') REASON="give a domain, such as aber.plant.example." ;;
    *://* | */* | *:*) REASON="'$1' is a web address or has a port. Give the domain alone, such as aber.plant.example." ;;
    localhost | *.localhost) REASON="'$1' names this machine only, so gateways could not reach it. Give a domain on the site's DNS." ;;
    *[!0-9.]*)
      case $CHECKED in
        *[!a-z0-9.-]* | .* | *. | *..* | -* | *- | *.-* | *-.*) REASON="'$1' is not a domain name." ;;
        *.*) return 0 ;;
        *) REASON="'$1' has no dot. Give the whole domain, such as aber.plant.example." ;;
      esac
      ;;
    *) REASON="'$1' is an address. Give a domain name, such as aber.plant.example." ;;
  esac
  return 1
}

check_email() {
  CHECKED=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case $CHECKED in
    *[[:space:]\"\\]* | *@*@* | @* | *@) ;;
    *@*) return 0 ;;
  esac
  REASON="'$1' is not an email address."
  return 1
}

check_site_name() {
  CHECKED=$1
  case $1 in
    '') REASON="give a short name, such as plant1." ;;
    *[!A-Za-z0-9._-]*) REASON="'$1' has a character a site name cannot use. Use letters, digits, '.', '_' and '-'." ;;
    [!A-Za-z0-9]*) REASON="'$1' must start with a letter or a digit." ;;
    *) return 0 ;;
  esac
  return 1
}

check_address() {
  CHECKED=$1
  REASON="'$1' is not an IPv4 address, such as 10.20.0.50."
  case $1 in '' | *[!0-9.]* | .* | *. | *..*) return 1 ;; esac
  ca_rest=$1
  ca_count=0
  while [ -n "$ca_rest" ]; do
    ca_octet=${ca_rest%%.*}
    case $ca_rest in
      *.*) ca_rest=${ca_rest#*.} ;;
      *) ca_rest= ;;
    esac
    ca_count=$((ca_count + 1))
    if [ "${#ca_octet}" -gt 3 ] || [ "$ca_octet" -gt 255 ]; then return 1; fi
  done
  [ "$ca_count" -eq 4 ] || return 1
  case $1 in
    127.* | 0.*)
      REASON="'$1' is not an address other machines can reach. Give this machine's address on the site network."
      return 1
      ;;
  esac
}

check_base_iri() {
  CHECKED=$1
  case $1 in
    *[[:space:]\"\\]*)
      REASON="'$1' has a space, a quote or a backslash in it."
      return 1
      ;;
    http://?* | https://?*) ;;
    *)
      REASON="'$1' is not a web address. Give one such as https://plant.example/ids/asset/."
      return 1
      ;;
  esac
  cb_host=${1#*://}
  cb_host=${cb_host%%/*}
  if [ -z "$cb_host" ]; then
    REASON="'$1' has no host name after the '//'."
    return 1
  fi
  case $1 in */) ;; *) CHECKED=$1/ ;; esac
}

# The source address of the route to the internet: the address other machines see this one at.
# Nothing is sent; `ip route get` only looks the route up.
detect_address() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'
  elif command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{ print $1 }'
  fi
}

# Asks $1 on the terminal, offering $2; sets ANSWER, which is $2 on an empty line.
ask() {
  if [ -n "$2" ]; then
    printf '%s [%s]: ' "$1" "$2" >/dev/tty
  else
    printf '%s: ' "$1" >/dev/tty
  fi
  IFS= read -r ANSWER </dev/tty || die "no answer was given."
  ANSWER=$(printf '%s' "$ANSWER" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -z "$ANSWER" ]; then ANSWER=$2; fi
}

# One answer, from (in order) what an earlier run saved, its flag, the default under --yes, or
# the terminal. Reads the Q_* variables; sets VALUE, or adds the flag to MISSING.
resolve() {
  VALUE=
  if [ "$Q_SAVED_IN" ]; then
    if [ -n "$Q_GIVEN" ]; then
      "$Q_CHECK" "$Q_GIVEN" || die "$Q_FLAG: $REASON"
      [ "$CHECKED" = "$Q_SAVED" ] || die "$Q_FLAG=$Q_GIVEN differs from '${Q_SAVED:-?}', which an earlier run saved in
$Q_SAVED_IN. Leave the flag out to keep the saved answer. To change it, edit that file, then run
this again. The site name and the base IRI are permanent once in use."
    fi
    VALUE=${Q_SAVED:-"(as in $Q_SAVED_IN)"}
    return 0
  fi
  if [ -n "$Q_GIVEN" ]; then
    "$Q_CHECK" "$Q_GIVEN" || die "$Q_FLAG: $REASON"
    VALUE=$CHECKED
    return 0
  fi
  if [ -n "$Q_DEFAULT" ] && [ "$YES" = 1 ]; then
    VALUE=$Q_DEFAULT
    return 0
  fi
  if [ "$HAVE_TTY" = 0 ]; then
    MISSING="$MISSING $Q_FLAG"
    return 0
  fi
  printf '\n%s\n' "$Q_TEXT"
  while :; do
    ask "$Q_PROMPT" "$Q_DEFAULT"
    if "$Q_CHECK" "$ANSWER"; then
      VALUE=$CHECKED
      return 0
    fi
    say "  $REASON"
  done
}

ask_questions() {
  HAVE_TTY=0
  if (: </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi

  S_DOMAIN=
  S_EMAIL=
  S_SITE=
  S_ADDRESS=
  S_IRI=
  VALUES_SAVED=
  SITE_SAVED=
  if [ -f "$VALUES" ]; then
    VALUES_SAVED=$VALUES
    S_DOMAIN=$(yaml_value "$VALUES" publicBaseDomain)
    S_EMAIL=$(yaml_value "$VALUES" email)
    if [ -z "$S_DOMAIN" ] || [ -z "$S_EMAIL" ]; then
      die "$VALUES has no global.publicBaseDomain or no supabaseAuth.firstAdministrator.email.
An earlier run of this installer writes both. Add the missing one to that file, then run this again."
    fi
  fi
  if [ -f "$SITE" ]; then
    SITE_SAVED=$SITE
    S_SITE=$(yaml_value "$SITE" primaryHostId)
    S_IRI=$(yaml_value "$SITE" baseIri)
    S_ADDRESS=$(sed -n 's/^[[:space:]]*extraIpSans:[[:space:]]*\[[[:space:]]*"\{0,1\}\([0-9.]*\).*/\1/p' "$SITE" | head -n 1)
  fi
  if [ -n "$VALUES_SAVED$SITE_SAVED" ]; then
    say ""
    say "Reusing the answers an earlier run saved in $ETC."
  fi

  Q_FLAG=--domain Q_GIVEN=$F_DOMAIN Q_SAVED=$S_DOMAIN Q_SAVED_IN=$VALUES_SAVED Q_DEFAULT='' Q_CHECK=check_domain
  Q_PROMPT=Domain
  Q_TEXT="Every part of Aber gets a name under one domain: the dashboard is app.<domain>.
Browsers and gateways on the site must be able to look these names up."
  resolve
  DOMAIN=$VALUE

  Q_FLAG=--admin-email Q_GIVEN=$F_EMAIL Q_SAVED=$S_EMAIL Q_SAVED_IN=$VALUES_SAVED Q_DEFAULT='' Q_CHECK=check_email
  Q_PROMPT="Administrator's email"
  Q_TEXT="The first administrator signs in with this email. The password is printed at the end."
  resolve
  EMAIL=$VALUE

  Q_FLAG=--site-name Q_GIVEN=$F_SITE Q_SAVED=$S_SITE Q_SAVED_IN=$SITE_SAVED Q_DEFAULT='' Q_CHECK=check_site_name
  Q_PROMPT="Site name"
  Q_TEXT="A short name for this site, such as plant1. Every gateway's settings carry it, so it can
never change. Use letters, digits, '.', '_' and '-'."
  resolve
  SITE_NAME=$VALUE

  dq_detected=
  if [ -z "$SITE_SAVED" ] && [ -z "$F_ADDRESS" ] && check_address "$(detect_address)"; then dq_detected=$CHECKED; fi
  Q_FLAG=--address Q_GIVEN=$F_ADDRESS Q_SAVED=$S_ADDRESS Q_SAVED_IN=$SITE_SAVED Q_DEFAULT=$dq_detected Q_CHECK=check_address
  Q_PROMPT="This machine's address"
  Q_TEXT="This machine's address on the site network. Gateways connect to it, and the broker's
certificate names it."
  resolve
  ADDRESS=$VALUE

  dq_iri=
  if [ -n "$DOMAIN" ]; then dq_iri=https://$DOMAIN/ids/asset/; fi
  Q_FLAG=--base-iri Q_GIVEN=$F_IRI Q_SAVED=$S_IRI Q_SAVED_IN=$SITE_SAVED Q_DEFAULT=$dq_iri Q_CHECK=check_base_iri
  Q_PROMPT="Base IRI for asset ids"
  Q_TEXT="Every asset's id starts with this web address, so it should be under a domain your
organisation controls. It is permanent once an asset shell has been exported."
  resolve
  BASE_IRI=$VALUE

  [ -z "$MISSING" ] || die "there is no terminal to ask on, and these answers were not given:$MISSING
Give them as flags after 'sh -s --'. --yes accepts the suggested address and base IRI. For example:
  curl -sfL https://raw.githubusercontent.com/Harri-Llewelyn/Aber/v$ABER_VERSION/deploy/install.sh | sudo sh -s -- \\
    --domain=aber.plant.example --admin-email=you@plant.example --site-name=plant1 --yes"
}

# The addresses app.<domain> resolves to on this machine, space-separated; empty when none.
app_addresses() {
  getent ahostsv4 "app.$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

# Says what the DNS record needs, when app.<domain> does not already resolve to the address.
dns_advice() {
  da_found=$(app_addresses)
  case " $da_found " in
    *" $ADDRESS "*) return 0 ;;
  esac
  if [ -z "$da_found" ]; then
    say "app.$DOMAIN does not resolve yet. On the site's DNS server, add this record:"
  else
    say "app.$DOMAIN resolves to $da_found, not to $ADDRESS. On the site's DNS server, change it to:"
  fi
  say "  *.$DOMAIN  ->  $ADDRESS"
  say "Browsers and gateways find every part of Aber through it."
}

confirm() {
  dq_saved=
  if [ -n "$VALUES_SAVED$SITE_SAVED" ]; then dq_saved=" (some saved by an earlier run)"; fi
  say ""
  say "Aber $ABER_VERSION will be installed with these answers$dq_saved:"
  say ""
  printf '  %-24s %s\n' "Domain" "$DOMAIN" "Administrator's email" "$EMAIL" "Site name" "$SITE_NAME" \
    "This machine's address" "$ADDRESS" "Base IRI for asset ids" "$BASE_IRI"
  say ""
  say "It installs k3s, Helm and Node.js where they are missing, then Aber. The first install takes"
  say "5 to 20 minutes, most of it downloading."
  dc_dns=$(dns_advice)
  if [ -n "$dc_dns" ]; then
    say ""
    say "$dc_dns"
    say "You can add it while this runs."
  fi
  say ""
  if [ "$YES" = 1 ]; then return 0; fi
  [ "$HAVE_TTY" = 1 ] || die "there is no terminal to confirm on. Add --yes to go ahead without asking."
  ask "Continue? (y/N)" ""
  case $ANSWER in
    [yY] | [yY][eE][sS]) ;;
    *)
      say "Stopped. Nothing was changed."
      exit 0
      ;;
  esac
}

# --- The install: each step skips what an earlier run finished --------------------------------

fetch_source() {
  step "Aber $ABER_VERSION's setup files"
  if [ -n "$SOURCE_DIR" ]; then
    SRC=$(cd "$SOURCE_DIR" 2>/dev/null && pwd) || die "--source-dir: '$SOURCE_DIR' is not a directory."
    for fs_file in scripts/setup.mjs deploy/k8s/traefik-config.yaml deploy/k8s/internal-ca.yaml; do
      [ -f "$SRC/$fs_file" ] || die "--source-dir: $SRC has no $fs_file, so it is not a checkout of Aber."
    done
    fs_chart=$(yaml_value "$SRC/deploy/helm/aber/Chart.yaml" version 2>/dev/null || true)
    if [ "$fs_chart" != "$ABER_VERSION" ]; then
      warn "the checkout at $SRC is chart ${fs_chart:-?}, and this installer installs $ABER_VERSION."
    fi
    say "  using the checkout at $SRC"
    return 0
  fi
  fs_url=$REPO_URL/archive/refs/tags/v$ABER_VERSION.tar.gz
  SRC=$WORK/source
  if [ "$DRY_RUN" = 1 ]; then
    curl -fsSLI -o /dev/null "$fs_url" || die "could not reach $fs_url. Check that this machine can reach github.com."
    say "  would download $fs_url"
    return 0
  fi
  curl -fsSL "$fs_url" -o "$WORK/source.tar.gz" || die "could not download $fs_url. Check that this machine can reach github.com, then run this again."
  mkdir "$SRC"
  tar -xzf "$WORK/source.tar.gz" -C "$SRC" --strip-components=1 || die "$fs_url did not unpack."
  say "  downloaded $fs_url"
}

install_k3s() {
  step "k3s, the Kubernetes that runs Aber"
  ik_have=
  if command -v k3s >/dev/null 2>&1; then
    ik_have=$(k3s --version 2>/dev/null | sed -n 's/^k3s version v\([0-9]*\.[0-9]*\).*/\1/p')
  fi
  if [ -n "$ik_have" ] && version_at_least "$ik_have" "$MIN_K3S"; then
    say "  k3s $ik_have is installed"
    if [ "$CLUSTER_UP" = 0 ] && systemctl cat k3s.service >/dev/null 2>&1; then run systemctl start k3s; fi
  else
    if [ -n "$ik_have" ]; then say "  k3s $ik_have is older than $MIN_K3S, which Aber needs: upgrading it"; fi
    run_remote https://get.k3s.io sh
  fi
  if [ "$DRY_RUN" = 1 ] && [ "$CLUSTER_UP" = 0 ]; then
    say "  would wait for the node to be Ready"
  else
    wait_until "k3s's node is Ready" 300 node_ready || die "k3s's node was not Ready within 5 minutes. 'sudo journalctl -u k3s' says why."
    CLUSTER_UP=1
  fi
  user_kubeconfig
}

node_ready() { kc get nodes 2>/dev/null | grep -q ' Ready '; }

# Polls $3 every 5 seconds, for up to $2 seconds.
wait_until() {
  if [ "$DRY_RUN" = 1 ]; then
    say "  would wait until $1"
    return 0
  fi
  wu_end=$(($(date +%s) + $2))
  until "$3"; do
    [ "$(date +%s)" -lt "$wu_end" ] || return 1
    sleep 5
  done
}

# The sudo user gets the cluster's kubeconfig in ~/.kube/config, and KUBECONFIG naming it, because
# k3s's kubectl reads only its own root-owned file otherwise.
user_kubeconfig() {
  if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = root ]; then return 0; fi
  USER_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
  if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
    USER_HOME=
    say "  $SUDO_USER has no home directory here, so only root can use kubectl and helm"
    return 0
  fi
  USER_GROUP=$(id -gn "$SUDO_USER")
  if [ "$DRY_RUN" = 1 ]; then
    say "  would write $USER_HOME/.kube/config for $SUDO_USER"
    return 0
  fi
  kc config view --raw >"$WORK/kubeconfig"
  if [ -f "$USER_HOME/.kube/config" ] && ! cmp -s "$WORK/kubeconfig" "$USER_HOME/.kube/config"; then
    say "  left $USER_HOME/.kube/config as it was: it is not this cluster's, which is $K3S_CONFIG"
  else
    install -d -m 700 -o "$SUDO_USER" -g "$USER_GROUP" "$USER_HOME/.kube"
    install -m 600 -o "$SUDO_USER" -g "$USER_GROUP" "$WORK/kubeconfig" "$USER_HOME/.kube/config"
    # shellcheck disable=SC2016 # written for the user's shell to expand
    uk_line='export KUBECONFIG=$HOME/.kube/config'
    if ! grep -qsF "$uk_line" "$USER_HOME/.bashrc"; then
      printf '%s\n' "$uk_line" >>"$USER_HOME/.bashrc"
      chown "$SUDO_USER:$USER_GROUP" "$USER_HOME/.bashrc"
    fi
    say "  $SUDO_USER can use kubectl and helm on this cluster, in a new shell"
  fi
}

install_helm_and_node() {
  step "Helm and Node.js"
  ih_helm=
  if command -v helm >/dev/null 2>&1; then
    ih_helm=$(helm version --template '{{.Version}}' 2>/dev/null | sed 's/^v//')
  fi
  if [ -n "$ih_helm" ] && version_at_least "$ih_helm" "$MIN_HELM"; then
    say "  Helm $ih_helm is installed"
  else
    run_remote https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 bash
  fi

  # Node.js runs only `npm run setup`'s script, which needs no `npm install`.
  ih_node=
  if command -v node >/dev/null 2>&1; then ih_node=$(node -p process.versions.node 2>/dev/null || true); fi
  if [ -n "$ih_node" ] && version_at_least "$ih_node" "$MIN_NODE"; then
    say "  Node.js $ih_node is installed"
  else
    run_remote https://deb.nodesource.com/setup_24.x bash
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs || die "Node.js did not install. apt-get's messages are above."
  fi
}

traefik_is_local() {
  [ "$(kc -n kube-system get svc traefik -o jsonpath='{.spec.externalTrafficPolicy}' 2>/dev/null)" = Local ]
}

ca_is_ready() {
  [ "$(kc get clusterissuer aber-ca -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ]
}

prepare_cluster() {
  step "Prepare the cluster: Traefik, cert-manager and the internal CA"
  # Traefik keeps each client's address, so sign-in limits apply per client (runbook, Install).
  run kc apply -f "$SRC/deploy/k8s/traefik-config.yaml" || die "Traefik's settings did not apply."
  wait_until "Traefik keeps each client's address" 300 traefik_is_local || die "Traefik's Service did not switch to externalTrafficPolicy Local within 5 minutes.
Aber needs the Traefik that k3s installs. 'kubectl -n kube-system get svc traefik' shows its state."

  if [ "$CLUSTER_UP" = 1 ] && ca_is_ready; then
    say "  cert-manager and the internal CA are already set up"
    return 0
  fi
  # An existing cert-manager is kept, whatever its version: applying this one would replace it.
  if [ "$CLUSTER_UP" = 0 ] || ! kc get namespace cert-manager >/dev/null 2>&1; then
    run kc apply -f "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER_VERSION/cert-manager.yaml" ||
      die "cert-manager $CERT_MANAGER_VERSION did not apply."
  fi
  run kc -n cert-manager wait --for=condition=Available deployment --all --timeout=300s ||
    die "cert-manager did not start within 5 minutes. 'kubectl -n cert-manager get pods' shows why."
  if [ "$DRY_RUN" = 1 ]; then
    say "  would run: kubectl apply -f $SRC/deploy/k8s/internal-ca.yaml"
  else
    # cert-manager's webhook can refuse for a few seconds after its Deployment reports Available.
    pc_try=0
    until kc apply -f "$SRC/deploy/k8s/internal-ca.yaml"; do
      pc_try=$((pc_try + 1))
      [ "$pc_try" -lt 12 ] || die "the internal CA did not apply within a minute. The messages above say why."
      sleep 5
    done
  fi
  run kc -n cert-manager wait --for=condition=Ready certificate/aber-ca --timeout=120s ||
    die "the internal CA's root certificate was not issued. 'kubectl -n cert-manager describe certificate aber-ca' says why."
  run kc wait --for=condition=Ready clusterissuer/aber-ca --timeout=120s ||
    die "the internal CA did not become Ready. 'kubectl describe clusterissuer aber-ca' says why."
}

# Whether a values file sets a `port:` to the forge's SSH port.
sets_forge_port() {
  grep -v '^[[:space:]]*#' "$1" 2>/dev/null | grep -Eq "(^|[{,[:space:]])port:[[:space:]]*[\"']?${FORGE_SSH_PORT}[\"']?[[:space:]]*([,}#]|\$)"
}

write_site_files() {
  step "The site's passwords and settings, in $ETC"
  run install -d -m 700 "$ETC"
  if [ -f "$VALUES" ]; then
    say "  keeping the passwords and keys in $VALUES"
  elif [ "$DRY_RUN" = 1 ]; then
    say "  would run: node ${SRC}/scripts/setup.mjs --domain=$DOMAIN --admin-email=$EMAIL --out=$VALUES"
  else
    ws_out=$(node "${SRC}/scripts/setup.mjs" --domain="$DOMAIN" --admin-email="$EMAIL" --out="$VALUES" 2>&1) || {
      printf '%s\n' "$ws_out" >&2
      die "creating the site's passwords failed. The messages above say why."
    }
    [ -f "$VALUES" ] || {
      printf '%s\n' "$ws_out" >&2
      die "creating the site's passwords wrote no $VALUES. The messages above say why."
    }
    chmod 600 "$VALUES"
    say "  created every password and key the site needs, in $VALUES"
  fi
  if [ -f "$VALUES" ] && ! sets_forge_port "$VALUES" && ! sets_forge_port "$SITE"; then
    die "$VALUES does not move the forge's SSH to port $FORGE_SSH_PORT. The forge would take port 22,
and new SSH connections to this machine would reach the forge instead.
Add these lines to the end of $VALUES, then run this again:
gitea:
  ssh:
    external:
      port: $FORGE_SSH_PORT"
  fi

  if [ -f "$SITE" ]; then
    say "  keeping the site settings in $SITE"
  elif [ "$DRY_RUN" = 1 ]; then
    say "  would write $SITE"
  else
    cat >"$SITE.new" <<EOF
# Written by Aber's installer: what only this site can say (docs/install.md, step 6).
# The site name and the base IRI are permanent once in use. To change the address, edit it here
# and run the installer again.
global:
  scheme: https
ingestion:
  primaryHostId: "$SITE_NAME"
  sparkplugGroup: "$SITE_NAME"
supabaseFunctions:
  aas:
    baseIri: "$BASE_IRI"
ingress:
  tls:
    enabled: true
    certManager:
      clusterIssuer: aber-ca
mosquitto:
  tls:
    enabled: true
    clusterIssuer: aber-ca
    extraIpSans: ["$ADDRESS"]
EOF
    chmod 600 "$SITE.new"
    mv "$SITE.new" "$SITE"
    say "  wrote $SITE"
  fi
}

install_aber() {
  step "Install Aber $ABER_VERSION"
  if [ "$CLUSTER_UP" = 1 ]; then
    ia_last=$(helm history aber -n aber --max 1 -o json 2>/dev/null | sed -n 's/.*"status":"\([a-z-]*\)".*/\1/p')
    case $ia_last in
      pending-*) die "an earlier Helm command on Aber never finished (its status is $ia_last), and Helm
refuses another until it is cleared. 'helm history aber -n aber' shows it. A pending upgrade is
cleared with 'helm rollback aber -n aber'; a pending first install with 'helm uninstall aber -n aber',
which keeps the data volumes. Then run this again." ;;
    esac
  fi
  run helm upgrade --install aber "$CHART" --version "$ABER_VERSION" -n aber --create-namespace \
    -f "$VALUES" -f "$SITE" --timeout 15m ||
    die "Helm stopped. Its error is above: if it names a setting, correct it in $SITE or $VALUES,
then run this again."
}

wait_and_test() {
  step "Wait for every part of Aber to start, then test it"
  if [ "$DRY_RUN" = 1 ]; then
    say "  would run: kubectl -n aber rollout status <each StatefulSet and Deployment> --timeout=10m"
    say "  would run: helm test aber -n aber"
    return 0
  fi
  # One workload at a time, never `helm install --wait`: on a first install the workloads wait for
  # database roles that Helm's post-install hooks create, and --wait holds the hooks back.
  wt_list=$(kc -n aber get statefulset,deploy -o name) || die "could not list Aber's workloads."
  for wt_name in $wt_list; do
    kc -n aber rollout status "$wt_name" --timeout=10m ||
      die "$wt_name did not start within 10 minutes. 'kubectl -n aber describe $wt_name' and its
pods' logs say why. Running this again carries on from here."
  done
  helm test aber -n aber ||
    die "Aber's checks failed. 'helm test aber -n aber --logs' shows what each found."
}

save_root_certificate() {
  step "Save the root certificate"
  if [ "$DRY_RUN" = 1 ]; then
    say "  would write $CA_FILE"
    return 0
  fi
  kc -n cert-manager get secret aber-ca-key-pair -o jsonpath='{.data.tls\.crt}' >"$WORK/ca.b64" ||
    die "could not read the root certificate from cert-manager."
  base64 -d "$WORK/ca.b64" >"$WORK/aber-ca.crt" || die "the root certificate cert-manager holds did not decode."
  grep -q 'BEGIN CERTIFICATE' "$WORK/aber-ca.crt" || die "the root certificate cert-manager holds is not a certificate."
  install -m 644 "$WORK/aber-ca.crt" "$CA_FILE"
  CA_COPY=
  if [ -n "${USER_HOME:-}" ]; then
    CA_COPY=$USER_HOME/aber-ca.crt
    install -m 644 -o "$SUDO_USER" -g "$USER_GROUP" "$WORK/aber-ca.crt" "$CA_COPY"
  fi
  say "  saved to $CA_FILE${CA_COPY:+ and $CA_COPY}"
}

finish() {
  if [ "$DRY_RUN" = 1 ]; then
    say ""
    say "Dry run finished. Nothing was changed."
    return 0
  fi
  fi_password=$(yaml_value "$VALUES" firstAdministratorPassword)
  say ""
  say "Aber $ABER_VERSION is installed, and its checks passed."
  say ""
  printf '  %-12s %s\n' "Sign in at" "https://app.$DOMAIN" "Email" "$EMAIL" "Password" "${fi_password:-(not in $VALUES)}"
  if [ "$RERUN" = 1 ]; then
    say "               The password the account was created with. If it has been changed since,"
    say "               the new one stands."
  fi
  say ""
  say "Every password and key is in $VALUES. Keep it safe."
  fi_dns=$(dns_advice)
  if [ -n "$fi_dns" ]; then
    say ""
    say "$fi_dns"
  fi
  say ""
  say "Install the root certificate, $CA_FILE${CA_COPY:+ (copied to $CA_COPY)}, on every"
  say "browser and gateway that will use Aber. Until then every page shows a certificate warning:"
  say "$REPO_URL/blob/v$ABER_VERSION/docs/install.md#8-install-the-root-certificate"
}

aber_install() {
  set -eu
  # Files that hold secrets get their mode set where they are written. A tighter umask would leak
  # into the k3s, Helm and NodeSource installers, and apt ignores a keyring it cannot read.
  umask 022
  F_DOMAIN='' F_EMAIL='' F_SITE='' F_ADDRESS='' F_IRI=''
  SOURCE_DIR=${ABER_SOURCE_DIR:-}
  YES=0 DRY_RUN=0 SKIP_HARDWARE=0
  STEP=0 MISSING='' CLUSTER_UP=0 RERUN=0 USER_HOME='' USER_GROUP='' CA_COPY=''
  export KUBECONFIG="$K3S_CONFIG"
  parse_args "$@"

  say "Aber $ABER_VERSION server installer"
  if [ "$DRY_RUN" = 1 ]; then say "Dry run: every check and question, then what would run. Nothing is changed."; fi
  say ""
  say "Checking this machine"
  check_platform
  check_hardware
  check_forge_port
  check_existing_install
  ask_questions
  confirm

  WORK=$(mktemp -d /tmp/aber-install.XXXXXX)
  trap 'rm -rf "$WORK"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  fetch_source
  install_k3s
  install_helm_and_node
  prepare_cluster
  write_site_files
  install_aber
  wait_and_test
  save_root_certificate
  finish
}

aber_install "$@" </dev/null
