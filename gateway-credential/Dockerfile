# The broker credential service, and the broker's boot reconcile.
#
# BUILT FROM THE BROKER'S OWN IMAGE, and that is the whole reason this Dockerfile exists rather than
# `node:24-alpine` plus a library.
#
# Two binaries have to match the broker exactly. `mosquitto_passwd` writes the `$7$` PBKDF2-SHA512
# hash the boot reconcile transplants into the plugin's document for the platform principals; a
# reimplementation could produce a hash that looks right and refuses every login with nothing
# logged at either end. `mosquitto_rr` is how the service and the reconcile's callers speak to the
# Dynamic Security plugin over $CONTROL/dynamic-security/v1. Taking both from the image the broker
# runs removes the question of compatibility entirely.
#
# THE TAG MUST MATCH THE CHART'S mosquitto PIN. check-docs-drift.mjs asserts this FROM against
# `mosquitto.image.tag` in values.yaml, as it does for the database image.
#
# The build context is the REPOSITORY ROOT, where the scripts below live.
FROM eclipse-mosquitto:2.1.2-alpine

# The image is Alpine-based; only a runtime for the scripts is missing.
RUN apk add --no-cache nodejs

# THE BROKER'S OWN USER (mosquitto, 1883). The boot reconcile writes the plugin's document, which
# the broker reads and rewrites as that uid at 0600, so writing it as 1883 needs no chown. The
# service patches the playback delivery file through the Kubernetes API and writes nothing on disk.
USER 1883:1883

# THE SCRIPTS, baked in rather than mounted from a ConfigMap: Helm stores the chart archive and the
# rendered manifest in one release Secret under a 1 MiB cap. The reconcile and the service import
# their libraries from `./lib/`. No CMD: the chart names the script each container runs, so an edit
# to one needs this image rebuilt, which the dev loop does on `up`.
COPY scripts/mosquitto-dynsec-init.mjs scripts/gateway-credential-service.mjs /opt/aber/
COPY scripts/lib/mosquitto-credentials.mjs scripts/lib/mosquitto-dynsec.mjs scripts/lib/mosquitto-control.mjs /opt/aber/lib/
