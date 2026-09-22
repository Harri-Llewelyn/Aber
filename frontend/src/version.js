/**
 * The version of the codebase this bundle was built from. Baked at build time by `vite.config.js`
 * (build arg first, `git describe` second) rather than runtime-configured, because a version is a
 * property of the artefact and a deployment must not be able to state one its bundle is not.
 * `unknown` is a real answer: a build not given APP_VERSION cannot know.
 */

/** What `vite.config.js` injected, or undefined where nothing did. */
const INJECTED = import.meta.env.VITE_APP_VERSION;

/** The version string shown in the UI. Never empty -- see the note on `unknown` above. */
export const APP_VERSION =
  typeof INJECTED === 'string' && INJECTED.trim() !== '' ? INJECTED.trim() : 'unknown';

/** False when the build could not name itself, so callers can present that differently. */
export const VERSION_IS_KNOWN = APP_VERSION !== 'unknown';

/**
 * What the string means, for the tooltip. `git describe` reads `<tag>-<commits since it>-g<short
 * sha>` and collapses to a bare `<tag>` on a tagged commit.
 */
export const versionTitle = () =>
  VERSION_IS_KNOWN
    ? `Running Aber ${APP_VERSION} — the release tag this build came from, `
      + 'plus the commits since it and the commit id, as reported by git describe'
    : 'This build was not given a version at build time, so it cannot name itself. Rebuild with '
      + 'APP_VERSION=$(git describe --tags --always --dirty) to label it.';
