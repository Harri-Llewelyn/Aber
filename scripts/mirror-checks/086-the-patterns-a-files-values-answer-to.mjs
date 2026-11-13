import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 86. The patterns a file's values answer to, in the page and in the database (0255, 0256): an
// automation's id, a hold, and the severities. The page uses them to say what a person typed is not an
// id before asking; a pattern the table's CHECK does not share would let a refusal through, or turn
// away an id the database keeps. Mirror check 71 holds the schema to the same SQL.
export default function check() {
  const js = read('frontend/src/utils/automations.js');
  const key = need(js, /export const AUTOMATION_KEY_PATTERN = \/(.+)\/$/m, 'AUTOMATION_KEY_PATTERN in utils/automations.js');
  const hold = need(js, /export const AUTOMATION_HOLD_PATTERN = \/(.+)\/$/m, 'AUTOMATION_HOLD_PATTERN in utils/automations.js');
  const severities = need(js, /export const AUTOMATION_SEVERITIES = \[([^\]]*)\]/, 'AUTOMATION_SEVERITIES in utils/automations.js');
  const sqlKey = need(SCHEMA, /CONSTRAINT automations_key_format CHECK \(\(key ~ '([^']+)'::text\)\)/, 'automations_key_format in the migrations');
  const parse = lastDefinition('CREATE OR REPLACE FUNCTION public.automations_parse(', '$$;', 'automations_parse()');
  const sqlHold = parse && need(parse.body.split('\n').find((line) => line.trim().startsWith('c_for ')) ?? '',
    /CONSTANT text := '([^']+)';/, `c_for in automations_parse() (${parse.file})`);
  const sqlSeverities = need(SCHEMA, /CONSTRAINT automation_actions_alert_shape\s+CHECK \(\(\(kind <> 'alert'::text\) OR \(severity = ANY \(ARRAY\[([^\]]*)\]\)\)\)\)/,
    'automation_actions_alert_shape in the migrations');
  const words = (list) => [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).join(', ');
  if (key && sqlKey) compare('automationsPatterns', "an automation's id pattern in the page and in the table CHECK", key[1], sqlKey[1]);
  if (hold && sqlHold) compare('automationsPatterns', `the hold pattern in the page and in automations_parse() (${parse.file})`, hold[1], sqlHold[1]);
  if (severities && sqlSeverities) compare('automationsPatterns', 'the severities in the page and in the actions table', words(severities[1]), words(sqlSeverities[1]));
}
