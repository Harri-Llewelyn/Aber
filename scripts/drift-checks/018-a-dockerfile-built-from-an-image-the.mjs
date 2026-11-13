import { allFiles, chartPins, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 18. A Dockerfile built FROM an image the chart also runs is pinned to the chart's tag.
//
// THE COUPLING IS REAL AND SILENT WHEN BROKEN. `backup-service` and `db-init` are built FROM
// `supabase/postgres` for their `pg_dump` and their `psql`: a client older than the server
// mis-handles what it is given, and a backup taken by an older `pg_dump` restores wrong rather
// than failing. `gateway-credential` is built FROM `eclipse-mosquitto` for `mosquitto_passwd` and
// `mosquitto_rr`, whose hash format and control protocol are the broker's own.
//
// This is what `check-image-tag-parity.mjs` held against the retired Compose file. The chart is
// the only remaining declaration of these versions, so the check belongs here (#339).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dockerfiles = allFiles.filter((f) => f.endsWith('Dockerfile') && !f.startsWith('frontend/dist/'));
  // `node` is a runtime, not a peer: the storage-init Job runs one script on it, and nothing built
  // FROM node exchanges a format or a protocol with that Job.
  const UNCOUPLED = new Set(['node']);
  const offences = [];
  let coupled = 0;
  for (const file of dockerfiles) {
    for (const m of read(file).matchAll(/^FROM\s+(\S+)/gm)) {
      const ref = m[1];
      if (ref.includes('${')) continue;           // a build arg, resolved by the caller
      const at = ref.indexOf('@');                // a digest pin carries its own guarantee
      const bare = at === -1 ? ref : ref.slice(0, at);
      const colon = bare.lastIndexOf(':');
      if (colon === -1) continue;
      const repo = bare.slice(0, colon);
      const tag = bare.slice(colon + 1);
      if (!chartPins.has(repo) || UNCOUPLED.has(repo)) continue;
      coupled += 1;
      if (chartPins.get(repo) !== tag) {
        offences.push(
          `${file} is FROM ${repo}:${tag}, but the chart runs ${repo}:${chartPins.get(repo)}`
        );
      }
    }
  }
  if (offences.length) {
    fail(
      'an image is built FROM a different version than the chart runs:\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else if (coupled === 0) {
    fail(
      'no Dockerfile is built FROM an image the chart pins. Either a base moved off a pinned ' +
        'image or this check has stopped finding them; both remove a guard silently.'
    );
  } else {
    pass(`all ${coupled} image base(s) shared with the chart agree with its pins`);
  }
}
