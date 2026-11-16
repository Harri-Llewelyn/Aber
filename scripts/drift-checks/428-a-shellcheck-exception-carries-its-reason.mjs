import { join } from 'node:path';
import { firstLine, shellFiles } from '../lint-sh.mjs';
import { REPO, allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 428. A ShellCheck exception carries its reason. ShellCheck takes `# shellcheck disable=SC2016`
// with nothing after it, so nothing but this check asks why. In a shell script the reason follows
// as `# <words>` on the same line (ShellCheck reads `-- reason` as a syntax error), and in a
// .shellcheckrc a comment line stands above the `disable=` line. docs/static-analysis.md says so
// under Accepting a finding.
// -------------------------------------------------------------------------------------------------
const DIRECTIVE = /^\s*#\s*shellcheck\s+disable=/;
const WITH_REASON = /^\s*#\s*shellcheck\s+disable=SC\d+(?:,SC\d+)*\s+#\s+\S+(?:\s+\S+){2,}\s*$/;

export default function check() {
  const problems428 = [];
  // A file that cannot be opened (a broken link) is no script.
  const scripts = shellFiles(allFiles, (f) => { try { return firstLine(join(REPO, f)); } catch { return ''; } });
  let directives = 0;
  for (const file of scripts) {
    read(file).split('\n').forEach((line, i) => {
      if (!DIRECTIVE.test(line)) return;
      directives += 1;
      if (!WITH_REASON.test(line)) problems428.push(`${file}:${i + 1} disables a check without a \`# reason\` of at least three words after it`);
    });
  }
  const configs = allFiles.filter((f) => f.split('/').pop() === '.shellcheckrc');
  for (const file of configs) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (!/^\s*disable=/.test(line)) return;
      directives += 1;
      if (!/^\s*#\s*\S+/.test(lines[i - 1] ?? '')) problems428.push(`${file}:${i + 1} disables a check without a comment line above it that says why`);
    });
  }
  if (problems428.length) {
    for (const p of problems428) fail(`a ShellCheck exception must say why: ${p}`);
  } else {
    pass(`${directives} ShellCheck exception(s) in ${scripts.length} shell script(s) and ${configs.length} .shellcheckrc file(s), each with its reason`);
  }
}
