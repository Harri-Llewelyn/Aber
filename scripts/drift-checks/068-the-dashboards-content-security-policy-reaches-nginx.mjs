import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 68. The dashboard's Content-Security-Policy reaches nginx, and admits the 3D viewer's stylesheet.
//
// The chart mounts its rendered policy over the image's empty include, at the path nginx.conf
// includes. A mount at any other path leaves the image's copy in place: no policy, and nothing
// fails. And style-src carries the hash of each <style> in @google/model-viewer's template, the
// one inline stylesheet the dashboard has; an upgrade that changes it leaves the viewer unstyled
// under an enforced policy. The hash is read from frontend/node_modules, which CI's frontend job
// installs; without it that half is skipped and says so.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const NGINX = 'frontend/nginx.conf';
  const DOCKERFILE = 'frontend/Dockerfile';
  const CHART = 'deploy/helm/aber/templates/apps/frontend.yaml';
  const TEMPLATE = 'frontend/node_modules/@google/model-viewer/lib/template.js';
  const chart = read(CHART);
  const included = read(NGINX).match(/^\s*include\s+(\S+content-security-policy\.conf);/m)?.[1];
  const copied = read(DOCKERFILE).match(/^COPY\s+content-security-policy\.conf\s+(\S+)/m)?.[1];
  const mounted = chart.match(/mountPath:\s*(\S+)\n\s*subPath:\s*content-security-policy\.conf/)?.[1];
  const wrong = [];
  if (!included) wrong.push(`${NGINX} includes no content-security-policy.conf`);
  else {
    if (copied !== included) wrong.push(`${DOCKERFILE} copies the image's include to ${copied}, and nginx.conf includes ${included}`);
    if (mounted !== included) wrong.push(`${CHART} mounts the policy at ${mounted}, and nginx.conf includes ${included}`);
  }
  const named = [...chart.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
  let hashes = 'skipped, frontend/node_modules is not installed';
  if (existsSync(join(REPO, TEMPLATE))) {
    const { createHash } = await import('node:crypto');
    const wanted = [...read(TEMPLATE).matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map((m) => `sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}`);
    if (!wanted.length) wrong.push(`${TEMPLATE} has no <style> any more: drop the hash from ${CHART}'s style-src`);
    for (const h of wanted.filter((w) => !named.includes(w))) {
      wrong.push(`${CHART}'s style-src lacks '${h}', the hash of a <style> in the installed model-viewer's template`);
    }
    for (const h of named.filter((n) => !wanted.includes(n))) {
      wrong.push(`${CHART}'s style-src names '${h}', which no <style> in the installed model-viewer's template hashes to`);
    }
    hashes = `${wanted.length} model-viewer stylesheet hash(es) match`;
  }
  if (wrong.length) {
    fail('the dashboard\'s Content-Security-Policy may not reach nginx, or refuses the 3D viewer\'s stylesheet:\n' +
      wrong.map((w) => `        ${w}`).join('\n'));
  } else {
    pass(`the chart mounts the dashboard's policy where nginx includes it; ${hashes}`);
  }
}
