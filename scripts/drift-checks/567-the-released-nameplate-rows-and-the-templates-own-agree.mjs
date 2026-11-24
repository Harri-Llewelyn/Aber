import { REGION } from '../lib/idta-template.mjs';
import { rowsOf, splitStatements } from '../lib/idta-template-rows.mjs';
import { readDigestRegion } from '../lib/opcua-seed-blocks.mjs';
import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 567. The 20 Digital Nameplate rows of idta_submodel_templates (0002, released, typed by hand) and the
// top-level Nameplate elements of idta_template_elements (0320, generated) say the same: the same
// elements in the same order, each with the same semantic id and type, and mandatory in one where the
// other's cardinality asks for at least one. The Nameplate dialog, the semantic id picker and the AAS
// export read the first, and the Templates tab the second, so a difference is two answers on two pages.
//
// The differences listed are the ones known: the released rows followed version 2.0 of the template, and
// 3.0 swapped these two. A listed difference that is gone fails as well, so the list stays true.
// -------------------------------------------------------------------------------------------------
const TEMPLATE_ID = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate';
const RELEASED = 'supabase/migrations/0002_seed_data.sql';
const GENERATED = 'supabase/migrations/0320_an_idta_template_is_seeded_with_its_nested_elements.sql';
const KNOWN = {
  OrderCodeOfManufacturer: 'the released row is optional, the template asks for One',
  YearOfConstruction: 'the released row is mandatory, the template asks for ZeroToOne',
};

export default function check() {
  const problems567 = [];
  const released = [...read(RELEASED).matchAll(
    /^ {2}\('([^']+)', '(?:[^']|'')*', '[^']+', '([A-Za-z0-9_]+)', '([^']+)', '(IRI|IRDI)', '(?:[^']|'')*', (true|false), (\d+)\)/gm
  )].map(([, templateId, id, semanticId, type, mandatory, ordinal]) => ({ templateId, id, semanticId, type, mandatory: mandatory === 'true', ordinal: Number(ordinal) }))
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
  const differs = new Set();
  for (const row of released) {
    const element = top.find(({ path }) => path === row.id);
    if (!element) continue;
    if (element.semantic_id !== row.semanticId || element.semantic_id_type !== row.type) {
      problems567.push(`${row.id}: 0002 carries ${row.semanticId} (${row.type}), and 0320 ${element.semantic_id} (${element.semantic_id_type})`);
    }
    if (['One', 'OneToMany'].includes(element.cardinality) !== row.mandatory) {
      differs.add(row.id);
      if (!(row.id in KNOWN)) problems567.push(`${row.id}: 0002 says is_mandatory ${row.mandatory}, and 0320's cardinality is ${element.cardinality}`);
    }
  }
  for (const [id, what] of Object.entries(KNOWN)) {
    if (!differs.has(id)) problems567.push(`${id}: this check lists a difference (${what}) that is gone`);
  }

  if (problems567.length) {
    fail('the released Digital Nameplate rows and the generated template elements disagree:\n' + problems567.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${released.length} released Digital Nameplate rows are the ${top.length} top-level elements of the generated template, in order and by id, and differ only in whether ${Object.keys(KNOWN).join(' and ')} are mandatory, as listed`);
  }
}
