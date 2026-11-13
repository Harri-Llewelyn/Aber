import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 8b. The monthly scan (image-scan.yml, running scripts/scan-images.mjs) excludes this repository's
// own images because release.yml scans them; this holds each build job to a scan on the same
// policy, placed BEFORE its push, or the scan reports on an artefact the world can already pull.
// Textual, not a YAML parse: it runs before `npm install`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const workflow = read('.github/workflows/image-scan.yml');
  const scan = read('scripts/scan-images.mjs');
  const release = read('.github/workflows/release.yml');

  // The exclusion is what creates the obligation. If the monthly job ever scans the published
  // images itself, this check should be revisited rather than satisfied.
  const excludes = /node scripts\/scan-images\.mjs/.test(workflow) &&
    /const OWN = 'ghcr\.io\/harri-llewelyn\/'/.test(scan) && /startsWith\(OWN\)/.test(scan);
  const monthlyPolicy = ["'--severity', 'HIGH,CRITICAL'", "'--ignore-unfixed'"].filter((f) => !scan.includes(f));
  if (!excludes) {
    fail(
      'image-scan.yml no longer runs scripts/scan-images.mjs, or that script no longer excludes ' +
      'this repository\'s own images from the monthly scan. Check 8b exists to hold release.yml to ' +
      'that exclusion; decide which job owns them and update both this check and the comments in ' +
      'image-scan.yml.'
    );
  } else if (monthlyPolicy.length) {
    fail(`scripts/scan-images.mjs no longer passes ${monthlyPolicy.join(' and ')}, the policy release.yml is held to`);
  } else {
    // The policy the monthly job applies, which the release scan must match: a stricter release
    // gate would fail on findings the monthly job teaches everyone to ignore, and a looser one
    // would let a release publish what the monthly job then reports.
    const POLICY = ['--severity HIGH,CRITICAL', '--ignore-unfixed', '--exit-code 1'];
    const jobs = ['build-images', 'build-ingestion-chain'];
    const problems8b = [];

    for (const job of jobs) {
      const start = release.indexOf(`\n  ${job}:`);
      if (start < 0) { problems8b.push(`release.yml has no \`${job}\` job`); continue; }
      const rest = release.slice(start + 1);
      const nextJob = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
      const body = nextJob > 0 ? rest.slice(0, nextJob) : rest;

      const scanAt = body.indexOf('trivy image');
      if (scanAt < 0) {
        problems8b.push(
          `${job} pushes images and never scans them, while image-scan.yml says it does`
        );
        continue;
      }
      for (const flag of POLICY) {
        if (!body.includes(flag)) {
          problems8b.push(`${job}'s scan omits \`${flag}\`, which image-scan.yml applies`);
        }
      }
      // build-push-action's `push:` (a literal or an expression), bake's `--push`, or `docker push`.
      const pushes = [/^\s+push: (true|\$\{\{)/m, /\s--push\b/, /\bdocker push\b/]
        .map((re) => body.search(re)).filter((i) => i >= 0);
      if (pushes.length === 0) {
        problems8b.push(`${job} has a scan and no push; this check has drifted from the workflow`);
      } else if (Math.min(...pushes) < scanAt) {
        problems8b.push(
          `${job} pushes before it scans, so the gate reports on an image that is already pullable`
        );
      }
    }

    if (problems8b.length) problems8b.forEach(fail);
    else pass(`release.yml scans every image it publishes, before pushing it (${jobs.length} jobs)`);
  }
}
