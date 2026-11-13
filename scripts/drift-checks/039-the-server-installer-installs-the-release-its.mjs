import { fail, gitignored, MARKDOWN, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 39. The server installer installs the release its URL names, with the cert-manager the manual
// steps apply. deploy/install.sh carries both versions as variables, and the documentation hands
// out its URL at a tag, so three things that are written separately have to agree: its version
// and Chart.yaml's, its cert-manager and every documented one, and the tag in every URL.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const INSTALLER = 'deploy/install.sh';
  const script = read(INSTALLER);
  const version = script.match(/^ABER_VERSION=["']?([^"'\s]+)["']?\s*$/m)?.[1];
  const certManager = script.match(/^CERT_MANAGER_VERSION=["']?([^"'\s]+)["']?\s*$/m)?.[1];
  const chart = read('deploy/helm/aber/Chart.yaml').match(/^version:\s*["']?([^"'\s]+)/m)?.[1];

  // Where a person applies cert-manager by hand, and the version the dev loop (and so CI) applies.
  const CERT_MANAGER = /cert-manager\/releases\/download\/(v[\w.-]+)\/cert-manager\.yaml/g;
  const pins = [];
  for (const file of ['help/site/install.md', 'help/site/running-the-server.md']) {
    read(file).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(CERT_MANAGER)) pins.push({ at: `${file}:${i + 1}`, version: m[1] });
    });
  }
  const devLoop = read('scripts/dev-cluster.mjs').match(/^const CERT_MANAGER_VERSION = '([^']+)'/m)?.[1];
  if (devLoop) pins.push({ at: 'scripts/dev-cluster.mjs (CERT_MANAGER_VERSION)', version: devLoop });

  const URL = /raw\.githubusercontent\.com\/Harri-Llewelyn\/Aber\/([^/\s]+)\/deploy\/install\.sh/g;
  const urls = [];
  for (const file of MARKDOWN.filter((f) => !gitignored(f))) {
    read(file).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(URL)) urls.push({ at: `${file}:${i + 1}`, tag: m[1] });
    });
  }

  const wrong = [];
  if (!version || !certManager) {
    wrong.push(`${INSTALLER} no longer sets ABER_VERSION= and CERT_MANAGER_VERSION= on lines of their own; the extraction no longer matches`);
  }
  if (version && chart && version !== chart) {
    wrong.push(`${INSTALLER} installs ABER_VERSION=${version}, and Chart.yaml's version: is ${chart}. Change ABER_VERSION to ${chart}`);
  }
  if (!pins.some((p) => p.at.startsWith('help/site/install.md')) || !pins.some((p) => p.at.startsWith('help/site/running-the-server.md')) || !devLoop) {
    wrong.push('help/site/install.md, help/site/running-the-server.md or scripts/dev-cluster.mjs no longer names a cert-manager version; the extraction no longer matches');
  }
  const stalePins = pins.filter((p) => certManager && p.version !== certManager);
  if (stalePins.length) {
    wrong.push(
      `${INSTALLER} applies cert-manager ${certManager}, and ` +
        stalePins.map((p) => `${p.at} applies ${p.version}`).join(', ') +
        '. They move together: change whichever side is stale'
    );
  }
  if (!urls.some((u) => u.at.startsWith('help/site/install.md'))) {
    wrong.push('help/site/install.md no longer gives the installer\'s URL (raw.githubusercontent.com/Harri-Llewelyn/Aber/<tag>/deploy/install.sh)');
  }
  for (const u of urls.filter((x) => chart && x.tag !== `v${chart}`)) {
    wrong.push(`${u.at} fetches the installer at ${u.tag}, and the release is ${chart} (Chart.yaml). Change the URL's tag to v${chart}`);
  }

  if (wrong.length) {
    fail('the server installer disagrees with what it installs or where it is fetched from:\n' + wrong.map((w) => `        ${w}`).join('\n'));
  } else {
    pass(
      `the server installer installs ${version} (Chart.yaml's version), applies cert-manager ${certManager} as ` +
        `${pins.length} other place(s) do, and ${urls.length} documented URL(s) fetch it at v${version}`
    );
  }
}
