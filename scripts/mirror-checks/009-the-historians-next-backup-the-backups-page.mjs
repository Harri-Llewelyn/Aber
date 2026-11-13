import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, lastDefinition, need, ok, problems, read, ROOT } from './lib.mjs';

// 9. The historian's next backup. The Backups page says when the sidecar takes its next backup and
// which type by running nextHistorianBackup(); the sidecar decides with physical_backup_missed_slot()
// and physical_backup_type() in timescaledb/physical_backup.sql. The page's function is run at the
// boundary each SQL rule states, so a re-tuned threshold or a flipped comparison fails here rather
// than as a page promising a backup the sidecar will not take.
export default async function check() {
  const { nextHistorianBackup } = await import(
    pathToFileURL(join(ROOT, 'frontend/src/utils/historianBackupSchedule.js')).href
  );
  const sql = read('timescaledb/physical_backup.sql');
  const flatBody = (name) => {
    const at = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return at < 0 ? '' : sql.slice(at, sql.indexOf('$;', at)).replace(/\s+/g, ' ');
  };
  const slotSql = flatBody('physical_backup_missed_slot');
  const typeSql = flatBody('physical_backup_type');
  const utcSlot = need(slotSql,
    /date_trunc\('day', p_now AT TIME ZONE 'UTC'\) \+ make_interval\(hours => p_hour\)/,
    'the UTC daily slot in physical_backup_missed_slot()');
  const slotRule = need(slotSql, /CASE WHEN at (<=?) p_now THEN at ELSE at - interval '(\d+) days?' END/,
    'the latest-slot rule in physical_backup_missed_slot()');
  const attemptRule = need(slotSql, /r\.kind IN \(([^)]*)\) AND r\.started_at (>=?) s\.at/,
    'the attempted-since rule in physical_backup_missed_slot()');
  const weekdayRule = need(typeSql,
    /WHEN extract\(dow FROM p_slot AT TIME ZONE 'UTC'\) = p_full_on THEN 'full'/,
    'the weekday rule in physical_backup_type()');
  const ageRule = need(typeSql, /WHEN f\.newest IS NULL OR f\.newest (<=?) p_now - interval '(\d+) days' THEN 'full'/,
    'the no-full and age rules in physical_backup_type()');

  const DAY = 24 * 60 * 60 * 1000;
  const HOUR_UTC = 2;
  const slot = Date.UTC(2026, 0, 7, HOUR_UTC);
  const iso = (ms) => new Date(ms).toISOString();
  const dow = (ms) => new Date(ms).getUTCDay();
  // Attempted at the slot, so the next is tomorrow's, `at`; full_on is then never at's weekday
  // unless a probe sets it.
  const at = slot + DAY;
  const offDay = (dow(at) + 3) % 7;
  const plan = (fields, now) => nextHistorianBackup({ hour_utc: HOUR_UTC, full_on: offDay, ...fields }, now);
  const kindWith = (lastFull, fullOn = offDay) =>
    plan({ last_attempt_at: iso(slot), last_full_at: lastFull === null ? null : iso(lastFull), full_on: fullOn }, slot + 3_600_000).kind;

  if (utcSlot && slotRule) {
    const onTheSlot = plan({ last_full_at: iso(slot - DAY) }, slot);
    compare('historianBackup', 'a slot reached exactly is today\'s (at <= now)',
      onTheSlot.at === slot ? '<=' : '<', slotRule[1]);
    const before = plan({ last_full_at: iso(slot - DAY) }, slot - 1);
    compare('historianBackup', 'the step back to the previous slot (days)', (slot - before.at) / DAY, slotRule[2]);
  }
  if (attemptRule) {
    const atSlot = plan({ last_attempt_at: iso(slot), last_full_at: iso(slot - DAY) }, slot + 3_600_000);
    const earlier = plan({ last_attempt_at: iso(slot - 1), last_full_at: iso(slot - DAY) }, slot + 3_600_000);
    if (!earlier.due) {
      problems.push('historianBackup: the page counts an attempt before the slot as one since it; the sidecar does not');
    } else {
      compare('historianBackup', 'an attempt at the slot counts (started_at >= slot)', atSlot.due ? '>' : '>=', attemptRule[2]);
    }

    // The page reads last_attempt_at from historian_backup_state(), every run but one kind; the
    // sidecar counts the kinds in its IN list. They agree while that list is every other kind.
    const runKinds = need(sql, /kind\s+text\s+NOT NULL CHECK \(kind IN \(([^)]*)\)\)/, 'the run kinds in physical_backup_runs');
    const state = lastDefinition('CREATE OR REPLACE FUNCTION public.historian_backup_state()', '$;',
      'public.historian_backup_state()');
    const excluded = state && need(state.body.replace(/\s+/g, ' '),
      /\(SELECT max\(b\.started_at\) FROM runs b WHERE b\.kind <> '(\w+)'\)/,
      `last_attempt_at in historian_backup_state() (${state.file})`);
    if (runKinds && excluded) {
      const list = (s) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort().join(',');
      const counted = list(runKinds[1]).split(',').filter((k) => k !== excluded[1]).join(',');
      compare('historianBackup', `the run kinds that count as an attempt, from ${state.file}`, counted, list(attemptRule[1]));
    }
  }
  if (weekdayRule) {
    if (kindWith(slot - DAY, dow(at)) !== 'full' || kindWith(slot - DAY) !== 'diff') {
      problems.push('historianBackup: the page does not take a full on full_on\'s UTC weekday and a differential otherwise, as the sidecar does');
    } else {
      ok.push('historianBackup: a full on full_on\'s UTC weekday on both sides');
    }
  }
  if (ageRule) {
    if (kindWith(null) !== 'full') {
      problems.push('historianBackup: with no full yet the page expects a differential; the sidecar takes a full');
    }
    let days = null;
    for (let n = 1; n <= 60 && days === null; n += 1) {
      if (kindWith(at - n * DAY - 1) === 'full' && kindWith(at - n * DAY + 1) === 'diff') days = n;
    }
    const op = days === null ? '?' : kindWith(at - days * DAY) === 'full' ? '<=' : '<';
    compare('historianBackup', 'a full when the newest is older than', `${op} ${days} days`, `${ageRule[1]} ${ageRule[2]} days`);
  }
}
