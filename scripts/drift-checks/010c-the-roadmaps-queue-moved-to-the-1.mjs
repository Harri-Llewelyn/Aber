import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10c. The roadmap's queue moved to the 1.0 milestone, and `docs/roadmap.md` is what it left
// behind: the record of every retired entry and where its substance went. Two things are asserted.
// The README still names where the queue went, because a record nothing points at is a record
// nobody reads. And neither file carries a numbered entry heading -- one in the README means an
// entry was written back into it, one in the record means the file has been reopened as a queue,
// and either way there are two lists claiming to name what 1.0 needs, which is what the move
// removed.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const readme = read('README.md');
  const roadmap = 'docs/roadmap.md';

  const numbered = (text) =>
    text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^#{2,4} \d+ · /.test(l));

  const stranded = numbered(readme);

  if (stranded.length) {
    fail(
      `${stranded.length} numbered roadmap item(s) are still in README.md:\n` +
        stranded.map(([n, l]) => `        line ${n}: ${l.trim()}`).join('\n') +
        '\n      The queue is the 1.0 milestone. Open an issue on it rather than leaving the item\n' +
        '      in a file, which is how it stops being read.'
    );
  } else if (!existsSync(join(REPO, roadmap))) {
    fail(`${roadmap} is missing, and README.md's roadmap section points at it.`);
  } else if (!readme.includes(roadmap)) {
    fail(
      `README.md does not link to ${roadmap}. The section was moved out of the README on the ` +
        'understanding that the README still names where it went.'
    );
  } else {
    const record = read(roadmap);
    const reopened = numbered(record);
    const rows = record
      .split('\n')
      .filter((l) => l.startsWith('| ') && !/^\|\s*:?-/.test(l) && !/^\| Entry \|/.test(l));

    if (reopened.length) {
      fail(
        `${roadmap} carries ${reopened.length} numbered entry heading(s):\n` +
          reopened.map(([n, l]) => `        line ${n}: ${l.trim()}`).join('\n') +
          '\n      That file is the record of what retired, not a queue. Work that 1.0 needs is an\n' +
          '      issue on the 1.0 milestone.'
      );
    } else if (!rows.length) {
      fail(`${roadmap} records no entries -- expected "| entry | where it is now |" rows.`);
    } else {
      pass(`the roadmap record is ${roadmap} (${rows.length} entries), linked from README.md`);
    }
  }
}
