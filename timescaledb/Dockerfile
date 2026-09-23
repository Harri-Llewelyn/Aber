# The historian's runtime: the upstream TimescaleDB image with pgBackRest added.
#
# pgBackRest has to be in THIS image rather than a sidecar's: PostgreSQL runs `archive_command`
# while the server is up and `restore_command` during recovery, both inside the server's own
# container. The sidecar that takes the scheduled backups (timescaledb/pgbackrest/) runs this image
# too, so the two can never be different pgBackRest versions writing one repository.
#
# THE TAG MUST MATCH THE ONE THE MAINTENANCE JOB'S psql WAS VERIFIED AGAINST; the chart runs this
# image for the server, the maintenance Job and the certificate-reload sidecar alike.
FROM timescale/timescaledb:2.29.2-pg17

# Alpine community. Installed whether or not physical backup is switched on, so turning it on is a
# values change and a restart, not a different image.
RUN apk add --no-cache pgbackrest tini

# TINI IS PID 1, NOT THE POSTMASTER. Asynchronous archive-push forks a process that outlives the
# archive_command that started it; orphaned, it is adopted by PID 1. When the postmaster is PID 1 it
# reaps it, and an exit code other than 0 or 1 (every archive failure) reads to it as a crashed
# backend: it terminates every connection and recovers, every time a push fails. Measured with the
# repository unreachable: the historian restarted every two minutes. tini adopts and reaps instead,
# and passes the stop signal (the base image's SIGINT) to the server.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["postgres"]

# No USER: the upstream entrypoint starts as root, fixes the data directory's ownership and drops to
# postgres (uid 70) before the server starts. The chart supplies the server flags.
