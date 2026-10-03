# Node with the OpenSSL CLI, for scripts/mosquitto-tls-init.mjs.
#
# WHY A BUILT IMAGE FOR TWO LINES. The generator needs `node` (it is an .mjs script, like every
# other init script in this repository) AND the `openssl` binary (Node's crypto module can generate
# keys but has no X.509 SIGNING API, so a certificate cannot be issued from Node alone). No image
# this stack already pins has both -- verified, not assumed, against the pinned tags:
#
#   node:24-alpine          node, no openssl
#   node:24-bookworm-slim   node, no openssl
#   alpine:3.20             neither
#   eclipse-mosquitto:2.0.20  neither
#
# So the choice was a runtime `apk add` in the entrypoint -- which makes first boot depend on
# reaching a package mirror, and fails on the first pod start rather than at build time -- or this.
# Every other service in this stack that needs a package builds an image for it (see
# node-red/Dockerfile, which exists for exactly the same reason with different packages).
#
# THE BASE IS PINNED for the same reason node-red/Dockerfile's is: OpenSSL 3.x changed how `-subj`
# is parsed (see the escaping note in the script -- an unescaped `+` in a subject value is an RDN
# separator), so the certificate this produces is coupled to
# a major version of a tool, and "whatever :latest is today" is not a version.
FROM node:24-alpine

RUN apk add --no-cache openssl

# No CMD: the caller supplies `node /scripts/mosquitto-tls-init.mjs` and mounts the script, keeping
# it editable without a rebuild -- the same arrangement as node-red-init.
