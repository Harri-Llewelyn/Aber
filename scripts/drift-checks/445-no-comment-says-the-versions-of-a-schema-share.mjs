import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 445. No comment or description says the versions of a schema share a name, or that a name's version
// suffix never stacks. Each version has a name of its own (`X`, `X_v2`), and a name fork_schema() had
// to suffix (`X_v2_2`) is versioned again as `X_v2_2_v3`. What the versions share is the lineage's name,
// `lineage_name`. The Audit Trail's snapshotIdentity() and the API reference said otherwise.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems445 = [];
  const trail = read('frontend/src/components/tabs/AuditTrailTab.jsx');
  const identity = trail.slice(trail.indexOf('export function snapshotIdentity'), trail.indexOf('export function snapshotIdentity') + 1600);
  if (/lineage shares\s+`schema_name`/.test(identity.replace(/\n\s*\/\/ /g, ' '))) {
    problems445.push('snapshotIdentity() says a lineage shares schema_name');
  }
  if (!/Each version has a name of its own/.test(identity)) problems445.push('snapshotIdentity() does not say each version has a name of its own, as the comment about its qualifier must');
  if (/qualifier: version \? `v\$\{version\}` : undefined/.test(identity) === false) problems445.push('snapshotIdentity() no longer returns the version as a qualifier, which a long name\'s cut end needs');

  const openapi = read('docs/openapi.yaml');
  if (/suffixes never stack/.test(openapi)) problems445.push('docs/openapi.yaml still says suffixes never stack');
  if (!/lineage_name: \{ type: string, readOnly: true/.test(openapi)) problems445.push('docs/openapi.yaml\'s Schema does not describe lineage_name');
  const version = read('frontend/src/utils/schemaVersion.js');
  if (/so suffixes never stack/.test(version)) problems445.push('schemaVersion.js still says suffixes never stack');

  if (problems445.length) {
    fail('a comment says the versions of a schema share a name:\n' + problems445.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('no comment or description says the versions of a schema share a name or that a suffix never stacks; the Audit Trail keeps its version qualifier and says why');
  }
}
