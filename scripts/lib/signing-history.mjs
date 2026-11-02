/**
 * When a release began signing tokens ES256, read from Helm's history of it. A token issued before
 * then (a machine identity's from Access Control, the Read-only API client's) was signed HS256, and
 * from 1.8.0 no service accepts it. The issue record (0043) does not say how a token was signed, so
 * `npm run keys:check` compares its issue time with this.
 *
 * A revision signs ES256 when its chart is 1.8.0 or later, or its values turn
 * supabaseAuth.es256Signing on. Helm keeps the last ten revisions, so a switch older than all of
 * them is known only as "on or before" the oldest one.
 */
import { spawnSync } from 'node:child_process';

/** Whether a chart name such as aber-1.8.0 or aber-1.8.0-ci.g1234abcd is 1.8.0 or later. */
export function chartSignsEs256(chart) {
  const m = /-(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(chart || ''));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 1 || (major === 1 && minor >= 8);
}

/**
 * From `helm history -o json` (any order) and a function giving a revision's user-supplied values:
 * since when the release has signed ES256 without a break.
 *
 * @returns {{since: Date|null, exact: boolean}} since null: the newest revision does not sign ES256.
 *   exact false: every revision Helm kept signs ES256, and the oldest is not the install.
 */
export function es256SinceFrom(history, valuesOf) {
  const revisions = [...history].sort((a, b) => a.revision - b.revision);
  const signs = (r) => chartSignsEs256(r.chart) || valuesOf(r.revision)?.supabaseAuth?.es256Signing === true;
  let first = null;
  for (let i = revisions.length - 1; i >= 0 && signs(revisions[i]); i--) first = i;
  if (first === null) return { since: null, exact: true };
  const at = new Date(revisions[first].updated);
  return { since: at, exact: first > 0 || revisions[first].revision === 1 };
}

/** es256SinceFrom() for a live release, or `{ error }` when Helm cannot say. */
export function readEs256Since(release, namespace) {
  const helm = (...args) => spawnSync('helm', [...args, '-n', namespace, '-o', 'json'], { encoding: 'utf8' });
  const history = helm('history', release);
  if (history.status !== 0) return { error: `helm history ${release} failed: ${(history.stderr || history.error?.message || '').trim()}` };
  try {
    return es256SinceFrom(JSON.parse(history.stdout), (revision) => {
      const values = helm('get', 'values', release, '--revision', String(revision));
      return values.status === 0 ? JSON.parse(values.stdout || 'null') : null;
    });
  } catch (err) {
    return { error: `could not read helm history ${release}: ${err.message}` };
  }
}
