import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11. frontend/Dockerfile's build args are the set we have deliberately decided are not secrets.
//
// That Dockerfile carries `# check=skip=SecretsUsedInArgOrEnv`, which switches off BuildKit's
// warning for the whole file; it is justified for VITE_SUPABASE_PUBLISHABLE_KEY alone. The skip is
// paired with this allowlist so adding an ARG is the moment to ask whether the skip still holds.
// Vite only inlines `VITE_`-prefixed variables.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FRONTEND_BUILD_ARGS = new Set([
    'VITE_RUNTIME_CONFIG',   // selects baked vs runtime config; not a credential
    'VITE_SUPABASE_URL',     // an endpoint, public
    // Public by construction: it is readable in any built bundle, and is the reason for the
    // skip. `sb_secret_*` is NOT here and must never be -- see the Dockerfile.
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'VITE_ENABLE_REALTIME',  // feature flag
    'VITE_GITHUB_REPO_URL',  // issue tracker URL
    'VITE_GRAFANA_URL',      // an endpoint, public
    'VITE_STUDIO_URL',       // an endpoint, public -- reached only to end Studio's own session
    'VITE_GITEA_URL',        // an endpoint, public -- the forge's door; a link and a sign-out beacon
    'VITE_MODEL_3D_BUCKET',       // a bucket name, public -- the objects in it are public-read
    'VITE_APP_VERSION',      // a git describe string, shown in the UI on purpose
    // A BuildKit switch, not a value: opts the build stage into the release's SBOM scan. Not
    // VITE_-prefixed, so Vite never inlines it.
    'BUILDKIT_SBOM_SCAN_STAGE',
  ]);

  const df = read('frontend/Dockerfile');
  const skipped = /^#\s*check=skip=([A-Za-z,]+)/m.exec(df);
  const declared = new Set(
    [...df.matchAll(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1])
  );

  if (!skipped) {
    // Not an error: if the skip is gone the allowlist is no longer load-bearing. Say so rather
    // than silently keeping a check whose premise has been removed.
    pass('frontend/Dockerfile has no check=skip directive (allowlist not required)');
  } else if (skipped[1] !== 'SecretsUsedInArgOrEnv') {
    fail(
      `frontend/Dockerfile skips BuildKit rules "${skipped[1]}". Only SecretsUsedInArgOrEnv is\n` +
        '      justified there; widening the skip hides checks nobody has reasoned about.'
    );
  } else {
    const added = [...declared].filter((a) => !FRONTEND_BUILD_ARGS.has(a));
    const removed = [...FRONTEND_BUILD_ARGS].filter((a) => !declared.has(a));
    if (added.length) {
      fail(
        `frontend/Dockerfile declares ARG(s) not in the allowlist: ${added.join(', ')}.\n` +
          '      SecretsUsedInArgOrEnv is skipped for that whole file, so a genuinely sensitive\n' +
          '      value added there would raise NO warning. Confirm it is safe to inline into a\n' +
          '      public browser bundle, then add it to FRONTEND_BUILD_ARGS in this script.'
      );
    } else if (removed.length) {
      fail(
        `FRONTEND_BUILD_ARGS lists ARG(s) frontend/Dockerfile no longer declares: ${removed.join(', ')}.`
      );
    } else {
      pass(`all ${declared.size} frontend build args are on the reviewed non-secret allowlist`);
    }
  }
}
