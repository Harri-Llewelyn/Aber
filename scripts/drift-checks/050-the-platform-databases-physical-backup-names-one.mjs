import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 50. The platform database's physical backup names one stanza and one base everywhere.
//
// The stanza is `platform` in the chart's archive_command and pgbackrest.conf, the sidecar's
// schedule and both restore scripts; a script naming another restores nothing and says the
// repository is empty. And the restore rehearsal runs the upstream platform image rather than
// building the chart's (.github/rehearsal-values.yaml), so, as check 26 holds the historian's, it has
// to be the one supabase/db/Dockerfile is built FROM. Check 18 holds that FROM to supabaseDb.image.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const STANZA = 'platform';
  const sites = {
    'deploy/helm/aber/templates/_helpers.tpl': [
      /define "aber\.platformBackupServerArgs"[\s\S]*?archive_command=pgbackrest --stanza=(\w+) archive-push/,
      /define "aber\.platformPgbackrestConf"[\s\S]*?\n\[(\w+)\]\n/,
    ],
    'supabase/db/pgbackrest/platform-backup.sh': [/^STANZA=(\w+)$/m],
    'scripts/restore-platform-db.mjs': [/^const STANZA = '(\w+)';$/m],
    'scripts/rehearse-platform-restore.mjs': [/'--stanza=(\w+)'/],
  };
  const offences = [];
  for (const [file, patterns] of Object.entries(sites)) {
    for (const re of patterns) {
      const m = read(file).match(re);
      if (!m) offences.push(`${file} no longer matches ${re}; check 50 cannot see its stanza`);
      else if (m[1] !== STANZA) offences.push(`${file} names the stanza ${m[1]}, not ${STANZA}`);
    }
  }
  const from = read('supabase/db/Dockerfile').match(/^FROM\s+(\S+):(\S+)/m);
  const rehearsal = read('.github/rehearsal-values.yaml')
    .match(/^supabaseDb:\s*\n\s+serverImage:\s*\n\s+repository:\s*(\S+)\s*\n\s+tag:\s*(\S+)/m);
  if (!from || !rehearsal) {
    offences.push('could not read the platform base from supabase/db/Dockerfile and .github/rehearsal-values.yaml');
  } else if (from[1] !== rehearsal[1] || from[2] !== rehearsal[2]) {
    offences.push(`the restore rehearsal runs ${rehearsal[1]}:${rehearsal[2]}, but the platform image is built FROM ${from[1]}:${from[2]}`);
  }
  if (offences.length) {
    fail('the platform database\'s physical backup disagrees with itself:\n' + offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`the platform database's stanza is ${STANZA} in all ${Object.keys(sites).length} places, and the rehearsal runs its base (${from[2]})`);
  }
}
