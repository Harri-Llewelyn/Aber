# The broker credential-issuing service.
#
# BUILT FROM THE BROKER'S OWN IMAGE, and that is the whole reason this Dockerfile exists rather than
# `node:20-alpine` plus a hashing library.
#
# Mosquitto's `$7$` password format is PBKDF2-SHA512 in a specific framing, and the hash has to be
# readable by the mosquitto that will verify it. A reimplementation in Node would be perfectly
# capable of producing a file that LOOKS right and refuses every login -- CONNACK 5, with nothing
# useful logged at either end and nothing in the file to inspect, because it holds only hashes.
# Using the broker's own `mosquitto_passwd` removes the question entirely.
#
# THE TAG MUST MATCH docker-compose.yml AND THE CHART. scripts/check-image-tag-parity.mjs asserts
# the broker's tag is the same on both targets; this image is the third place that tag appears, so
# it is checked there too. A drift here means credentials hashed by one version of the tool and read
# by another -- which is currently harmless (the format is stable across 2.0.x) and is exactly the
# kind of assumption that is true until it is not.
FROM eclipse-mosquitto:2.0.20

# The image is Alpine-based and already carries mosquitto_passwd; only a runtime for the service is
# missing. Verified against this tag: node 20.15.1 and mosquitto_passwd coexist in one layer.
RUN apk add --no-cache nodejs

# ROOT, DELIBERATELY, AND NARROWLY. Two things need it, neither of which a lesser uid can do:
#
#   1. writing /mosquitto/config/password_file, which is owned by uid 1883 and mode 0600
#   2. signalling the broker process, which runs as 1883 in a namespace this container shares
#
# The service's ONLY privileged action is adding one line to one file; it holds no database
# credential, no Kubernetes-wide authority (its ServiceAccount is scoped to get/patch on a single
# Secret by name), and is not published outside the container network.
USER root

# No CMD: both targets supply `node /scripts/gateway-credential-service.mjs`, keeping the script
# bind-mounted (Compose) or ConfigMap-mounted (Kubernetes) so it is editable without a rebuild --
# the same arrangement as node-red-init and mosquitto-tls-init.
