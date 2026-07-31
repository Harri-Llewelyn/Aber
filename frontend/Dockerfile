# Stage 1: Build Vite application
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_SUPABASE_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
# Gates every supabase.channel() subscription. Baked in at build time like the two above --
# Vite inlines import.meta.env at build, so this cannot be changed by restarting the
# container; flipping it requires rebuilding the frontend image.
ARG VITE_ENABLE_REALTIME
ENV VITE_ENABLE_REALTIME=$VITE_ENABLE_REALTIME

RUN npm run build

# Stage 2: Serve static production assets using NGINX
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
