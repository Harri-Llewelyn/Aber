import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 462. The Built-in tab's list names the rules of the alert rules file, in the order the file has
// them. The list is frontend/src/utils/builtInAlerts.generated.json, written by
// scripts/generate-built-in-alerts.mjs and committed, so a rule added to the file without running the
// script is not on the tab. CI runs the script with --check, which compares every field; this compares
// the uids, the titles and the groups with no parser, so `npm run lint` catches it before a push.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const RULES = 'grafana/provisioning/alerting/alert-rules.yaml';
  const LIST = 'frontend/src/utils/builtInAlerts.generated.json';
  const unquoted = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const source = read(RULES);
  const file = [...source.matchAll(/^ {6}- uid: (\S+)\n {8}title: (.+)$/gm)].map((m) => `${m[1]} ${unquoted(m[2])}`);
  const groups = [...source.matchAll(/^ {4}name: (.+)$/gm)].map((m) => unquoted(m[1]));
  const list = JSON.parse(read(LIST));
  const bundled = list.rules.map((r) => `${r.uid} ${r.title}`);
  const problems462 = [];
  if (file.length === 0) problems462.push(`could not read a rule from ${RULES}: its shape changed, so this check checks nothing`);
  for (const line of file.filter((l) => !bundled.includes(l))) problems462.push(`${LIST} lacks ${line}`);
  for (const line of bundled.filter((l) => !file.includes(l))) problems462.push(`${LIST} lists ${line}, which ${RULES} does not hold`);
  if (!problems462.length && file.join('\n') !== bundled.join('\n')) problems462.push(`${LIST} lists the rules in another order than ${RULES} does`);
  if (groups.join('|') !== list.groups.map((g) => g.name).join('|')) problems462.push(`${LIST} names the groups ${list.groups.map((g) => g.name).join(', ')}, and ${RULES} has ${groups.join(', ')}`);
  if (problems462.length) {
    fail(`the Built-in tab's list is stale: run node scripts/generate-built-in-alerts.mjs and commit it.\n${problems462.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Built-in tab lists the ${file.length} rule(s) of ${RULES}, in ${groups.length} group(s), in the order the file has them`);
  }
}
