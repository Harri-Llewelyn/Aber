import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REGION } from '../lib/idta-template.mjs';
import { rowsOf, splitStatements } from '../lib/idta-template-rows.mjs';
import { readDigestRegion } from '../lib/opcua-seed-blocks.mjs';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 567. The 20 Digital Nameplate rows of idta_submodel_templates (0002, released, typed by hand) and the
// top-level Nameplate elements of idta_template_elements (0320, generated) say the same: the same
// elements in the same order, each with the same semantic id and type, and mandatory in one where the
// other's cardinality asks for at least one. The Nameplate dialog, the semantic id picker and the AAS
// export read the first, and the Templates tab, the dialog and the export the second, so a difference is
// two answers on two pages.
//
// What 0002 says of is_mandatory is not read: 0323's trigger gives every row its element's cardinality,
// whatever a statement proposes. So each of the 20 elements must state one, and the latest declaration
// of the trigger's function must still take it from there.
// -------------------------------------------------------------------------------------------------
const TEMPLATE_ID = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate';
const RELEASED = 'supabase/migrations/0002_seed_data.sql';
const GENERATED = 'supabase/migrations/0320_an_idta_template_is_seeded_with_its_nested_elements.sql';
const FUNCTION = 'CREATE OR REPLACE FUNCTION public.idta_submodel_template_as_generated()';
const TRIGGER = 'BEFORE INSERT OR UPDATE ON public.idta_submodel_templates FOR EACH ROW EXECUTE FUNCTION public.idta_submodel_template_as_generated()';

/** The body of the latest declaration of the trigger's function, and whether the chain makes the trigger. */
function triggerInTheChain() {
  let body = null;
  let made = false;
  for (const name of readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    const sql = read(`supabase/migrations/${name}`);
    const at = sql.lastIndexOf(FUNCTION);
    if (at >= 0) body = sql.slice(at, sql.indexOf('$$;', at));
    if (sql.includes(TRIGGER)) made = true;
  }
  return { body, made };
}

export default function check() {
  const problems567 = [];
  const released = [...read(RELEASED).matchAll(
    /^ {2}\('([^']+)', '(?:[^']|'')*', '[^']+', '([A-Za-z0-9_]+)', '([^']+)', '(IRI|IRDI)', '(?:[^']|'')*', (?:true|false), (\d+)\)/gm
  )].map(([, templateId, id, semanticId, type, ordinal]) => ({ templateId, id, semanticId, type, ordinal: Number(ordinal) }))
    .filter((row) => row.templateId === TEMPLATE_ID)
    .sort((a, b) => a.ordinal - b.ordinal);
  const region = readDigestRegion(read(GENERATED).replace(/\r\n/g, '\n'), REGION);
  const made = region?.body ? splitStatements(region.body).map(rowsOf).find((template) => template?.template[0] === TEMPLATE_ID) : null;
  if (released.length === 0 || !made) {
    fail('567: found no Digital Nameplate rows in 0002 or in 0320 -- a file\'s shape changed, so this check is no longer checking anything');
    return;
  }
  const top = made.rows.filter((row) => row.parent_path === null);

  const names = (rows, key) => rows.map((row) => row[key]).join(', ');
  if (names(released, 'id') !== names(top, 'path')) {
    problems567.push(`0002 seeds ${names(released, 'id')}, and 0320's top-level elements are ${names(top, 'path')}`);
  }
  for (const row of released) {
    const element = top.find(({ path }) => path === row.id);
    if (!element) continue;
    if (element.semantic_id !== row.semanticId || element.semantic_id_type !== row.type) {
      problems567.push(`${row.id}: 0002 carries ${row.semanticId} (${row.type}), and 0320 ${element.semantic_id} (${element.semantic_id_type})`);
    }
    if (element.cardinality === null) {
      problems567.push(`${row.id}: 0320 states no cardinality, so is_mandatory would be what 0002 says`);
    }
  }
  const trigger = triggerInTheChain();
  if (!trigger.made) problems567.push('no migration makes the trigger that gives a row of idta_submodel_templates its element\'s cardinality');
  if (!trigger.body?.includes("NEW.is_mandatory := v_cardinality IN ('One', 'OneToMany');") ||
      !trigger.body.includes('WHERE e.template_id = NEW.template_id AND e.path = NEW.id_short;')) {
    problems567.push('idta_submodel_template_as_generated() no longer sets is_mandatory from the element\'s cardinality');
  }

  if (problems567.length) {
    fail('the released Digital Nameplate rows and the generated template elements disagree:\n' + problems567.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${released.length} released Digital Nameplate rows are the ${top.length} top-level elements of the generated template, in order and by id, and each is mandatory as its cardinality has it`);
  }
}
