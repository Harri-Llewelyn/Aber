# Swagger UI with the two curated API specifications baked in.
#
# The specs are served from the image rather than mounted from a ConfigMap because Helm stores the
# chart archive AND the rendered manifest in one release Secret, capped at 1 MiB; the two documents
# were the largest thing in it. Same arrangement as the migrations in supabase/db-init/Dockerfile.
#
# CONSEQUENCE FOR AN EDIT: a change to docs/*.yaml reaches a cluster with the next image build, not
# the next `helm upgrade`. The dev loop rebuilds every image on `node scripts/dev-cluster.mjs up`.
#
# Built from the repository root, so both specs resolve; .dockerignore negates each by name.
FROM swaggerapi/swagger-ui:v5.33.0

# The base's Alpine packages, taken to the distribution's current fixes: a fix Alpine ships between
# two base cuts reaches the release rather than waiting for the next base (#347).
RUN apk upgrade --no-cache

# Swagger UI's LICENSE and NOTICE, which the base does not carry and a published image must
# (NOTICE.md). nginx's own is already in the base, at /usr/share/licenses/nginx/.
COPY licenses/swagger-ui/ /usr/share/licenses/

# Strict-Transport-Security, from the value the chart sets when global.scheme is https: the base's
# entrypoint renders this template into conf.d with its own. Empty sends no header.
ENV ABER_STRICT_TRANSPORT_SECURITY=""
COPY swagger-ui/aber-headers.conf.template /etc/nginx/templates/

# openapi.yaml is the gateway-fronted platform surface; i3x-openapi.yaml is the i3X server, a
# different origin with a different auth model. The Deployment's URLS env names both by these paths.
COPY docs/openapi.yaml docs/i3x-openapi.yaml /usr/share/nginx/html/

# NON-ROOT: nginx starts as its own user (101) and listens on 8080. The base leaves most of what its
# entrypoint and master write world-writable (conf.d, the web root, /run, the cache); the entrypoint
# also empties the CORS and embedding snippets in templates/, which the base leaves to root. The
# `user` directive goes: it applies only to a master started as root, and nginx warns otherwise.
RUN sed -i '/^user /d' /etc/nginx/nginx.conf && chown -R 101:101 /etc/nginx/templates
USER 101:101
