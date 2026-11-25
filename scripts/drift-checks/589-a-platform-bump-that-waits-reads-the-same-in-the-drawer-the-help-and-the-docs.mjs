import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 589. A platform bump that waits reads the same in the drawer, the help and the docs, and its record on
// the gateway's row has one writer. forge_bump_tag and forge_bump_number (0327) are a copy of what the
// forge holds: forge-sweep and forge-events write them through bumpRecord.ts, and the drawer's Platform
// row reads them through WaitingBump. The migration keeps both out of the audit trail, the sweep keeps
// them out of a row it proposes nothing for, and the API reference lists them.
// -------------------------------------------------------------------------------------------------
const COLUMNS = ['forge_bump_tag', 'forge_bump_number'];
const RECORD = 'supabase/functions/_shared/bumpRecord.ts';
const SWEEP = 'supabase/functions/forge-sweep/index.ts';
const EVENTS = 'supabase/functions/forge-events/index.ts';
const PANEL = 'frontend/src/components/common/GatewayRepositoryPanel.jsx';
const TAB = 'frontend/src/components/tabs/GatewaysTab.jsx';
const MIGRATION = 'supabase/migrations/0327_a_gateway_records_the_platform_bump_that_waits.sql';

export default function check() {
  const problems589 = [];
  const text = (path) => read(path).replace(/\r\n/g, '\n');

  const words = /const words = `\$\{gateway\.forge_bump_tag\} ([a-z ]+)`/.exec(text(PANEL))?.[1];
  if (!words) problems589.push(`${PANEL} no longer says what the row says, so this check reads nothing`);
  for (const document of ['help/pages/gateways.md', 'help/site/remote-gateways.md', 'docs/remote-gateways.md', TAB]) {
    const said = text(document).replace(/\s+/g, ' ');
    if (words && !said.includes(`v1.10.0 ${words}`) && !said.includes(`"${words}"`)) problems589.push(`${document} does not say "${words}", as the drawer does`);
  }

  // Who writes: an update of the columns stands in bumpRecord.ts alone.
  const functions = allFiles.filter((f) => f.startsWith('supabase/functions/') && f.endsWith('.ts') && !f.endsWith('_test.ts'));
  for (const file of functions.filter((f) => f !== RECORD)) {
    const source = text(file);
    // A type names a column too; a value of one is a write.
    if (/forge_bump_(?:tag|number):(?! (?:string|number)\b)/.test(source)) problems589.push(`${file} writes the record itself: ${RECORD} does`);
  }
  const sweep = text(SWEEP);
  for (const call of ['recordBump(admin, gateway, bump.waiting)', 'if (gateway) await recordBump(admin, gateway, null)', 'else await recordBump(admin, gateway, null)']) {
    if (!sweep.includes(call)) problems589.push(`${SWEEP} does not call ${call}`);
  }
  if (!text(EVENTS).includes('clearMergedBump(cfg, admin, repository, sparkplugId, sha)')) problems589.push(`${EVENTS} does not clear the record when the merge arrives`);

  // Who reads: the one component, and the tab that asks whether there is anything to say.
  for (const file of allFiles.filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && f !== PANEL && f !== TAB)) {
    if (COLUMNS.some((column) => text(file).includes(column))) problems589.push(`${file} reads the record itself: WaitingBump (${PANEL}) does`);
  }

  const migration = text(MIGRATION);
  const audited = migration.slice(migration.indexOf('FUNCTION public.audit_telemetry_columns()'), migration.indexOf(']::text[]'));
  const reference = text('docs/openapi.yaml');
  for (const column of COLUMNS) {
    if (!audited.includes(`'${column}'`)) problems589.push(`${MIGRATION}: audit_telemetry_columns() does not name ${column}, so each pass would be an audit event`);
    if (!reference.includes(`        ${column}:\n`)) problems589.push(`docs/openapi.yaml does not list ${column}`);
  }

  if (problems589.length) {
    fail('a platform bump that waits reads otherwise in one place than another:\n' + problems589.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a platform bump that "${words}" reads so in the drawer, the help and the docs, bumpRecord.ts alone writes its record, and neither column is audited`);
  }
}
