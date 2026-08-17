# check=skip=SecretsUsedInArgOrEnv
#
# THAT SKIP IS NARROW AND THE REASONING IS AT THE ARG BLOCK BELOW. In short: the rule matches on
# the NAME (`..._KEY`), and a Supabase anon key is not a secret -- it is a public, RLS-gated JWT
# whose entire purpose is to be served to browsers. Do not widen this to other rules, and if you
# add an ARG here, add it to FRONTEND_BUILD_ARGS in scripts/check-docs-drift.mjs, which exists to
# stop this line quietly covering a future ARG that IS sensitive.

# Stage 1: Build Vite application
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# TWO WAYS TO CONFIGURE THIS IMAGE, and the build arg below picks between them.
#
#   1. BAKED (the default, and what Docker Compose uses). The values below are inlined into the
#      bundle by Vite. Simple, and correct when the image is built against the stack it serves.
#
#   2. RUNTIME (VITE_RUNTIME_CONFIG=true, and what Kubernetes uses). Nothing is baked; the
#      deployment mounts a ConfigMap over /usr/share/nginx/html/config.js and src/config.js reads
#      it from window.__ACS_CYMRU_CONFIG__ at load. This is what allows ONE image to serve any
#      environment, which a baked bundle cannot do.
#
# Both paths run the same code -- src/config.js prefers the runtime value and falls through to the
# baked one -- so a runtime-config image handed a config.js is fully configured, and a baked image
# with the shipped no-op placeholder behaves exactly as it did before runtime config existed.
# NO `ENV` MIRRORS BELOW, AND NONE ARE NEEDED. An `ARG` is already exposed to `RUN` as an
# environment variable, and it is inherited by child processes -- so Vite reads these from
# `process.env` during `npm run build` exactly as it did when each line had an `ENV` twin. The
# twins were pure duplication, and each one also raised its own `SecretsUsedInArgOrEnv` warning.
#
# WHY THE REMAINING `ARG VITE_SUPABASE_ANON_KEY` WARNING IS SKIPPED RATHER THAN FIXED.
#
# BuildKit's rule matches the NAME, not the value: anything ending `_KEY`, `_TOKEN` or `_SECRET`
# trips it. The Supabase anon key is not a secret. It is a JWT carrying `role: anon`, signed so
# PostgREST can identify the caller, and it is useful only in combination with the RLS policies
# that gate every table -- its whole purpose is to be handed to every browser that loads the app.
# Treating it as a build secret would mean it could not be inlined into the bundle, which is the
# one thing it exists to do. The name cannot be changed either: Vite inlines by exact
# `VITE_`-prefixed name.
#
# Verified, so the skip rests on facts rather than on the argument above:
#   - `docker inspect` on the FINAL image shows no `VITE_*` variable in `Config.Env`, on either
#     build path. Stage 2 is a fresh `FROM nginx:alpine` that copies only `/app/dist`, so nothing
#     from this stage's environment survives the stage boundary -- which is precisely the leak the
#     rule guards against, already closed by the structure.
#   - The PUBLISHED image passes no key at all. release.yml builds with `VITE_RUNTIME_CONFIG=true`
#     and nothing else, and a JWT-shaped grep over the served bundle finds nothing.
#   - On the baked path the value does reach the bundle. That is what baking means, and it is the
#     same exposure as serving the app at all.
ARG VITE_RUNTIME_CONFIG=false
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
# Gates every supabase.channel() subscription.
ARG VITE_ENABLE_REALTIME
# Where the Report Bug button files issues. Unset is survivable -- constants.js falls back to
# this repository -- but a fork that leaves it unset sends its reports to the wrong tracker.
ARG VITE_GITHUB_REPO_URL
# Where "View in Grafana" points from an active alert. Unset is survivable -- constants.js falls back
# to localhost:3002 -- but a deployment that has moved Grafana gets a dead link.
ARG VITE_GRAFANA_URL
# Offers the sign-up form on the auth screen.
ARG VITE_ALLOW_SIGNUP

RUN npm run build

# Stage 2: Serve static production assets using NGINX
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
