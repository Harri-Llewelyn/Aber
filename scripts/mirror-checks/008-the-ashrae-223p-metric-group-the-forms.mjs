import { compare, EXAMPLES, need, problems, read, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 8. The ASHRAE 223P metric group. The form's prefill (utils/ashrae223.js) and the seed must name the
// same one, it must be the only group registered under the standard, and the example metrics must
// file under it: they forked once (#456), the form filing under `Building` while the seeded metrics
// sat under an unregistered `BMS`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const js = need(read('frontend/src/utils/ashrae223.js'), /export const ASHRAE223_GROUP = '([^']+)'/,
    'ASHRAE223_GROUP in utils/ashrae223.js');
  const registered = [...SCHEMA.matchAll(
    /INSERT INTO public\.metric_groups \(id, name, description, standard\)\s*VALUES \('[^']*', '([^']+)',\s*'(?:[^']|'')*',\s*'ASHRAE 223P'\)/g
  )].map((m) => m[1]);
  // The example metrics' INSERT ... SELECT over a VALUES list, which names the standard once.
  const seededGroups = new Set(
    [...EXAMPLES.matchAll(/INSERT INTO public\.metric_catalog \([^)]*\)\s*SELECT[^;]*?'ASHRAE 223P'[^;]*?FROM \(VALUES([\s\S]*?)\) AS /g)]
      .flatMap((m) => [...m[1].matchAll(/\(\s*'([^'/]+)\/[^']*',/g)].map((v) => v[1]))
  );
  if (js && seededGroups.size === 0) {
    problems.push('ashrae223Group: found no example ASHRAE 223P metric -- the file\'s shape changed, so half of this check is no longer checking anything');
  }
  if (js && registered.length !== 1) {
    problems.push(`ashrae223Group: expected one metric group registered under ASHRAE 223P, found ${JSON.stringify(registered)}`);
  } else if (js) {
    compare('ashrae223Group', 'the group 223P metrics file under', js[1], registered[0]);
    const strays = [...seededGroups].filter((g) => g !== registered[0]);
    if (strays.length) {
      problems.push(`ashrae223Group: example 223P metrics file under ${JSON.stringify(strays)}, not the registered '${registered[0]}'`);
    }
  }
}
