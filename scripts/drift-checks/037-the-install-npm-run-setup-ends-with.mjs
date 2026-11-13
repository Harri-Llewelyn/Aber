import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 37. The install `npm run setup` ends with is help/site/install.md step 7's.
//
// Someone who follows the screen rather than the page runs the printed line, so the two are one
// instruction. setup.mjs prints installCommand() from scripts/lib/release-chart.mjs at Chart.yaml's
// `version:`; the page writes the version out, so a release that bumps Chart.yaml fails here until
// the page follows. Compared with `\` continuations joined and whitespace collapsed.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { installCommand, normaliseCommand, readChartVersion } = await import('../lib/release-chart.mjs');
  const DOC = 'help/site/install.md';
  const STEP = /^###\s+7\.\s+Install Aber\s*$/m;
  const doc = read(DOC);
  const setup = read('scripts/setup.mjs');
  const version = readChartVersion(REPO);
  const printed = normaliseCommand(installCommand({ version, valuesFile: 'deploy/helm/aber/values-local.yaml' }).join('\n'));

  const step = STEP.exec(doc);
  const fence = step && /```bash\n([\s\S]*?)```/.exec(doc.slice(step.index));
  const install = fence && /^helm install\b(?:.*\\\n)*.*$/m.exec(fence[1]);
  const header = /^ \* {3}(helm install\b(?:.*\\\n \*)*.*)$/m.exec(setup);
  if (!install) {
    fail(`check 37 cannot find a \`helm install\` in the first bash block under "### 7. Install Aber" in ${DOC}`);
  } else if (!/\binstallCommand\(/.test(setup) || !header) {
    fail('scripts/setup.mjs no longer prints installCommand() or shows it in its header comment, so check 37 compares nothing');
  } else {
    const documented = normaliseCommand(install[0]);
    const commented = normaliseCommand(header[1].replace(/\\\n \*/g, '\\\n'));
    const docVersion = /--version\s+(\S+)/.exec(documented)?.[1];
    if (documented !== printed) {
      fail(
        docVersion && docVersion !== version
          ? `${DOC} step 7 installs --version ${docVersion}, and Chart.yaml's version is ${version}. ` +
            `Change ${DOC}: Chart.yaml is the release this checkout descends from, and npm run setup prints its version.`
          : `npm run setup prints a different install from ${DOC} step 7:\n` +
            `        setup prints  ${printed}\n        ${DOC}   ${documented}\n` +
            `        Change ${DOC} if the install itself changed; change installCommand() in ` +
            'scripts/lib/release-chart.mjs if what setup prints is behind the page.'
      );
    } else if (commented !== printed.replace(`--version ${version}`, '--version <version>')) {
      fail(
        `scripts/setup.mjs's header comment gives a different install from the one it prints:\n` +
          `        comment  ${commented}\n        prints   ${printed}\n` +
          '        Change the comment (the version is written <version> there).'
      );
    } else {
      pass(`npm run setup ends with ${DOC} step 7's install, at the chart's version ${version}`);
    }
  }
}
