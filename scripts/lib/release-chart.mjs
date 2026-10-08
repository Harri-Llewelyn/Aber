/**
 * The published chart a checkout installs: its OCI reference, the version Chart.yaml gives it, how
 * two release versions compare, and the `helm install` of docs/install.md step 7. setup.mjs prints that command, try.mjs installs the
 * same chart, and check-docs-drift holds the printed command to the docs. node: built-ins only, so
 * all three run before any `npm install`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHART_REF = 'oci://ghcr.io/harri-llewelyn/aber/aber';
export const CHART_YAML = 'deploy/helm/aber/Chart.yaml';

/** Chart.yaml's `version:`, which is the chart's tag in the registry; null when there is none. */
export function chartVersionOf(text) {
  return /^version:\s*["']?([^"'\s#]+)/m.exec(text)?.[1] ?? null;
}

/**
 * Below zero, zero or above zero as release `a` comes before, is or comes after release `b`, by
 * number: 1.10.0 comes after 1.9.2. Each is X.Y.Z, with or without a leading `v`; anything else throws.
 */
export function compareReleases(a, b) {
  const parts = (version) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
    if (!m) throw new Error(`'${version}' is not a release version (X.Y.Z)`);
    return m.slice(1).map(Number);
  };
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The version of the chart in the checkout at `repoRoot`. Throws when Chart.yaml has none. */
export function readChartVersion(repoRoot) {
  const version = chartVersionOf(readFileSync(join(repoRoot, CHART_YAML), 'utf8'));
  if (!version) throw new Error(`${CHART_YAML} has no version: line`);
  return version;
}

/** docs/install.md step 7's install, as the lines a person copies, continued with `\`. */
export function installCommand({ version, valuesFile }) {
  return [
    `helm install aber ${CHART_REF} --version ${version} \\`,
    '  -n aber --create-namespace \\',
    `  -f ${valuesFile} -f site.yaml --timeout 15m`,
  ];
}

/** One line, `\` continuations joined and whitespace collapsed: how two copies are compared. */
export function normaliseCommand(text) {
  return text.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}
