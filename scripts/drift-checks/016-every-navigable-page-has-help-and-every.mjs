import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 16. Every navigable page has help, and every help file names a page that exists.
//
// The page help, help/pages/ as frontend/src/help/index.js globs it, is resolved by filename at
// runtime and a missing file fails quietly. Both directions: a help file left behind by a renamed
// page is invisible. What the files may contain is check 108's; where their links go, 109's.
// -------------------------------------------------------------------------------------------------
function part1() {
  const HELP_DIR = 'help/pages';
  const nav = read('frontend/src/navigation.jsx');

  // The TABS array only. GROUPS above it carries `{ id: 'assets' }` entries that are not pages, and
  // a naive scan of the whole file would demand help files for all four of them.
  const tabsBlock = /export const TABS = \[([\s\S]*?)\n\]/.exec(nav);
  if (!tabsBlock) {
    fail('check-docs-drift: could not find the TABS array in frontend/src/navigation.jsx');
  } else if (!existsSync(join(REPO, HELP_DIR))) {
    fail(`${HELP_DIR} is missing, and frontend/src/help/index.js globs it for the help corpus.`);
  } else {
    const pages = [...tabsBlock[1].matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    const helpFiles = readdirSync(join(REPO, HELP_DIR))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));

    const unhelped = pages.filter((p) => !helpFiles.includes(p));
    const orphaned = helpFiles.filter((f) => !pages.includes(f));

    if (unhelped.length) {
      fail(
        `no help file in ${HELP_DIR} for page(s): ${unhelped.join(', ')}.\n` +
          '      The help drawer resolves by filename, so these pages open it to a notice saying\n' +
          '      nobody has written any -- which is the state the whole item exists to end.'
      );
    }
    if (orphaned.length) {
      fail(
        `${HELP_DIR} has help file(s) for no such page: ${orphaned.join(', ')}.md.\n` +
          '      A page id that was renamed leaves its help behind under the old name: the file is\n' +
          '      never resolved again and the renamed page silently has none.'
      );
    }

    if (!unhelped.length && !orphaned.length) {
      pass(`all ${pages.length} navigable page(s) have help in ${HELP_DIR}, and every file there names a page`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// The exporter and the page call the destination's fields the same thing
//
// `unconfigured()` in cold_archive.py names what is missing into a CronJob log; the Cold Storage
// page names the same gaps on screen. An operator reading a failed job and then opening the page is
// matching one list against the other, so the words have to be identical -- and they live in two
// languages, which is exactly the kind of pair that drifts silently and is only noticed by somebody
// already having a bad day.
function part2() {
  const py = read('ingestion/cold_archive.py');
  const js = read('frontend/src/utils/coldStorage.js');

  // The tuple pairs inside unconfigured(): ("endpoint", "S3 endpoint"), ...
  const block = py.slice(py.indexOf('def unconfigured('), py.indexOf('def _s3_client('));
  const fromPy = [...block.matchAll(/\("[a-z_]+",\s*"([^"]+)"\)/g)].map((m) => m[1]);

  const fromJs = [...js.matchAll(/\{\s*key:\s*'archive\.[a-z_]+',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => m[1]);

  // The page's list covers the four settings; the exporter's adds the credential, which is not a
  // setting and has no row of its own.
  const pyFields = fromPy.filter((l) => l.startsWith('S3 '));

  if (!pyFields.length || !fromJs.length) {
    fail(
      `the destination field labels could not be read from both sides (exporter: ${pyFields.length}, ` +
        `page: ${fromJs.length}). One of the lists has been renamed or restructured, and the other ` +
        'is now the only place the operator-facing wording is defined.'
    );
  } else if (pyFields.join('|') !== fromJs.join('|')) {
    fail(
      'the exporter and the Cold Storage page name the destination fields differently:\n' +
        `        cold_archive.py: ${pyFields.join(', ')}\n` +
        `        coldStorage.js:  ${fromJs.join(', ')}\n` +
        '      An operator matching a failed job against the page has to translate between them.'
    );
  } else {
    pass(`the exporter and the page name all ${pyFields.length} destination fields identically`);
  }
}

// -------------------------------------------------------------------------------------------------
// The Cold Storage page and the Archive Backlog alert agree about what "behind" means
//
// The page colours a backlog and the alert fires on one, from the same number in two files. A page
// calling a backlog fine while the alert was firing would be the more convincing of the two,
// because it is the one somebody looks at after being paged.
function part3() {
  const util = read('frontend/src/utils/coldStorage.js');
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');

  const page = util.match(/ARCHIVE_BACKLOG_TOLERANCE_DAYS\s*=\s*(\d+)/)?.[1];
  // The evaluator inside the aber-archive-backlog rule, which is the last `params: [n]` before the
  // next rule begins.
  const ruleBlock = rules.slice(rules.indexOf('uid: aber-archive-backlog'));
  const alert = ruleBlock.match(/type:\s*gt\s*\n\s*params:\s*\[(\d+)\]/)?.[1];

  if (!page || !alert) {
    fail(
      `the archive backlog tolerance could not be read from both sides (page: ${page || 'MISSING'}, ` +
        `alert: ${alert || 'MISSING'}). One of them has been renamed or removed, and the other is ` +
        'now the only definition of a threshold two surfaces are meant to share.'
    );
  } else if (page !== alert) {
    fail(
      `the Cold Storage page tolerates ${page} days of archive backlog and the Archive Backlog ` +
        `alert fires above ${alert}. Between those numbers one surface calls the archive healthy ` +
        'while the other pages somebody.'
    );
  } else {
    pass(`the archive backlog tolerance is ${page} days on the Cold Storage page and in its alert rule`);
  }
}

export default function check() {
  part1();
  part2();
  part3();
}
