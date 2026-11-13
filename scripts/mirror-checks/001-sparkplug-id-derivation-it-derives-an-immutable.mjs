import { compare, need, ok, problems, read, SCHEMA } from './lib.mjs';

// 1. Sparkplug id derivation. It derives an immutable wire identity: `sparkplug_id` is `GENERATED
// ALWAYS ... STORED`, so a divergence cannot be corrected without re-provisioning every device.
export default function check() {
  const js = read('frontend/src/utils/sparkplugId.js');
  const jsDevice = need(js, /DEVICE_ID_PREFIX\s*=\s*'([^']+)'/, 'DEVICE_ID_PREFIX in sparkplugId.js');
  const jsGateway = need(js, /GATEWAY_ID_PREFIX\s*=\s*'([^']+)'/, 'GATEWAY_ID_PREFIX in sparkplugId.js');
  const jsHex = need(js, /HEX_CHARS\s*=\s*(\d+)/, 'HEX_CHARS in sparkplugId.js');
  const jsLength = need(js, /SPARKPLUG_ID_LENGTH\s*=\s*(\d+)/, 'SPARKPLUG_ID_LENGTH in sparkplugId.js');
  const jsRegex = need(js, /SPARKPLUG_ID_REGEX\s*=\s*\/\^\(([a-z|]+)\)\[0-9a-f\]\{(\d+)\}\$\//, 'SPARKPLUG_ID_REGEX in sparkplugId.js');

  // e.g. ('dev'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21)). 0001 declares each
  // column twice, in its CREATE TABLE IF NOT EXISTS and in the ADD COLUMN IF NOT EXISTS that
  // converges an older table, so declarations are grouped by the table statement they sit in:
  // exactly devices and gateways, and every declaration of one table must agree.
  const declarations = [...SCHEMA.matchAll(
    /sparkplug_id text GENERATED ALWAYS AS \(\('([a-z]+)'::text \|\| substr\(encode\(uuid_send\(id\), 'hex'::text\), 1, (\d+)\)\)\) STORED/g
  )].map((m) => {
    const tables = [...SCHEMA.slice(0, m.index).matchAll(/^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?(?: IF EXISTS)?) public\.(\w+)/gm)];
    return { table: tables.length ? tables[tables.length - 1][1] : '(unknown)', prefix: m[1], width: m[2] };
  });
  const byTable = new Map();
  for (const d of declarations) {
    const key = `${d.prefix}/${d.width}`;
    byTable.set(d.table, (byTable.get(d.table) ?? new Set()).add(key));
  }
  const tableNames = [...byTable.keys()].sort().join(',');
  const conflicting = [...byTable].filter(([, forms]) => forms.size > 1);
  if (tableNames !== 'devices,gateways') {
    problems.push(`sparkplugId: expected generated sparkplug_id columns on devices and gateways, found them on "${tableNames}"`);
  } else if (conflicting.length > 0) {
    for (const [table, forms] of conflicting) {
      problems.push(`sparkplugId: ${table}.sparkplug_id is declared ${forms.size} different ways across the chain: ${[...forms].join(' vs ')}`);
    }
  } else if (jsDevice && jsGateway && jsHex && jsLength && jsRegex) {
    const generated = [...byTable.values()].map((forms) => [...forms][0].split('/'));
    ok.push(`sparkplugId: ${declarations.length} declarations resolve to one column each on devices and gateways`);
    const sqlPrefixes = generated.map(([prefix]) => prefix).sort();
    const sqlWidths = [...new Set(generated.map(([, width]) => width))];
    compare('sparkplugId', 'type prefixes', [jsDevice[1], jsGateway[1]].sort().join(','), sqlPrefixes.join(','));
    if (sqlWidths.length !== 1) {
      problems.push(`sparkplugId: the two generated columns disagree on hex width: ${sqlWidths.join(' vs ')}`);
    } else {
      compare('sparkplugId', 'hex character count', jsHex[1], sqlWidths[0]);
      // Internal consistency: 3-character prefix + hex width must be the declared total, and the
      // regex must agree with both. A wrong total silently breaks length-based validation.
      compare('sparkplugId', 'total id length', jsLength[1], String(jsDevice[1].length + Number(sqlWidths[0])));
      compare('sparkplugId', 'regex hex width', jsRegex[2], sqlWidths[0]);
      compare('sparkplugId', 'regex prefixes', jsRegex[1].split('|').sort().join(','), sqlPrefixes.join(','));
    }
  }
}
