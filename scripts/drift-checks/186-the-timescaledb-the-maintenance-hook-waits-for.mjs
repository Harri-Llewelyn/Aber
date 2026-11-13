import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 186. The TimescaleDB the maintenance hook waits for is the one timescaledb/Dockerfile is built
// FROM. The hook holds extension.sql back until the historian offers that version, so a chart that
// names an older one updates on the old pod again, and a newer one fails every upgrade at its bound.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HOOK = 'deploy/helm/aber/templates/jobs/timescaledb-maintenance.yaml';
  const from = read('timescaledb/Dockerfile').match(/^FROM\s+timescale\/timescaledb:(\d+\.\d+\.\d+)-pg\d+\s*$/m);
  const hook = read(HOOK);
  const constant = [...hook.matchAll(/^\{\{-\s*\$timescaledbVersion\s*:=\s*"([^"]*)"\s*-?\}\}\s*$/gm)];
  const offences = [];
  if (!from) offences.push('timescaledb/Dockerfile names no timescale/timescaledb:<x.y.z>-pg<n> base');
  if (constant.length !== 1) offences.push(`${HOOK} sets $timescaledbVersion ${constant.length} times, not once`);
  else if (from && constant[0][1] !== from[1]) offences.push(`${HOOK} waits for TimescaleDB ${constant[0][1]}, and timescaledb/Dockerfile is built FROM ${from[1]}`);
  if (!/expected=\{\{ \$timescaledbVersion \| quote \}\}/.test(hook)) offences.push(`${HOOK}'s wait no longer reads $timescaledbVersion`);
  else if (hook.indexOf('expected={{ $timescaledbVersion') > hook.indexOf('-f /sql/extension.sql')) offences.push(`${HOOK} waits for the version after it runs extension.sql`);

  if (offences.length) {
    fail(`The maintenance hook waits for the TimescaleDB the historian image is built FROM:\n  ${offences.join('\n  ')}`);
  } else {
    pass(`The maintenance hook waits for TimescaleDB ${from[1]}, the version timescaledb/Dockerfile is built FROM, before extension.sql`);
  }
}
