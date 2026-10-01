/*
 * Runtime configuration placeholder -- SHIPPED EMPTY ON PURPOSE.
 *
 * Vite copies public/ verbatim into dist/, so this file is served at /config.js in `npm run dev`,
 * in `vite preview` and from NGINX in the built image. index.html loads it as a classic script
 * before the module bundle, which guarantees it runs first.
 *
 * Every value below is blank, and blank means "not supplied". frontend/src/config.js then falls
 * through to the value Vite inlined at build time, which is what a plain `docker build` of the
 * image serves.
 *
 * A KUBERNETES DEPLOYMENT REPLACES THIS FILE, by mounting a ConfigMap over
 * /usr/share/nginx/html/config.js. That is what lets one frontend image serve any environment.
 * NGINX serves it `no-store` (see nginx.conf) so a redeployed config is never read from cache
 * while the hashed bundle around it is cached normally.
 *
 * The key set must match RUNTIME_SETTING_NAMES in src/config.js; runtimeConfig.test.js fails if
 * the two drift.
 */
window.__ABER_CONFIG__ = window.__ABER_CONFIG__ || {
  // The gateway as the BROWSER reaches it -- never the in-cluster address.
  VITE_SUPABASE_URL: '',
  // Public by design: this key is the `anon` role and is readable in any built bundle.
  VITE_SUPABASE_PUBLISHABLE_KEY: '',
  // "true" | "false". Gates every supabase.channel() subscription.
  VITE_ENABLE_REALTIME: '',
  // Repository the Report Bug button files against.
  VITE_GITHUB_REPO_URL: '',
  // Grafana as the BROWSER reaches it, for the "View in Grafana" links on active alerts. Same
  // origin as GRAFANA_PUBLIC_URL / GF_SERVER_ROOT_URL on the server side.
  VITE_GRAFANA_URL: '',
  // Supabase Studio's door as the BROWSER reaches it -- the same origin as STUDIO_PUBLIC_URL on
  // the server side, HOST INCLUDED. Used only to end Studio's own session at sign-out; cookies
  // ignore the port but not the host, so localhost and 127.0.0.1 are two different sessions.
  VITE_STUDIO_URL: '',
  // The forge's door as the BROWSER reaches it -- GITEA_ROOT_URL on the server side, host
  // included. The gateway drawer links to a repository under it, and sign-out beacons it.
  VITE_GITEA_URL: '',
  // Storage buckets, as named by scripts/storage-init.mjs (STORAGE_BUCKET and CAPTURE_BUCKET).
  // Blank falls through to the defaults in src/api.js, which are the same two names -- so a
  // deployment only sets these if it renamed a bucket.
  VITE_MODEL_3D_BUCKET: '',
  VITE_CAPTURE_BUCKET: '',
  // The chart's appVersion. Blank on a plain image build, which means the account menu says
  // nothing about drift -- there is no release to be out of step with.
  VITE_RELEASE_VERSION: '',
  // backup.retentionDays. Blank: the Backups page does not say which backups the window has passed.
  VITE_BACKUP_RETENTION_DAYS: '',
};
