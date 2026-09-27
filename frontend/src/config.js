/**
 * Frontend configuration, resolved at runtime first and build time second.
 *
 * Vite inlines `import.meta.env` at build, so a bundle built for one environment carries that
 * environment's Supabase URL wherever it is deployed. `public/config.js` is a plain script that
 * sets `window.__ABER_CONFIG__` and is loaded before the module bundle; the chart replaces
 * it with a ConfigMap mount, and a plain image build ships the no-op so the build-time values
 * win. Keys are the `VITE_*` names, so the ConfigMap is generated from the same variable names
 * the Dockerfile uses.
 */

/** The global a deployment-supplied `config.js` assigns. */
const RUNTIME_CONFIG_GLOBAL = '__ABER_CONFIG__';

/**
 * Every setting resolvable through this module. `frontend/public/config.js` must declare exactly
 * these keys; `runtimeConfig.test.js` asserts the two agree.
 */
export const RUNTIME_SETTING_NAMES = [
  'VITE_SUPABASE_URL',
  // The key the browser presents at the gateway; public by construction.
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_ENABLE_REALTIME',
  'VITE_GITHUB_REPO_URL',
  'VITE_GRAFANA_URL',
  // Supabase Studio's door; the only consumer is sign-out (utils/studioSignOut.js). The host half
  // is load-bearing: cookies are scoped by host and ignore the port, so `localhost` and
  // `127.0.0.1` are different cookie jars, and this and STUDIO_PUBLIC_URL must name the host the
  // browser used.
  'VITE_STUDIO_URL',
  // The forge's door: a link from the gateway drawer, and a sign-out beacon like Studio's.
  'VITE_GITEA_URL',
  // The bucket names, settings for the same reason the URLs are: scripts/storage-init.mjs,
  // values.yaml and storage-policies.sql both read them from the environment, and a
  // literal here was the one consumer a rename left behind.
  'VITE_MODEL_3D_BUCKET',
  'VITE_CAPTURE_BUCKET',
  // The chart's appVersion -- what the RELEASE says it is, as against `src/version.js`, which is
  // what this BUNDLE is. A runtime setting on purpose: it is a property of the deployment, and the
  // two disagreeing is the fact utils/releaseVersion.js reports.
  'VITE_RELEASE_VERSION',
];

/**
 * Build-time values, read through static property accesses: Vite substitutes
 * `import.meta.env.VITE_FOO` textually, and a dynamic lookup reads `undefined` for everything.
 * Every name in RUNTIME_SETTING_NAMES must appear here literally.
 */
const BUILD_TIME_SETTINGS = {
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_ENABLE_REALTIME: import.meta.env.VITE_ENABLE_REALTIME,
  VITE_GITHUB_REPO_URL: import.meta.env.VITE_GITHUB_REPO_URL,
  VITE_GRAFANA_URL: import.meta.env.VITE_GRAFANA_URL,
  VITE_STUDIO_URL: import.meta.env.VITE_STUDIO_URL,
  VITE_GITEA_URL: import.meta.env.VITE_GITEA_URL,
  VITE_MODEL_3D_BUCKET: import.meta.env.VITE_MODEL_3D_BUCKET,
  VITE_CAPTURE_BUCKET: import.meta.env.VITE_CAPTURE_BUCKET,
  VITE_RELEASE_VERSION: import.meta.env.VITE_RELEASE_VERSION,
};

/**
 * True for a value that is an unsubstituted template placeholder. A config.js rendered but not
 * substituted leaves the marker behind, and a Supabase URL of `${VITE_SUPABASE_URL}` fails every
 * request against a nonsense origin; treating it as absent falls through to the build-time value
 * or the explicit throw below.
 */
const PLACEHOLDER = /^(\$\{[^}]*\}|__[A-Z0-9_]+__)$/;

const isUsable = (value) =>
  typeof value === 'string' && value.trim() !== '' && !PLACEHOLDER.test(value.trim());

/** The deployment-supplied config object, or `{}` when none was injected. */
export function runtimeConfig(scope = globalThis) {
  const supplied = scope?.[RUNTIME_CONFIG_GLOBAL];
  return supplied && typeof supplied === 'object' ? supplied : {};
}

/**
 * Resolve one setting: runtime injection, then build-time inlining, then `fallback`.
 *
 * @param {string} name  a `VITE_*` key from RUNTIME_SETTING_NAMES
 * @param {string} [fallback]  used when neither source supplies a usable value
 */
export function readSetting(name, fallback = undefined) {
  const injected = runtimeConfig()[name];
  if (isUsable(injected)) return injected.trim();

  const baked = BUILD_TIME_SETTINGS[name];
  if (isUsable(baked)) return baked.trim();

  return fallback;
}

/** Resolve a flag. Absent is false, matching the `=== 'true'` comparisons this replaces. */
export const readFlag = (name, fallback = false) => {
  const value = readSetting(name);
  return value === undefined ? fallback : value.toLowerCase() === 'true';
};

/**
 * The Supabase origin and publishable key. These throw when unresolvable rather than defaulting:
 * the dashboard cannot function without them and should say so once. The message names both
 * sources.
 */
function required(name) {
  const value = readSetting(name);
  if (value === undefined) {
    throw new Error(
      `[FATAL] ${name} is not configured. Supply it at build time (frontend/Dockerfile build arg) ` +
        `or at runtime via window.${RUNTIME_CONFIG_GLOBAL} in /config.js.`
    );
  }
  return value;
}

export const SUPABASE_URL = required('VITE_SUPABASE_URL');
/**
 * The key the browser presents. `supabase-js` sends it as the bearer as well as the apikey when
 * there is no session, which is safe for an opaque key because the gateway synthesises the JWT
 * the upstreams need (docs/gateway.md).
 */
export const SUPABASE_GATEWAY_KEY = required('VITE_SUPABASE_PUBLISHABLE_KEY');
