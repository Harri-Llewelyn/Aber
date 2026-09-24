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

# openapi.yaml is the gateway-fronted platform surface; i3x-openapi.yaml is the i3X server, a
# different origin with a different auth model. The Deployment's URLS env names both by these paths.
COPY docs/openapi.yaml docs/i3x-openapi.yaml /usr/share/nginx/html/
