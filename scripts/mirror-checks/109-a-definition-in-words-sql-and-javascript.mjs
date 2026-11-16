import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compare, lastDefinition, need, problems, ROOT } from './lib.mjs';

// 109. A derived metric's definition in words, SQL and JavaScript (0296). The Derived tab, a tooltip
// and a search say it with derivationText(); export_telemetry() names it in the export's comment row
// and in the Audit Trail row with derivation_words(). The words are the same, so a person who reads
// "rate of Controller/PART_COUNT, per hour" in the file has seen it in the table. Each template and
// separator of the SQL function is read from its constants, and the sentence they make for each kind
// is compared with the dashboard's, for one, two and three states and for a sum that opens with a
// minus.
export default async function check() {
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.derivation_words(', '$fn$;', 'derivation_words()');
  const { derivationText } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/derivedMetric.js')).href);
  if (!fn) return;
  const constants = new Map([...fn.body.matchAll(/(c_\w+)\s+CONSTANT text := '([^']*)';/g)].map((m) => [m[1], m[2]]));
  const constant = (name) => {
    if (!constants.has(name)) problems.push(`could not find ${name} in derivation_words() (${fn.file}) -- the file's shape changed, so this check is no longer checking anything`);
    return constants.get(name);
  };
  const rate = constant('c_rate');
  const share = constant('c_share');
  const or = constant('c_or');
  const comma = constant('c_comma');
  const plus = constant('c_plus');
  const minus = constant('c_minus');
  const neg = constant('c_neg');
  const unknown = need(fn.body, /RETURN '(unknown kind )' \|\|/, `the words for an unknown kind in derivation_words() (${fn.file})`)?.[1];
  if ([rate, share, or, comma, plus, minus, neg, unknown].some((v) => v === undefined || v === null)) return;
  const fill = (template, ...values) => values.reduce((text, value) => text.replace('%s', value), template);
  const states = (list) => (list.length <= 1 ? list.join('') : list.slice(0, -1).join(comma) + or + list[list.length - 1]);
  const sum = (inputs) => inputs.map(([name, sign], i) => (i === 0 ? (sign < 0 ? neg : '') : sign < 0 ? minus : plus) + name).join('');
  const cases = [
    ['a counter rate', { kind: 'counter_rate', input: 'Controller/PART_COUNT' }, fill(rate, 'Controller/PART_COUNT')],
    ['a time in one state', { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] }, fill(share, 'Controller/EXECUTION', states(['ACTIVE']))],
    ['a time in two states', { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE', 'READY'] }, fill(share, 'Controller/EXECUTION', states(['ACTIVE', 'READY']))],
    ['a time in three states', { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE', 'READY', 'WAIT'] }, fill(share, 'Controller/EXECUTION', states(['ACTIVE', 'READY', 'WAIT']))],
    ['a sum', { kind: 'sum', inputs: [{ metric: 'Power/A', sign: 1 }, { metric: 'Power/B', sign: 1 }, { metric: 'Power/C', sign: -1 }] }, sum([['Power/A', 1], ['Power/B', 1], ['Power/C', -1]])],
    ['a sum that opens with a minus', { kind: 'sum', inputs: [{ metric: 'Power/A', sign: -1 }, { metric: 'Power/B', sign: 1 }] }, sum([['Power/A', -1], ['Power/B', 1]])],
    ['a definition of another kind', { kind: 'average' }, `${unknown}average`],
  ];
  for (const [what, definition, sqlWords] of cases) {
    compare('derivationWords', `the words for ${what} in the dashboard and in derivation_words() (${fn.file})`, derivationText(definition), sqlWords);
  }
  if (derivationText(null) !== '') {
    problems.push('derivationWords: derivationText(null) is not empty, as derivation_words(NULL) is');
  }
}
