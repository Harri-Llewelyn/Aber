// The lock of the GPL and LGPL source archives Aber mirrors for the database images' base, and the
// GitHub release that holds them: one release per supabase/postgres tag. Read by
// scripts/mirror-gpl-sources.mjs, which publishes and verifies the release, and by
// scripts/check-image-licences.mjs, which holds the lock and the written offers to the images.
// licenses/README.md says why the mirror exists.

export const LOCK = 'licenses/supabase-postgres/sources.json';
export const RELEASE_REPO = 'Harri-Llewelyn/Aber';
export const BASE_IMAGE = 'supabase/postgres';
export const SUMS = 'SHA256SUMS';

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The release tag for a base tag. It must never match release.yml's `v*` trigger. */
export const releaseTag = (baseTag) => `gpl-sources-${BASE_IMAGE.replace('/', '-')}-${baseTag}`;
export const releaseUrl = (baseTag) => `https://github.com/${RELEASE_REPO}/releases/tag/${releaseTag(baseTag)}`;
export const releaseTitle = (baseTag) =>
  `GPL and LGPL source for ${BASE_IMAGE} ${baseTag}'s PostGIS and pgRouting`;

/**
 * The lock, parsed and checked: `base` is `supabase/postgres:<tag>`, and every asset names its
 * component, version, upstream https URL, a release asset name unique in the lock, its SHA-256 and
 * its size. Throws one Error listing every problem.
 */
export function parseLock(text) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (e) {
    throw new Error(`${LOCK} is not JSON: ${e.message}`);
  }
  const problems = [];
  const base = typeof lock?.base === 'string' && lock.base.startsWith(`${BASE_IMAGE}:`) ? lock.base.slice(BASE_IMAGE.length + 1) : '';
  if (!/^[\w][\w.-]*$/.test(base)) problems.push(`"base" is not "${BASE_IMAGE}:<tag>"`);
  if (!Array.isArray(lock?.assets) || !lock.assets.length) problems.push('"assets" is not a non-empty list');
  const names = new Set();
  (Array.isArray(lock?.assets) ? lock.assets : []).forEach((a, i) => {
    const at = `asset ${i + 1}${typeof a?.asset === 'string' ? ` (${a.asset})` : ''}`;
    for (const field of ['component', 'version']) {
      if (typeof a?.[field] !== 'string' || !a[field].trim()) problems.push(`${at} has no "${field}"`);
    }
    if (typeof a?.url !== 'string' || !/^https:\/\/[^\s]+$/.test(a.url)) problems.push(`${at}'s "url" is not an https URL`);
    if (typeof a?.asset !== 'string' || !ASSET_NAME.test(a.asset) || a.asset === SUMS) {
      problems.push(`${at}'s "asset" is not a file name a release can carry (and not ${SUMS})`);
    } else if (names.has(a.asset)) {
      problems.push(`${at} is named twice`);
    } else {
      names.add(a.asset);
    }
    if (typeof a?.sha256 !== 'string' || !SHA256.test(a.sha256)) problems.push(`${at}'s "sha256" is not 64 lower-case hex digits`);
    if (!Number.isSafeInteger(a?.size) || a.size <= 0) problems.push(`${at}'s "size" is not a positive whole number of bytes`);
  });
  if (problems.length) throw new Error(`${LOCK}:\n  ${problems.join('\n  ')}`);
  return { base, covers: typeof lock.covers === 'string' ? lock.covers : '', assets: lock.assets };
}

/** The SHA256SUMS asset: one `<sha256>  <asset>` line per archive, sorted by name. */
export function sumsFile(lock) {
  return [...lock.assets]
    .sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0))
    .map((a) => `${a.sha256}  ${a.asset}\n`)
    .join('');
}
