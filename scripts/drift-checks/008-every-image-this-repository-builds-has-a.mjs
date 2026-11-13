import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 8. Every image this repository builds has a documented build command (arm64 clusters and
// air-gapped ones build their own, and a change to a component has to be tagged as the reference
// the chart resolves). The image set is identified by an empty tag, which marks the images the
// chart resolves from Chart.AppVersion.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const values = read('deploy/helm/aber/values.yaml');
  const built = [
    ...values.matchAll(/repository:\s*(\S+)[\s\S]{0,400}?^\s{4}tag:\s*""\s*$/gm),
  ].map((m) => m[1]);
  const unique = [...new Set(built)];
  // Bumped deliberately rather than derived: the count is the check.
  const EXPECTED = 12;
  if (unique.length !== EXPECTED) {
    fail(
      `expected ${EXPECTED} chart images with an empty tag (built here, resolved from appVersion); ` +
        `found ${unique.length}: ${unique.join(', ') || '(none)'}`
    );
  } else {
    const runbook = read('deploy/k8s/README.md');
    const undocumented = unique.filter((img) => {
      const name = img.split('/').pop();
      return (
        !new RegExp(`docker build[^\\n]*${name}`).test(runbook) &&
        !new RegExp(`-t\\s+\\$NS/${name}:`).test(runbook)
      );
    });
    if (undocumented.length) {
      fail(`deploy/k8s/README.md has no build command for: ${undocumented.join(', ')}`);
    } else {
      pass(`all ${unique.length} images built here have documented build commands`);
    }
  }
}
