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
#      it from window.__FACTORYPLUS_CONFIG__ at load. This is what allows ONE image to serve any
#      environment, which a baked bundle cannot do.
#
# Both paths run the same code -- src/config.js prefers the runtime value and falls through to the
# baked one -- so a runtime-config image handed a config.js is fully configured, and a baked image
# with the shipped no-op placeholder behaves exactly as it did before runtime config existed.
ARG VITE_RUNTIME_CONFIG=false
ENV VITE_RUNTIME_CONFIG=$VITE_RUNTIME_CONFIG

ARG VITE_SUPABASE_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
# Gates every supabase.channel() subscription.
ARG VITE_ENABLE_REALTIME
ENV VITE_ENABLE_REALTIME=$VITE_ENABLE_REALTIME
# Where the Report Bug button files issues. Unset is survivable -- constants.js falls back to
# this repository -- but a fork that leaves it unset sends its reports to the wrong tracker.
ARG VITE_GITHUB_REPO_URL
ENV VITE_GITHUB_REPO_URL=$VITE_GITHUB_REPO_URL
# Offers the sign-up form on the auth screen.
ARG VITE_ALLOW_SIGNUP
ENV VITE_ALLOW_SIGNUP=$VITE_ALLOW_SIGNUP

RUN npm run build

# Stage 2: Serve static production assets using NGINX
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
