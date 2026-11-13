import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 63. The forge's audit log is on, and it keeps events for as long as forge/README.md says.
//
// gitea.yaml asserts both settings rather than omitting them, because environment-to-ini merges
// into the app.ini already on the volume. The README is where an operator learns how far back the
// log reaches, so a default changed in values.yaml alone would mislead the one person who asks.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const chart = read('deploy/helm/aber/templates/apps/gitea.yaml');
  const giteaBlock = /^gitea:\n([\s\S]*?)^\S/m.exec(read('deploy/helm/aber/values.yaml'))?.[1] ?? '';
  const days = /^ {2}audit:\n(?: {4}#.*\n)* {4}retentionDays: (\d+)$/m.exec(giteaBlock)?.[1];
  const said = /`gitea\.audit\.retentionDays`, \*\*(\d+)\*\* by default/.exec(read('forge/README.md'))?.[1];
  const found = [];
  if (!/- name: GITEA__audit__RECORD_OUTPUT\n\s+value: database\n/.test(chart)) {
    found.push('templates/apps/gitea.yaml does not assert GITEA__audit__RECORD_OUTPUT=database');
  }
  if (!/\$auditDays := toString \.Values\.gitea\.audit\.retentionDays/.test(chart) ||
      !/- name: GITEA__audit__RETENTION_DAYS\n\s+value: \{\{ \$auditDays \| quote \}\}/.test(chart)) {
    found.push('templates/apps/gitea.yaml does not set GITEA__audit__RETENTION_DAYS from gitea.audit.retentionDays');
  }
  if (!days) found.push('values.yaml declares no gitea.audit.retentionDays');
  if (!said) found.push('forge/README.md no longer says "`gitea.audit.retentionDays`, **<days>** by default"');
  if (days && said && days !== said) {
    found.push(`values.yaml keeps forge audit events ${days} days and forge/README.md says ${said}`);
  }
  if (found.length) fail(`check 63: ${found.join('; ')}`);
  else pass(`the forge's audit log is asserted on, and forge/README.md gives its ${days}-day default`);
}
