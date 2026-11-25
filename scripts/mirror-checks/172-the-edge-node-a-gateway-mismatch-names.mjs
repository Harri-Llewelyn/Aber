import { compare, need, problems, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 172. The edge node a GATEWAY_MISMATCH names. verify_gateway_binding() writes it into the hold's reason,
// in one sentence for each of its refusals, and the dashboard reads it back (cameThrough()) to say which
// gateway a held device came through: the quoted id after one of the expression's words. In each sentence
// one of them stands before the last %s, which is the publishing node's. A sentence reworded past it, or a
// new one without it, fails here.
// -------------------------------------------------------------------------------------------------

export default function check() {
  const daemon = read('ingestion/ingestion.py').replace(/\r\n/g, '\n');
  const dashboard = read('frontend/src/utils/quarantineHold.js').replace(/\r\n/g, '\n');
  const body = need(daemon, /\ndef verify_gateway_binding\([\s\S]*?\n(?=\S)/, 'verify_gateway_binding() in ingestion/ingestion.py');
  const code = need(daemon, /^REASON_GATEWAY_MISMATCH = "([A-Z_]+)"$/m, 'REASON_GATEWAY_MISMATCH in ingestion/ingestion.py');
  const expression = need(dashboard, /^const CAME_THROUGH = \/\^([A-Z_]+): \.\*\(\?:([^)]+)\) '\(\[\^'\]\+\)'\/$/m, 'CAME_THROUGH in frontend/src/utils/quarantineHold.js');
  if (!body || !code || !expression) return;
  compare('cameThrough', 'the code the reason starts with', expression[1], code[1]);

  const returned = body[0].split('\n').filter((line) => line.trim().startsWith('return ') && line.trim() !== 'return None');
  const sentences = returned.map((line) => /return "(%s: [^"]+)" % \($/.exec(line.trim())?.[1]);
  if (!sentences.length || sentences.some((s) => !s)) {
    problems.push(`check 172 read ${sentences.filter(Boolean).length} of the ${returned.length} sentences verify_gateway_binding() returns`);
    return;
  }
  for (const sentence of sentences) {
    const last = sentence.lastIndexOf("'%s'");
    const words = expression[2].split('|').filter((w) => last > 0 && sentence.slice(0, last).endsWith(`${w} `));
    const earlier = expression[2].split('|').filter((w) => sentence.indexOf(`${w} '%s'`) >= 0 && sentence.indexOf(`${w} '%s'`) + w.length + 1 !== last);
    compare('cameThrough', `the id read from "${sentence.slice(0, 60)}…"`, words.length === 1 && earlier.length === 0 ? 'its publishing node' : 'nothing', 'its publishing node');
  }
}
