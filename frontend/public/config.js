/*
 * Runtime configuration placeholder -- SHIPPED EMPTY ON PURPOSE.
 *
 * Vite copies public/ verbatim into dist/, so this file is served at /config.js in `npm run dev`,
 * in `vite preview` and from NGINX in the built image. index.html loads it as a classic script
 * before the module bundle, which guarantees it runs first.
 *
 * Every value below is blank, and blank means "not supplied". frontend/src/config.js then falls
 * through to the value Vite inlined at build time, which is how the Docker Compose path keeps
 * working exactly as it did before this file existed.
 *
 * A KUBERNETES DEPLOYMENT REPLACES THIS FILE, by mounting a ConfigMap over
 * /usr/share/nginx/html/config.js. That is what lets one frontend image serve any environment.
 * NGINX serves it `no-store` (see nginx.conf) so a redeployed config is never read from cache
 * while the hashed bundle around it is cached normally.
 *
 * The key set must match RUNTIME_SETTING_NAMES in src/config.js; runtimeConfig.test.js fails if
 * the two drift.
 */
window.__FACTORYPLUS_CONFIG__ = window.__FACTORYPLUS_CONFIG__ || {
  // Supabase API gateway (Kong) as the BROWSER reaches it -- never the in-cluster address.
  VITE_SUPABASE_URL: '',
  // Public by design: this key is the `anon` role and is readable in any built bundle.
  VITE_SUPABASE_ANON_KEY: '',
  // "true" | "false". Gates every supabase.channel() subscription.
  VITE_ENABLE_REALTIME: '',
  // Repository the Report Bug button files against.
  VITE_GITHUB_REPO_URL: '',
  // "true" | "false". Offers the sign-up form on the auth screen.
  VITE_ALLOW_SIGNUP: '',
};
