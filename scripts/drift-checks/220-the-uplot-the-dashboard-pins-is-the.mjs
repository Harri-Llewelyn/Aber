import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 220. The uPlot the dashboard pins is the one whose notice it carries. The build drops uPlot's own
// header, so TimeSeriesChart.jsx's legal comment carries its MIT notice and names its version, and
// NOTICE.md names the same. A version bump that leaves either behind says the bundle carries a
// release it does not.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const pinned = JSON.parse(read('frontend/package.json')).dependencies?.uplot;
  const notice = read('frontend/src/components/common/TimeSeriesChart.jsx').match(/^\/\*![\s\S]*?\*\//)?.[0] ?? '';
  const named = notice.match(/uPlot (\d+\.\d+\.\d+)/)?.[1];
  const listed = read('NOTICE.md').match(/\[uPlot\]\([^)]*\) (\d+\.\d+\.\d+)/)?.[1];
  const problems220 = [];
  if (!/^\d+\.\d+\.\d+$/.test(pinned ?? '')) problems220.push(`frontend/package.json pins uplot as ${pinned ?? 'nothing'}, not an exact version`);
  if (!notice.includes('Permission is hereby granted, free of charge')) {
    problems220.push('TimeSeriesChart.jsx no longer opens with uPlot\'s MIT notice as a /*! comment');
  }
  if (named !== pinned) problems220.push(`TimeSeriesChart.jsx's notice names uPlot ${named ?? 'no version'}; package.json pins ${pinned}`);
  if (listed !== pinned) problems220.push(`NOTICE.md names uPlot ${listed ?? 'no version'}; package.json pins ${pinned}`);
  if (problems220.length) {
    fail('uPlot\'s notice and the version the dashboard pins disagree:\n' + problems220.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the bundle carries the notice of uPlot ${pinned}, the version package.json pins, and NOTICE.md names it`);
  }
}
