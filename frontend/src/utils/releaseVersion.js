/**
 * Whether this page is the release the stack deployed: `src/version.js` is what this bundle is,
 * `VITE_RELEASE_VERSION` (the chart's appVersion, through the mounted `config.js`) is what the
 * release says it is. They disagree when `frontend.image.tag` is pinned or overridden, or when the
 * browser holds a bundle cached from before an upgrade; a forced reload fixes the second. Nothing
 * here reaches the network.
 */
import { readSetting } from '../config'

/**
 * The leading `MAJOR.MINOR.PATCH`, or null. Both sides are compared on this alone: the bundle's
 * string is `git describe` output on a development build (`v0.1.0-752-g04374f9-dirty`), and
 * treating the commit suffix as a difference would put a warning on every dev cluster permanently.
 */
const CORE = /^v?(\d+)\.(\d+)\.(\d+)/

function core (version) {
  const m = CORE.exec(String(version ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export const RELEASE_STATES = {
  IN_STEP: 'in-step',
  BEHIND: 'behind',
  AHEAD: 'ahead',
  UNKNOWN: 'unknown',
}

/** The chart's appVersion, or null where nothing supplied one (a plain image build). */
export function releaseVersion () {
  return readSetting('VITE_RELEASE_VERSION') ?? null
}

/**
 * `unknown` is a real answer and is rendered as nothing: an unlabelled build, or a deployment that
 * supplies no release version, is not evidence of drift and must not be shown as though it were.
 */
export function releaseDrift (bundleVersion, release) {
  const a = core(bundleVersion)
  const b = core(release)
  if (!a || !b) return RELEASE_STATES.UNKNOWN

  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return RELEASE_STATES.BEHIND
    if (a[i] > b[i]) return RELEASE_STATES.AHEAD
  }
  return RELEASE_STATES.IN_STEP
}

/** The line under the version, or null when there is nothing to say. */
export function releaseDriftLabel (state, release) {
  if (state === RELEASE_STATES.BEHIND) return `Update available — ${release}`
  if (state === RELEASE_STATES.AHEAD) return `Newer than the release — ${release}`
  return null
}

export function releaseDriftTitle (state, release) {
  if (state === RELEASE_STATES.BEHIND) {
    return `This stack deployed ${release} and you are being served an older build. Usually a page `
      + 'cached from before the upgrade — force a reload. If it survives that, the frontend image '
      + 'is not the one the release names, which means frontend.image.tag is pinned.'
  }
  if (state === RELEASE_STATES.AHEAD) {
    return `This stack deployed ${release} and you are being served a newer build than that — `
      + 'normally a pinned frontend.image.tag, or a rollback that left the image behind.'
  }
  return undefined
}
