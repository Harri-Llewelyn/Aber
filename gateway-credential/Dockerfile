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
# THE TAG MUST MATCH docker-compose.yml AND THE CHART. scripts/check-image-tag-parity.mjs asserts
# this FROM against Compose's pin, as it does for the edge runtime and the database image.
FROM eclipse-mosquitto:2.0.22

# The image is Alpine-based; only a runtime for the scripts is missing.
RUN apk add --no-cache nodejs

# ROOT, DELIBERATELY. The boot reconcile writes the plugin's document owned by uid 1883 at 0600,
# and the service writes the playback delivery file at 0600 for another container to read. The
# service holds no database credential and is not published outside the container network.
USER root

# No CMD: both targets supply the script to run, keeping it bind-mounted (Compose) or
# ConfigMap-mounted (Kubernetes) so it is editable without a rebuild.
