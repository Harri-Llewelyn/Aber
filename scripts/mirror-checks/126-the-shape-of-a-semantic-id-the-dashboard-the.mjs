import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lastDefinition, need, ok, problems, ROOT } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 126. The shape of a semantic id, in two places (0306): inferSemanticIdType() in the dashboard, which
// types an id the Import dialog reads from a file, and semantic_id_shape() in the database, which
// import_site_vocabulary() holds every row to. An id one calls an IRDI and the other refuses is a row
// the dialog offers and the function rejects, or the reverse. The database's three patterns are read
// out of the function and run against the same probes as the dashboard's rule, so a change to either
// that moves one answer fails here. The probes are those of the db suite's `Shape`.
// -------------------------------------------------------------------------------------------------
const PROBES = [
  'https://admin-shell.io/idta/x', 'http://example.com', 'urn:uuid:1234', 'URN:iso:std:iso:22400', 'HTTPS://EXAMPLE.COM/x',
  '0173-1#02-AAO677#002', '0112/2///61987#ABA951#009', '0173-1#02-AAO677#002/0173-1#07-AAA123#001',
  'nsu=http://opcfoundation.org/UA/Machinery/;i=6003', 'nsu=urn:x;s=Name', 'nsu=http://x/;g=0000', 'nsu=http://x/;b=AAAA',
  'plain', 'ns=2;i=5', '', 'nsu=;i=1', 'ftp://example.com/x', '0173-1#02-AAO677', '173-1#02-AAO677#002',
  'nsu=http://x/;i=1\nmore', 'nsu=http://x/;i=1\rmore', 'urn', 'https:/example.com',
];

export default async function check() {
  const { inferSemanticIdType } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.semantic_id_shape(', '$fn$;', 'semantic_id_shape()');
  if (!fn) return;
  const irdi = need(fn.body, /c_irdi CONSTANT text := '([^']+)';/, `c_irdi in semantic_id_shape() (${fn.file})`);
  const iri = need(fn.body, /p_id ~\* '([^']+)' THEN\s+RETURN 'IRI'/, `the IRI pattern in semantic_id_shape() (${fn.file})`);
  const node = need(fn.body, /p_id ~ '([^']+)' THEN\s+RETURN 'ExpandedNodeId'/, `the ExpandedNodeId pattern in semantic_id_shape() (${fn.file})`);
  const joined = need(fn.body, /p_id ~ \('\^' \|\| c_irdi \|\| '\(\?:\/' \|\| c_irdi \|\| '\)\*\$'\)/, `the IRDI pair composition in semantic_id_shape() (${fn.file})`);
  if (!irdi || !iri || !node || !joined) return;

  const iriRe = new RegExp(iri[1], 'i');
  const irdiRe = new RegExp(`^${irdi[1]}(?:/${irdi[1]})*$`);
  const nodeRe = new RegExp(node[1]);
  const sql = (v) => (iriRe.test(v) ? 'IRI' : irdiRe.test(v) ? 'IRDI' : nodeRe.test(v) ? 'ExpandedNodeId' : '');

  const differ = PROBES.filter((v) => (inferSemanticIdType(v) || '') !== sql(v));
  if (differ.length) {
    problems.push(`semanticIdShape: semantic_id_shape() (${fn.file}) and inferSemanticIdType() answer differently for ${differ.map((v) => JSON.stringify(v)).join(', ')}` +
      ` -- the database says ${differ.map((v) => JSON.stringify(sql(v))).join(', ')}, the dashboard ${differ.map((v) => JSON.stringify(inferSemanticIdType(v) || '')).join(', ')}`);
  } else {
    ok.push(`semanticIdShape: semantic_id_shape() (${fn.file}) and inferSemanticIdType() give one answer for each of ${PROBES.length} ids, IRIs, IRDIs, ExpandedNodeIds and what is none of them`);
  }
}
