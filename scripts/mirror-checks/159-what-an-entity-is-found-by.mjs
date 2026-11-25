import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 159. What an entity is found by, and what is listed (0321). The database answers entity_directory and
// find_entities(); utils/entities.js applies the same search to the rows only the browser holds and names
// the kinds, the API reference publishes both, and the Entities help tells a reader the numbers. A kind one
// lacks is a row with no name; a number one lacks is a search that answers differently for a person than for
// a device, or a limit the page reads as "that is all of them".
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sorted = (values) => [...new Set(values)].sort();
  const page = read('frontend/src/utils/entities.js');
  const help = read('help/pages/archives.md');
  const api = read('docs/openapi.yaml');
  const apiEntity = api.slice(api.indexOf('\n    Entity:\n'), api.indexOf('\n    DeviceSubmodel:\n'));
  const apiFind = api.slice(api.indexOf('\n  /rest/v1/rpc/find_entities:\n'), api.indexOf('\n  /rest/v1/retired_entities:\n'));

  const view = lastDefinition('CREATE OR REPLACE VIEW public.entity_directory', ';', 'public.entity_directory');
  const find = lastDefinition('CREATE OR REPLACE FUNCTION public.find_entities(', '$$;', 'public.find_entities()');
  if (!view || !find) return;

  // -- the kinds ----------------------------------------------------------------------------------
  // Each arm's first column is its kind; the tombstones' is the table they were in.
  const inView = sorted([...view.body.matchAll(/\bSELECT '([a-z_]+)'::text/g)].map((m) => m[1]));
  const kinds = need(page, /export const ENTITY_KINDS = \[([\s\S]*?)\n\]/, 'ENTITY_KINDS in utils/entities.js');
  if (kinds) {
    const listed = [...kinds[1].matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]);
    // People are read apart, by functions, so they are a kind of the page's and not the view's.
    compare('entities', 'the kinds the view lists and the Entities page names', inView, sorted(listed.filter((k) => k !== 'user_roles')));
    if (!listed.includes('user_roles')) problems.push("entities: utils/entities.js no longer names people's kind, user_roles");
  }
  const apiKinds = need(apiEntity, /\n {8}kind:\n {10}type: string\n {10}enum: \[([^\]]+)\]/, "the API reference's kinds of an Entity");
  if (apiKinds) compare('entities', 'the kinds the view lists and the API reference names', inView, sorted(apiKinds[1].split(',').map((k) => k.trim())));

  // -- the columns --------------------------------------------------------------------------------
  const firstArm = view.body.slice(0, view.body.indexOf('UNION ALL'));
  const columns = [...firstArm.matchAll(/(?:\bAS |^ {4}a\.)([a-z_]+)(?=,|\n)/gm)].map((m) => m[1]);
  const properties = [...apiEntity.slice(apiEntity.indexOf('\n      properties:\n')).matchAll(/^ {8}([a-z_]+):/gm)].map((m) => m[1]);
  compare('entities', "the view's columns and the API reference's", sorted(columns), sorted(properties));

  // -- what sets a row apart ----------------------------------------------------------------------
  const words = sorted([...view.body.matchAll(/THEN '([a-z_]+)'::text/g)].map((m) => m[1]).filter((w) => w !== 'archived'));
  const said = apiEntity.match(/\n {8}variant:\n[\s\S]*?\n {8}second_ids:/)?.[0] ?? '';
  const unsaid = words.filter((w) => !said.includes(`\`${w}\``));
  if (unsaid.length) problems.push(`entities: the API reference's variant does not name ${unsaid.join(', ')}, which the view answers`);

  // -- the numbers --------------------------------------------------------------------------------
  const prefix = need(find.body, /length\(q\.text\) >= (\d+)/, "the fewest characters of an id's start in find_entities()");
  const limit = need(find.body, /p_limit integer DEFAULT (\d+)/, "find_entities()' default limit");
  const most = need(find.body, /least\(greatest\(coalesce\(p_limit, (\d+)\), 1\), (\d+)\)/, "find_entities()' bounds");
  if (prefix) {
    const own = need(page, /export const ID_PREFIX_MIN = (\d+)/, 'ID_PREFIX_MIN in utils/entities.js');
    if (own) compare('entities', "the fewest characters of an id's start, in the database and the browser", prefix[1], own[1]);
    for (const [where, text, phrase] of [
      ['the help', help, `from its first ${prefix[1]} characters`],
      ['the API reference', apiFind, `from ${prefix[1]} characters`],
    ]) if (!text.includes(phrase)) problems.push(`entities: ${where} does not say "${phrase}", which is find_entities()' rule`);
  }
  if (limit && most) {
    compare('entities', "find_entities()' default, stated twice", limit[1], most[1]);
    const own = need(read('frontend/src/constants.js'), /export const ENTITY_FIND_LIMIT = (\d+)/, 'ENTITY_FIND_LIMIT in constants.js');
    if (own) compare('entities', 'how many rows a search answers, and how many the page asks for', limit[1], own[1]);
    if (!help.includes(`lists ${limit[1]} matches at most`)) problems.push(`entities: the help does not say a search lists ${limit[1]} matches at most`);
    const stated = need(apiFind, /p_limit: \{ type: integer, default: (\d+), minimum: 1, maximum: (\d+),/, "the API reference's p_limit");
    if (stated) compare('entities', "find_entities()' default and most, and the API reference's", [limit[1], most[2]], [stated[1], stated[2]]);
  }

  // -- the order ----------------------------------------------------------------------------------
  // A whole id, a whole name, the start of an id, part of a name: the four ranks, in that order.
  const ranks = [...find.body.matchAll(/THEN (\d)\n/g)].map((m) => m[1]);
  const own = [...(page.match(/export function findRank\([\s\S]*?\n\}/)?.[0] ?? '').matchAll(/return (\d)\n/g)].map((m) => m[1]);
  compare('entities', 'the ranks of a search, in the database and the browser', ranks, own);
}
