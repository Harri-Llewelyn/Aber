# The backup service.
#
# BUILT FROM THE DATABASE'S OWN IMAGE, for its pg_dump: the dumping client must be at least the
# server's version, and this is the image the server runs. It is also why the historian's major
# is capped by whatever supabase/postgres ships (see the chart's backup CronJob).
#
# THE TAG MUST MATCH THE CHART'S supabase-db PIN. check-docs-drift.mjs couples this FROM to
# `supabaseDb.image.tag` in values.yaml, the same way it does supabase/db-init.
#
# The build context is the REPOSITORY ROOT, where the service's script lives.
FROM supabase/postgres:17.6.1.175

# gosu is the base entrypoint's tool for starting postgres as root and dropping to the postgres user.
# This image never starts postgres -- the chart's command is node -- and the binary carried the
# image's only fixable findings, a stale Go toolchain (#347). Removed rather than carried.
RUN rm /usr/local/bin/gosu

# Alpine. node runs the service; sqlite3 takes the consistent copy of the forge's database; GNU
# tar (the package named `tar`) replaces busybox's for --exclude and a second -C. The off-site
# copy: age encrypts each file to the operator's public key, and the AWS CLI uploads it with a
# SHA-256 the store checks and HEADs it back. The CLI and its Python are most of the image's size.
# `apk upgrade` first, as the supabase-db image does, so a fix Alpine ships between two base cuts
# reaches the release.
RUN apk upgrade --no-cache \
 && apk add --no-cache nodejs sqlite tar age aws-cli

# THE LICENCES the base does not carry, as supabase/db/Dockerfile copies them, from the repository
# root's licenses/ (NOTICE.md).
COPY licenses/supabase-postgres/ /usr/share/licenses/

# The base's postgres user (100:101), the owner group the backup volume is given (fsGroup 101). The
# forge's and the broker's volumes hold files other uids own at 0600, so the chart runs the service
# as root, with DAC_OVERRIDE, only when it archives either of those.
USER 100:101

# THE SERVICE, baked in rather than mounted from a ConfigMap: Helm stores the chart archive and the
# rendered manifest in one release Secret under a 1 MiB cap. No CMD: the chart runs
# `node /opt/aber/backup-service.mjs`, so an edit to it needs this image rebuilt, which the dev loop
# does on `up`.
COPY scripts/backup-service.mjs /opt/aber/backup-service.mjs
