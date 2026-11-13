import { compare, lastDefinition, need, problems, read, SCHEMA } from './lib.mjs';

// 1b. A gateway's Sparkplug group. The Edit Gateway dialog refuses a value before saving it with
// sparkplugGroupProblem(); the table's CHECK and ingest_record_gateway_group() refuse it in the
// database. A character only one side refuses is a dialog that blocks a legal group, or one that
// lets the save fail with a constraint error.
export default function check() {
  const js = read('frontend/src/utils/sparkplugId.js');
  const jsChars = need(js, /SPARKPLUG_GROUP_FORBIDDEN\s*=\s*'([^']+)'/, 'SPARKPLUG_GROUP_FORBIDDEN in sparkplugId.js');
  const jsEmpty = /group === ''/.test(js);
  const check = need(
    SCHEMA,
    /CONSTRAINT gateways_sparkplug_group_format CHECK \(\(\(sparkplug_group <> ''::text\) AND \(sparkplug_group !~ '\[([^\]]+)\]'::text\)\)\)/,
    'gateways_sparkplug_group_format in the applied chain'
  );
  const gate = lastDefinition(
    'CREATE OR REPLACE FUNCTION public.ingest_record_gateway_group(',
    '$$;',
    'public.ingest_record_gateway_group()'
  );
  const gateChars = gate ? need(gate.body, /p_group ~ '\[([^\]]+)\]'/, 'the character class in ingest_record_gateway_group()') : null;
  const sorted = (chars) => [...chars].sort().join('');
  if (jsChars && check) {
    compare('sparkplugGroup', 'characters the dialog and the CHECK refuse', sorted(jsChars[1]), sorted(check[1]));
    if (!jsEmpty) problems.push('sparkplugGroup: sparkplugGroupProblem() no longer refuses the empty group the CHECK refuses');
  }
  if (jsChars && gateChars) {
    compare('sparkplugGroup', `characters the dialog and ${gate.file}'s gate refuse`, sorted(jsChars[1]), sorted(gateChars[1]));
  }
}
