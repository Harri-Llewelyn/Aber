import { fail, gitignored, MARKDOWN, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 40. Every clone, install, image and signing identity the docs give names Chart.yaml's version.
//
// The commit a release tag points at carries its version (release.yml refuses one that does not),
// so a checkout of the tag must name that release wherever a reader copies from. A bump that misses
// one leaves the tag sending its reader to the release before. An example of the NEXT release
// (`git tag v1.0.3`) has none of these shapes. Records of the past are skipped, as in check 2d.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { CHART_REF, readChartVersion } = await import('../lib/release-chart.mjs');
  const version = readChartVersion(REPO);
  const RECORD = /^(?:docs\/incidents\.md$|supabase\/migrations\/archive\/|frontend\/dist\/|deploy\/helm\/aber\/files\/)/;
  const ref = CHART_REF.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const SHAPES = [
    ['clones the tag', /git clone --branch v(\d+\.\d+\.\d+[^\s]*)/g],
    ['installs the chart', new RegExp(`${ref}\\b[^\\n]*?--version "?(\\d+\\.\\d+\\.\\d+[^\\s"]*)`, 'g')],
    ['names an image', /ghcr\.io\/harri-llewelyn\/aber\/[a-z0-9-]+:(\d+\.\d+\.\d+[^\s'"`]*)/g],
    ['verifies a signature from the tag', /release\.yml@refs\/tags\/v(\d+\.\d+\.\d+[^\s'"`]*)/g],
  ];
  const files = [
    ...MARKDOWN.filter((f) => !RECORD.test(f) && !gitignored(f)),
    'test-harness/Dockerfile',
  ];
  let seen = 0;
  let wrong = 0;
  for (const file of files) {
    // `\` continuations joined, so an install split over lines is one command.
    const text = read(file).replace(/\\\r?\n\s*/g, ' ');
    for (const [what, shape] of SHAPES) {
      for (const m of text.matchAll(shape)) {
        seen++;
        if (m[1] !== version) {
          wrong++;
          fail(`${file} ${what} at ${m[1]}, and Chart.yaml's version is ${version}. Change ${file}: the commit a ` +
            'release tag points at names that release everywhere (deploy/k8s/README.md, Publishing a release).');
        }
      }
    }
  }
  const example = read('forge/gateway-platform/platform.yml.example');
  const tag = /^\s*tag: v(\S+)/m.exec(example)?.[1];
  if (tag !== version) {
    wrong++;
    fail(`forge/gateway-platform/platform.yml.example's tag is v${tag}, and Chart.yaml's version is ${version}: set it ` +
      'to the release, then run node scripts/sync-gateway-platform.mjs');
  }
  if (!seen) fail('check 40 found no clone, install, image or signing identity in the docs, so it compares nothing');
  else if (!wrong) {
    pass(`all ${seen} clone(s), install(s), image(s) and signing identities in the docs name the chart's version ${version}`);
  }
}
