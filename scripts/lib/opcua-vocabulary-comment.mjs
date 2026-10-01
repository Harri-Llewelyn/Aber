/**
 * The COMMENT on public.opcua_vocabulary, derived from the rows 0002_seed_data.sql actually seeds.
 * scripts/generate-opcua-vocabulary.mjs writes it; scripts/check-opcua-seed-sync.mjs recomputes it
 * and requires the file to match, so a companion specification added by hand cannot leave the
 * comment naming the old set.
 */

export const COMMENT_BEGIN = '-- >>> BEGIN GENERATED opcua_vocabulary_table_comment';
export const COMMENT_END = '-- <<< END GENERATED opcua_vocabulary_table_comment';

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** Every companion_spec an `INSERT INTO public.opcua_vocabulary VALUES (...)` line in the seed names. */
export function seededSpecs(seed) {
  const specs = new Set();
  for (const [, spec] of seed.matchAll(/^INSERT INTO public\.opcua_vocabulary VALUES \('(?:[^']|'')*', '((?:[^']|'')*)'/gm)) {
    specs.add(spec.replace(/''/g, "'"));
  }
  return [...specs].sort();
}

/** The statement, given the seed and the specifications the generator verifies against a NodeSet. */
export function tableCommentStatement(seed, generatedSpecs) {
  const specs = seededSpecs(seed);
  const generated = specs.filter((s) => generatedSpecs.includes(s));
  const handWritten = specs.filter((s) => !generatedSpecs.includes(s));
  const text =
    `OPC UA companion specification data points: ${specs.join(', ')}. ` +
    `Reference data, not deployment state. The ${generated.join(', ')} rows are verified against the ` +
    `OPC Foundation NodeSet2 XML by scripts/generate-opcua-vocabulary.mjs` +
    (handWritten.length ? `; the ${handWritten.join(', ')} rows are hand-written. ` : '. ') +
    'node_id holds a browse path, not a resolvable numeric NodeId.';
  return `COMMENT ON TABLE public.opcua_vocabulary IS ${sqlString(text)};`;
}
