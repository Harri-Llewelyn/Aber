import { compare, need, read, SCHEMA } from './lib.mjs';

// 116. The reference types a metric's further semantic ids admit (0299): the table's CHECK, the
// catalogue's own, and SEMANTIC_ID_TYPES, which the Reference Type select offers. A further id is the
// same kind of thing as the metric's own: one list mixes IRIs, IRDIs and ExpandedNodeIds, and every
// type exports as an ExternalReference with one GlobalReference key. A type the catalogue admits and
// the table refuses is an id the Edit dialog offers and the database turns back; one the table admits
// and the catalogue does not is a further id of a kind no metric's own id could be.
export default function check() {
  const words = (list) => [...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort().join(', ');
  const further = need(SCHEMA, /CONSTRAINT metric_semantic_ids_type_valid\s+CHECK \(\(semantic_id_type = ANY \(ARRAY\[([^\]]*)\]\)\)\)/,
    'metric_semantic_ids_type_valid in the migrations');
  const own = [...SCHEMA.matchAll(/CONSTRAINT metric_catalog_semantic_id_type_valid CHECK \(\(\(semantic_id_type IS NULL\) OR \(semantic_id_type = ANY \(ARRAY\[([^\]]*)\]\)\)\)\)/g)].pop();
  if (!own) {
    compare('furtherSemanticIds', 'the catalogue type CHECK', 'found', 'missing -- its shape changed, so this check is no longer checking anything');
    return;
  }
  const list = need(read('frontend/src/utils/standards.js'), /export const SEMANTIC_ID_TYPES = \[([^\]]*)\]/, 'SEMANTIC_ID_TYPES in frontend/src/utils/standards.js');
  if (further && list) {
    compare('furtherSemanticIds', 'the reference types of the further ids table and the catalogue', words(further[1]), words(own[1]));
    compare('furtherSemanticIds', 'the reference types the dialog offers and the further ids table admits', words(list[1]), words(further[1]));
  }
}
