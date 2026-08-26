/**
 * The version of the codebase this bundle was built from (issue #57).
 *
 * WHY THIS IS BAKED AND NOT RUNTIME-CONFIGURABLE, unlike everything in config.js. A Supabase URL
 * legitimately differs per deployment, which is the whole reason `window.__ACS_CYMRU_CONFIG__`
 * exists. A version does not: it is a property of the ARTEFACT, fixed the moment the bundle is
 * built. Routing it through the ConfigMap would let a deployment state a version its bundle is not
 * -- and a traceability figure that can be made to lie is worse than no figure, because the whole
 * value of showing it is that somebody can trust it when reporting a fault.
 *
 * So there is exactly one source: `vite.config.js` resolves it at build time and injects it. See
 * that file for the order it tries -- the build arg first, `git describe` second.
 *
 * `unknown` IS A REAL ANSWER AND IS RENDERED AS ONE. A Compose build that was not given
 * APP_VERSION cannot know what it is, and the honest report is to say so rather than to fall back
 * to a hardcoded number that would then be wrong in exactly the situation somebody is reading it:
 * chasing a fault in a build nobody labelled.
 */

/** What `vite.config.js` injected, or undefined where nothing did. */
const INJECTED = import.meta.env.VITE_APP_VERSION;

/** The version string shown in the UI. Never empty -- see the note on `unknown` above. */
export const APP_VERSION =
  typeof INJECTED === 'string' && INJECTED.trim() !== '' ? INJECTED.trim() : 'unknown';

/** False when the build could not name itself, so callers can present that differently. */
export const VERSION_IS_KNOWN = APP_VERSION !== 'unknown';

/**
 * What the string means, for the tooltip.
 *
 * `git describe` reads `<tag>-<commits since it>-g<short sha>` and collapses to a bare `<tag>` on a
 * tagged commit, so the long form is not a defect -- it is the tag plus how far past it this build
 * is, which before a 1.0 release is the more useful of the two.
 */
export const versionTitle = () =>
  VERSION_IS_KNOWN
    ? `Running ACS-Cymru ${APP_VERSION} — the release tag this build came from, `
      + 'plus the commits since it and the commit id, as reported by git describe'
    : 'This build was not given a version at build time, so it cannot name itself. Rebuild with '
      + 'APP_VERSION=$(git describe --tags --always --dirty) to label it.';
