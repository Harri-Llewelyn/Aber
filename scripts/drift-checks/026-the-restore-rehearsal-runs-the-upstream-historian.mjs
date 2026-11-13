import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 26. The restore rehearsal runs the upstream historian image rather than building the chart's
// (.github/rehearsal-values.yaml), so it has to be the one timescaledb/Dockerfile is built FROM.
// Renovate bumps the Dockerfile; this is what notices the rehearsal left behind.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const from = read('timescaledb/Dockerfile').match(/^FROM\s+(\S+):(\S+)/m);
  const rehearsal = read('.github/rehearsal-values.yaml')
    .match(/^timescaledb:\s*\n\s+image:\s*\n\s+repository:\s*(\S+)\s*\n\s+tag:\s*(\S+)/m);
  if (!from || !rehearsal) {
    fail('could not read the historian base from timescaledb/Dockerfile and .github/rehearsal-values.yaml');
  } else if (from[1] !== rehearsal[1] || from[2] !== rehearsal[2]) {
    fail(
      `the restore rehearsal runs ${rehearsal[1]}:${rehearsal[2]}, but the historian image is built ` +
        `FROM ${from[1]}:${from[2]} (timescaledb/Dockerfile)`
    );
  } else {
    pass(`the restore rehearsal runs the historian base the chart's image is built FROM (${from[2]})`);
  }
}
