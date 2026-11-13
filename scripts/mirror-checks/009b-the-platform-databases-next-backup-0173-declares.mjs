import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 9b. The platform database's next backup. 0173 declares the historian's record and schedule
// functions in the platform database under the same names, and the Backups page runs the one
// nextHistorianBackup() for both, so section 9 covers the platform's sidecar only while each body is
// the historian's, the run kinds are the same, and platform_backup_state() counts an attempt as
// historian_backup_state() does.
export default function check() {
  const historian = read('timescaledb/physical_backup.sql');
  const flat = (text) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const fn = (text, name) => {
    const at = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return at < 0 ? null : flat(text.slice(at, text.indexOf('$;', at)));
  };
  for (const name of ['physical_backup_record', 'physical_backup_missed_slot', 'physical_backup_type',
    'physical_backup_record_schedule']) {
    const theirs = fn(historian, name);
    const ours = lastDefinition(`CREATE OR REPLACE FUNCTION public.${name}(`, '$;', `public.${name}() in the platform database`);
    if (!theirs) problems.push(`platformBackup: timescaledb/physical_backup.sql no longer declares ${name}()`);
    else if (ours && flat(ours.body) !== theirs) {
      problems.push(`platformBackup: ${name}() in ${ours.file} is not the historian's body (timescaledb/physical_backup.sql)`);
    } else if (ours) ok.push(`platformBackup: ${name}() in ${ours.file} is the historian's`);
  }
  const kinds = (text, what) => need(flat(text), /kind text NOT NULL CHECK \(kind IN \(([^)]*)\)\)/, what)?.[1];
  const ourTable = lastDefinition('CREATE TABLE IF NOT EXISTS public.physical_backup_runs', ');', 'physical_backup_runs in the platform database');
  if (ourTable) {
    compare('platformBackup', 'the run kinds', kinds(ourTable.body, `the run kinds in ${ourTable.file}`),
      kinds(historian, 'the run kinds in timescaledb/physical_backup.sql'));
  }
  const attempt = (needle) => {
    const state = lastDefinition(needle, '$;', needle.slice(27));
    return state && need(flat(state.body), /\(SELECT max\(b\.started_at\) FROM runs b WHERE b\.kind <> '(\w+)'\)/,
      `last_attempt_at in ${needle.slice(27)}`)?.[1];
  };
  compare('platformBackup', 'the run kind last_attempt_at leaves out',
    attempt('CREATE OR REPLACE FUNCTION public.platform_backup_state()'),
    attempt('CREATE OR REPLACE FUNCTION public.historian_backup_state()'));
}
