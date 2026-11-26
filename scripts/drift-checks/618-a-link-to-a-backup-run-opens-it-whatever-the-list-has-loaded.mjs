import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 618. A link to a backup run opens its panel whatever the list has loaded, as the help says. The
// list holds the newest 30 runs and a pinned backup is kept until it is released, so its run is often
// older than that. The page reads a run its address names on its own, through the list's own query
// so the panel has what a row has; a status filter that leaves it out is cleared on arrival; and a
// run nobody has opens the panel to say so.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems618 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const page = flat(read('frontend/src/components/tabs/BackupsTab.jsx'));
  const api = flat(read('frontend/src/api.js'));
  const help = flat(read('help/pages/backups.md'));

  const at = api.indexOf('backupRun: async (id) =>');
  if (at < 0) problems618.push('api.js has no backupRun(id)');
  else if (!api.slice(at, at + 200).includes('api.listBackupRuns({ id, limit: 1 })')) {
    problems618.push("api.js's backupRun() does not read through listBackupRuns({ id }), so its run may differ from a row's");
  }
  if (!page.includes('api.backupRun(id)')) problems618.push('BackupsTab.jsx does not read a run the address names on its own');
  if (!page.includes('useArrivalSelection(selectedId,') || !page.includes('onFilter(ANY_STATUS)')) {
    problems618.push('BackupsTab.jsx does not clear a status filter that leaves out the run it arrives on');
  }
  const absent = 'No finished backup run has this id.';
  if (!page.includes(absent)) problems618.push(`BackupsTab.jsx's panel does not say "${absent}"`);

  const said = [
    '**A link to a run** opens its panel',
    'even when the run is older than the runs loaded',
    'A status filter in the link that leaves the run out is cleared.',
    'A link to a run that does not exist opens the panel to say so.',
  ];
  for (const s of said) if (!help.includes(s)) problems618.push(`help/pages/backups.md does not say "${s}"`);

  if (problems618.length) {
    fail(`A link to a backup run is not opened as the help says:\n${problems618.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('a link to a backup run opens it alone, through the list\'s query, clearing a filter that hides it, and the help says so');
  }
}
