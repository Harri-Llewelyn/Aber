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
 * script that sets `window.__FACTORYPLUS_CONFIG__`; index.html loads it BEFORE the module bundle,
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
export const RUNTIME_CONFIG_GLOBAL = '__FACTORYPLUS_CONFIG__';

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
  'VITE_ENABLE_REALTIME',
  'VITE_GITHUB_REPO_URL',
  'VITE_ALLOW_SIGNUP',
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
  VITE_ENABLE_REALTIME: import.meta.env.VITE_ENABLE_REALTIME,
  VITE_GITHUB_REPO_URL: import.meta.env.VITE_GITHUB_REPO_URL,
  VITE_ALLOW_SIGNUP: import.meta.env.VITE_ALLOW_SIGNUP,
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
