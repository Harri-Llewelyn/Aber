import { fail, pass, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 19b. The documents that describe the running stack name Envoy's artefacts, not Kong's. Kong was
// deleted on 2026-09-13 and the design record went on describing it for two weeks (#444). Prose
// saying Kong WAS the gateway is fine; its config file, variables, annotation, metrics, image tag and
// auth plugin are what a reader would act on. docs/gateway.md's History is where Kong's facts live.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const CURRENT = ['docs/kubernetes-architecture.md', 'deploy/k8s/README.md', 'README.md', 'help/site/install.md',
    'help/site/running-the-server.md', 'docs/architecture.md', 'docs/security-model.md', 'supabase/README.md'];
  const ARTEFACTS = [/\bkong\.yml\b/, /\bKONG_[A-Z]/, /checksum\/kong-/, /\bkong_[a-z]/, /(?<![\w-])kong:\d/, /\bkey-auth\b/];
  const offences = [];
  for (const file of CURRENT) {
    readDoc(file).split('\n').forEach((line, i) => {
      if (ARTEFACTS.some((p) => p.test(line))) offences.push(`${file}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  if (offences.length) {
    fail(
      "a document describing the running stack names Kong's artefacts, and Kong is not the gateway " +
        '(docs/gateway.md; its facts belong in that file\'s History):\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(`the ${CURRENT.length} documents describing the running stack name no Kong artefact`);
  }
}
