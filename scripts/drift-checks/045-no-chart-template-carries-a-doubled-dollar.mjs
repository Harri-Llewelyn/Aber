import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 45. No chart template carries a doubled dollar. The kubelet reduces `$$` to `$` in a container's
// command and args before the shell reads them, so `eval "value=\$$name"` evaluated `$name`: the
// gateway's init script tested each variable's NAME, its four-key guard never fired, and a
// numeric check refused every value. The mounted scripts under files/ are not commands, so `$$`
// (the shell's pid) means what it says there and is not looked at.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TEMPLATES = 'deploy/helm/aber/templates/';
  const files = allFiles.filter((f) => f.startsWith(TEMPLATES) && /\.(ya?ml|tpl|txt)$/.test(f));
  const found = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      // A comment that names the rule (db-roles-init.yaml's `$do$` note) runs nothing.
      if (line.includes('$$') && !line.trim().startsWith('#')) found.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  if (!files.length) {
    fail(`check 45 found no chart templates under ${TEMPLATES}, so it reads nothing`);
  } else if (found.length) {
    fail(
      'a chart template carries a doubled dollar, which the kubelet turns into one in a container command ' +
        '(pass the value instead, as the gateway init script\'s require_set does):\n' +
        found.map((x) => `        ${x}`).join('\n')
    );
  } else {
    pass(`none of the chart's ${files.length} templates carries a doubled dollar the kubelet would rewrite`);
  }
}
