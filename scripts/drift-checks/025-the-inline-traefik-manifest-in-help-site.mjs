import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 25. The inline Traefik manifest in help/site/running-the-server.md (the help page Running the
// server, its Install) is deploy/k8s/traefik-config.yaml, which the dev loop applies: an install
// from the registry has no checkout, so the page carries a copy.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const manifest = (text) => text.split('\n').filter((l) => l.trim() && !l.trimStart().startsWith('#')).join('\n');
  const file = manifest(read('deploy/k8s/traefik-config.yaml'));
  const block = read('help/site/running-the-server.md').match(/kubectl apply -f - <<'EOF'\n([\s\S]*?)\nEOF\n/);
  if (!block) {
    fail("help/site/running-the-server.md no longer carries the Traefik HelmChartConfig as a `kubectl apply -f - <<'EOF'` block");
  } else if (manifest(block[1]) !== file) {
    fail('the Traefik HelmChartConfig in help/site/running-the-server.md differs from deploy/k8s/traefik-config.yaml, which the dev loop applies');
  } else if (!read('scripts/dev-cluster.mjs').includes("'deploy/k8s/traefik-config.yaml'")) {
    fail('scripts/dev-cluster.mjs no longer applies deploy/k8s/traefik-config.yaml, so the dev loop measures a different Traefik');
  } else {
    pass('Running the server (help/site/running-the-server.md) and the dev loop apply the same Traefik HelmChartConfig');
  }
}
