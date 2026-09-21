# The backup service's runtime.
#
# BUILT FROM THE DATABASE'S OWN IMAGE, for its pg_dump: the dumping client must be at least the
# server's version, and this is the image the server runs. It is also why the historian's major
# is capped by whatever supabase/postgres ships (see the chart's backup CronJob).
#
# THE TAG MUST MATCH THE CHART'S supabase-db PIN. check-docs-drift.mjs couples this FROM to
# `supabaseDb.image.tag` in values.yaml, the same way it does supabase/db-init.
FROM supabase/postgres:17.6.1.160

# Alpine. node runs the service; sqlite3 takes the consistent copy of the forge's database; GNU
# tar (the package named `tar`) replaces busybox's for --exclude and a second -C.
RUN apk add --no-cache nodejs sqlite tar

# ROOT, DELIBERATELY. The service reads three volumes owned by three uids -- the storage objects,
# the forge (1000) and its own -- and writes one. It holds the two superuser passwords because
# pg_dump needs them; the image boundary and the absence of a published port are what confine it.
USER root

# No CMD: the chart supplies `node /scripts/backup-service.mjs` and mounts the script from a
# ConfigMap, as gateway-credential does, so it is editable without a rebuild.
