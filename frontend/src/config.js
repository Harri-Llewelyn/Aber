/**
 * Frontend configuration, resolved at RUNTIME first and build time second.
 *
 * WHY THIS EXISTS. Vite inlines `import.meta.env` when the bundle is built, so every setting the
 * dashboard needs used to be frozen into the image by `frontend/Dockerfile`'s build args. Under
 * Docker Compose that is invisible -- the image is built against the stack it will serve. Under
 * Kubernetes it means ONE IMAGE CANNOT SERVE TWO ENVIRONMENTS: a bundle built for staging carries
 * staging's Supabase URL wherever it is deployed, which defeats the build-once/promote-the-artefact
 * model that is most of the reason to run on Kubernetes at all.
 *
 * So the deployment gets a chance to speak first. `public/config.js` is a plain (non-module)
 * script that sets `window.__ACS_CYMRU_CONFIG__`; index.html loads it BEFORE the module bundle,
 * and a classic script always executes before a deferred module script, so the object is populated
 * before any of this evaluates. In Kubernetes that file is replaced by a ConfigMap mount; on
 * Compose it stays the shipped no-op and the build-time values win by falling through.
 *
 * BOTH PATHS ARE SUPPORTED ON PURPOSE, and neither is deprecated:
 *   - Compose / `npm run dev` bake the values, ship the placeholder, and behave exactly as before.
 *   - Kubernetes builds with VITE_RUNTIME_CONFIG=true, bakes nothing, and mounts a real config.js.
 *
 * KEYS ARE THE `VITE_*` NAMES, unchanged. A ConfigMap can then be generated from the same variable
 * names the Dockerfile and `.env` already use, and there is no second vocabulary to keep in step.
 */

/** The global a deployment-supplied `config.js` assigns. */
export const RUNTIME_CONFIG_GLOBAL = '__ACS_CYMRU_CONFIG__';

/**
 * Every setting resolvable through this module.
 *
 * `frontend/public/config.js` must declare exactly these keys -- `runtimeConfig.test.js` asserts
 * the two agree, the same drift guard `metricGroup.js` has against its SQL. A key added here and
 * forgotten there yields a placeholder that silently cannot be overridden at deploy time.
 */
export const RUNTIME_SETTING_NAMES = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  // The replacement for the key above, and OPTIONAL where that one is required. Supabase
  // deprecates the anon JWT by the end of 2026; the gateway accepts both formats at once, so a
  // deployment that has not minted the new pair leaves this empty and keeps working.
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_ENABLE_REALTIME',
  'VITE_GITHUB_REPO_URL',
  'VITE_GRAFANA_URL',
  // Supabase Studio's door, and the ONLY consumer is sign-out -- there is no "open Studio" link
  // in the dashboard for this to point at. See utils/studioSignOut.js for why the app has to
  // reach across to another origin to end a session it did not start.
  //
  // THE HOST HALF OF THIS VALUE IS LOAD-BEARING, in a way VITE_GRAFANA_URL's is not. Cookies are
  // scoped by HOST and ignore the port, so `http://localhost:54323` and `http://127.0.0.1:54323`
  // are the same door and DIFFERENT cookie jars: beaconing the wrong one of the two returns 302,
  // logs nothing, and clears no session. Both this and STUDIO_PUBLIC_URL must name the host the
  // browser actually used, which is why compose derives this from that one rather than repeating
  // a literal.
  'VITE_STUDIO_URL',
  // THE BUCKET NAMES, and they are settings for the same reason the URLs above are.
  //
  // Both were literals in api.js while every other consumer read them from the environment --
  // scripts/storage-init.mjs creates them from STORAGE_BUCKET / GATEWAY_BACKUP_BUCKET,
  // docker-compose and values.yaml pass those through, and storage-policies.sql names them. So a
  // deployment that renamed a bucket moved the creation, the policies and the server-side readers
  // together and left the dashboard reading the old name -- a 404 on upload, from the one
  // component nobody had listed as a consumer.
  'VITE_MODEL_3D_BUCKET',
  'VITE_GATEWAY_BACKUP_BUCKET',
  'VITE_CAPTURE_BUCKET',
];

/**
 * Build-time values, read through STATIC property accesses.
 *
 * This spelling is load-bearing. Vite substitutes `import.meta.env.VITE_FOO` textually during the
 * build; a dynamic `import.meta.env[name]` lookup is not a substitution site, so it would resolve
 * against whatever thin object survives into the bundle and read `undefined` for everything. Every
 * name in RUNTIME_SETTING_NAMES must therefore appear here literally.
 */
const BUILD_TIME_SETTINGS = {
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_ENABLE_REALTIME: import.meta.env.VITE_ENABLE_REALTIME,
  VITE_GITHUB_REPO_URL: import.meta.env.VITE_GITHUB_REPO_URL,
  VITE_GRAFANA_URL: import.meta.env.VITE_GRAFANA_URL,
  VITE_STUDIO_URL: import.meta.env.VITE_STUDIO_URL,
  VITE_MODEL_3D_BUCKET: import.meta.env.VITE_MODEL_3D_BUCKET,
  VITE_GATEWAY_BACKUP_BUCKET: import.meta.env.VITE_GATEWAY_BACKUP_BUCKET,
  VITE_CAPTURE_BUCKET: import.meta.env.VITE_CAPTURE_BUCKET,
};

/**
 * True for a value that is an unsubstituted template placeholder rather than a setting.
 *
 * A config.js rendered by `envsubst`, `sed` or Helm and then NOT substituted leaves the marker
 * behind, and a Supabase URL of `${VITE_SUPABASE_URL}` is worse than no value at all: the client
 * constructs, every request fails against a nonsense origin, and nothing names the cause. Treating
 * it as absent falls through to the build-time value, or to the explicit throw below.
 *
 * Same guard as `supabase-kong-init`'s `grep -q '__SUPABASE_'` check, for the same reason.
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
 * The Supabase origin and anon key.
 *
 * These THROW when unresolvable rather than defaulting, unchanged from when they were read
 * straight off `import.meta.env`: the dashboard cannot function without them and should say so
 * once, loudly, instead of failing per request. The message names both sources because with two
 * of them "which one did you forget" is the actual question.
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
export const SUPABASE_ANON_KEY = required('VITE_SUPABASE_ANON_KEY');

/**
 * THE KEY THE BROWSER ACTUALLY PRESENTS -- the new publishable format where this deployment has
 * one, the legacy anon key where it does not.
 *
 * NOT `required()`, deliberately, and that asymmetry is the migration. Both formats are accepted
 * by the gateway at once so consumers move one at a time; making this mandatory would turn that
 * into a flag day and break every install that has not minted the pair.
 *
 * THE ANON KEY STAYS REQUIRED because it is still the fallback. It stops being required when the
 * legacy pair is deactivated, which is a later step and a deliberate one.
 *
 * `supabase-js` sends this as the bearer as well as the apikey when there is no session. That is
 * safe for an opaque key: the gateway synthesises the JWT the upstreams need. See
 * docs/gateway-migration.md.
 */
export const SUPABASE_GATEWAY_KEY =
  readSetting('VITE_SUPABASE_PUBLISHABLE_KEY') || SUPABASE_ANON_KEY;
