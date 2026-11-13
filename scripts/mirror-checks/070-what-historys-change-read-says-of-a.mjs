import { compare, lastDefinition, need, read } from './lib.mjs';

// 70. What History's change read says of a series, one closed set in three places: the values
// telemetry_changes() (0254) gives `read`, CHANGE_READS in utils/history.js, which the page draws
// each by, and the API reference's TelemetryChangesRow enum. A value only the function gives is a
// chart the page draws from the wrong read.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.telemetry_changes(', '$fn$;', 'telemetry_changes()');
  const js = need(read('frontend/src/utils/history.js'), /export const CHANGE_READS = Object\.freeze\(\{([\s\S]*?)\}\)/,
    'CHANGE_READS in frontend/src/utils/history.js');
  const spec = need(read('docs/openapi.yaml'), /\n {4}TelemetryChangesRow:\n[\s\S]*?\n {8}read: \{ type: string, enum: \[([^\]]*)\]/,
    "TelemetryChangesRow's read enum in docs/openapi.yaml");
  if (def && js && spec) {
    const sorted = (values) => [...new Set(values)].sort().join(', ');
    const sql = sorted([...def.body.matchAll(/\bread := '([a-z_]+)';/g)].map((m) => m[1]));
    compare('changeReads', 'the reads the page draws by', sorted([...js[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])), sql);
    compare('changeReads', 'the reads the API reference names', sorted(spec[1].split(',').map((v) => v.trim())), sql);
  }
}
