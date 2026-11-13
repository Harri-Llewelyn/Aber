import { CHART_VALUES, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 20. The release workflow names every image the chart resolves from `appVersion`, and no other.
//
// The chart marks an image it builds here with an empty tag and resolves it to `Chart.AppVersion`
// (check 8). An image added to the chart but not to the release's lists publishes nothing and
// installs into an ImagePullBackOff at the version it claims to ship; one removed from the chart
// and left in the lists fails the release's own verification step. Both lists are spelled out in
// `release.yml` because a shell loop cannot read the chart, so they are what drifts.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const RELEASE = '.github/workflows/release.yml';
  const release = read(RELEASE);
  const built = new Set(
    [...CHART_VALUES.matchAll(/repository:\s*(\S+)[\s\S]{0,400}?^\s{4}tag:\s*""\s*$/gm)]
      .map((m) => m[1].split('/').pop())
  );
  const lists = [...release.matchAll(/for img in ([a-z0-9 -]+); do/g)].map((m) => m[1].trim().split(/\s+/));

  if (!lists.length) {
    fail(`${RELEASE} has no \`for img in …\` list; check 20 can no longer see what is published`);
  } else {
    const offences = [];
    lists.forEach((list, n) => {
      for (const img of list) {
        if (!built.has(img)) offences.push(`list ${n + 1} names ${img}, which the chart does not resolve from appVersion`);
      }
      for (const img of built) {
        if (!list.includes(img)) offences.push(`list ${n + 1} omits ${img}, which the chart resolves from appVersion`);
      }
    });
    if (offences.length) {
      fail(
        'the release workflow and the chart disagree about which images ship:\n' +
          [...new Set(offences)].map((o) => `        ${o}`).join('\n')
      );
    } else {
      pass(`the release workflow publishes all ${built.size} image(s) the chart builds here`);
    }
  }
}
