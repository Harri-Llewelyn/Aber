import { CHART_VALUES, fail, pass, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 289. History's help and the 0254 section say how long raw telemetry is kept by default as the
// chart holds it (timescaledb.retention.retainFor). Past it a text or flag chart can no longer show
// every change, so a page naming another figure tells a reader the wrong window.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const kept = CHART_VALUES.match(/^ {4}retainFor: "([^"]+)"$/m)?.[1];
  const problems289 = [];
  if (!kept) problems289.push('could not read timescaledb.retention.retainFor out of deploy/helm/aber/values.yaml');
  else {
    const claims = [
      ['help/pages/history.md', `The historian keeps raw readings for ${kept} by default`],
      ['supabase/README.md', `(${kept} by default, \`timescaledb.retention.retainFor\`)`],
    ];
    // Read as one line, so a rewrapped paragraph still says it.
    for (const [file, said] of claims) if (!readDoc(file).replace(/\s+/g, ' ').includes(said)) problems289.push(`${file} does not say "${said}"`);
  }
  if (problems289.length) {
    fail('History\'s docs say how long raw telemetry is kept otherwise than the chart does:\n' +
      problems289.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help and the 0254 section keep raw telemetry ${kept} by default, as values.yaml's retainFor does`);
  }
}
