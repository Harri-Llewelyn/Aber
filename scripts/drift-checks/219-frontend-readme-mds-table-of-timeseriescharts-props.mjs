import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 219. frontend/README.md's table of TimeSeriesChart's props is the props the component takes, every
// one and no other. The chart is the one every History tab reuses, so the table is its contract.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const COMPONENT = 'frontend/src/components/common/TimeSeriesChart.jsx';
  const props = (read(COMPONENT).match(/export function TimeSeriesChart\(\{([^}]*)\}\)/)?.[1] ?? '')
    .split(',').map((p) => p.trim().split(/\s*=/)[0]).filter(Boolean).sort();
  const readme = read('frontend/README.md');
  const from = readme.indexOf('**`common/TimeSeriesChart.jsx` is the one time-series chart**');
  const table = from < 0 ? '' : readme.slice(from, readme.indexOf('\n\n', readme.indexOf('| Prop |', from)));
  const named = [...table.matchAll(/^\| ((?:`\w+`(?:, )?)+) \|/gm)]
    .flatMap((m) => [...m[1].matchAll(/`(\w+)`/g)].map((n) => n[1])).sort();
  const problems219 = [];
  if (!props.length) problems219.push(`could not read TimeSeriesChart's props out of ${COMPONENT}`);
  if (!named.length) problems219.push('frontend/README.md has no table of TimeSeriesChart\'s props under "History and its chart"');
  for (const p of props.filter((p) => !named.includes(p))) problems219.push(`the README's table leaves out ${p}`);
  for (const p of named.filter((p) => !props.includes(p))) problems219.push(`the README's table names ${p}, which TimeSeriesChart does not take`);
  if (problems219.length) {
    fail('frontend/README.md describes TimeSeriesChart otherwise than the code has it:\n' +
      problems219.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`frontend/README.md's table names TimeSeriesChart's ${props.length} props, every one`);
  }
}
