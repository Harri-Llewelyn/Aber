#!/bin/sh
# Writes the licences of an Alpine-based image's packages into the image, from its own package
# database: /usr/share/licenses/os-packages.txt lists every package, and os-packages-source.txt
# says where the copyleft ones' source is and offers it. A Dockerfile copies this in, runs it as
# root after its last apk step, and deletes it. BusyBox is all it needs.
set -eu

db=/lib/apk/db/installed
out=/usr/share/licenses
alpine=$(cat /etc/alpine-release)
branch="$(echo "$alpine" | cut -d. -f1,2)-stable"
tab=$(printf '\t')
mkdir -p "$out"

# One line per package: name, version, licence, origin, and the aports commit that built it ("-"
# when it came from elsewhere). A virtual package (apk add --virtual) has no origin and no files.
packages=$(awk '
  function flush() {
    if (o != "") printf "%s\t%s\t%s\t%s\t%s\n", p, v, l, o, (c == "" ? "-" : c)
    p = v = l = o = c = ""
  }
  /^P:/ { p = substr($0, 3) }
  /^V:/ { v = substr($0, 3) }
  /^L:/ { l = substr($0, 3) }
  /^o:/ { o = substr($0, 3) }
  /^c:/ { c = substr($0, 3) }
  /^$/ { flush() }
  END { flush() }' "$db" | sort)

{
  echo "# The Alpine Linux $alpine packages in this image, read from $db when it was built."
  echo "# One per line, tab-separated: name, version, licence (SPDX), and origin, the aports package"
  echo "# that built it. Where the copyleft ones' source is: os-packages-source.txt, beside this file."
  printf '%s\n' "$packages" | cut -f1-4
} > "$out/os-packages.txt"

{
  cat <<EOF
The source of this image's copyleft Alpine Linux packages

The packages listed below are under a copyleft licence: the GPL, the LGPL, the MPL or the like.
GPL-2.0 section 3 asks whoever distributes one to include its source, or a written offer of it.

Where it is. Alpine Linux $alpine built each one from its aports repository, on this branch:

  https://gitlab.alpinelinux.org/alpine/aports/-/tree/$branch

A package's build script (APKBUILD) and patches are in main/<origin>/ or community/<origin>/
there, and the APKBUILD names the upstream source it builds. The last column below is the aports
commit the package was built from. A "-" there means the package did not come from aports.

The written offer. For three years from each Aber release that ships this image, Aber's
maintainer will give anyone who asks a complete copy of the corresponding source of the packages
below. The charge is no more than the cost of making the copy. To ask, use GitHub's private
vulnerability reporting for the Aber repository, the Security tab, then Report a vulnerability:

  https://github.com/Harri-Llewelyn/Aber/security/advisories/new

The form is built for vulnerability reports; use it for a source request too. Say which image you
have and its tag, and the packages whose source you are asking for.

EOF
  printf 'name\tversion\tlicence\torigin\taports commit\n'
  printf '%s\n' "$packages" | awk -F "$tab" '$3 ~ /GPL|MPL|EPL|CDDL|EUPL/'
} > "$out/os-packages-source.txt"
