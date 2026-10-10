# The platform database's runtime: the pinned supabase/postgres with pgBackRest added.
#
# pgBackRest has to be in THIS image rather than a sidecar's: PostgreSQL runs `archive_command`
# while the server is up and `restore_command` during recovery, both inside the server's own
# container. The sidecar that takes the scheduled backups (pgbackrest/) runs this image too, so the
# two can never be different pgBackRest versions writing one stanza.
#
# THE TAG MUST MATCH THE CHART'S supabase-db PIN. check-docs-drift.mjs couples this FROM to
# `supabaseDb.image.tag` in values.yaml, as it does backup-service and db-init: the Jobs that run
# that image's psql and pg_dump against this server are its clients.
FROM supabase/postgres:17.6.1.175

# Alpine community: pgBackRest 2.57.0, the historian's version (it pulls Alpine's postgresql18 for
# its dependency; the server and every client on PATH stay the base's PostgreSQL 17). Installed
# whether or not physical backup is switched on, so turning it on is a values change and a restart,
# not a different image.
#
# The release scan fails on a base's stale Alpine packages and Go tools, so: upgrade the first, and
# take gosu, which the entrypoint uses to drop root, from Alpine's current build.
RUN apk upgrade --no-cache \
 && apk add --no-cache pgbackrest tini gosu \
 && rm /usr/local/bin/gosu

# TINI IS PID 1, NOT THE POSTMASTER. Asynchronous archive-push forks a process that outlives the
# archive_command that started it; orphaned, it is adopted by PID 1. When the postmaster is PID 1 it
# reaps it, and an exit code other than 0 or 1 (every archive failure) reads to it as a crashed
# backend: it terminates every connection and recovers, every time a push fails. tini adopts and
# reaps instead, and passes the stop signal (the base image's SIGINT) to the server.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["postgres", "-D", "/etc/postgresql"]

# No USER: the upstream entrypoint starts as root, fixes the data directory's ownership and drops to
# postgres (uid 100) before the server starts. The chart supplies the server flags.
