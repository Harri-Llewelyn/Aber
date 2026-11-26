import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 168. A tombstone as a row of the directory. entity_directory's last arm reads retired_entities for the
// search, and retiredRow() in utils/entities.js reads the same tombstone for the drawer of the Entities page,
// which holds it already. One that reads another key of the deleted row finds an entity by an id its drawer
// does not show, or shows one the search does not find.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const view = lastDefinition('CREATE OR REPLACE VIEW public.entity_directory', ';', 'public.entity_directory');
  const row = need(read('frontend/src/utils/entities.js'), /export function retiredRow\(r\) \{([\s\S]*?)\n\}/, 'retiredRow() in utils/entities.js');
  if (!view || !row) return;
  const arm = view.body.slice(view.body.lastIndexOf('UNION ALL'));
  if (!arm.includes('retired_entities r')) { problems.push("retired: the last arm of entity_directory no longer reads retired_entities"); return; }

  const sorted = (values) => [...new Set(values)].sort();
  compare('retired', 'the keys of the deleted row the view reads, and the drawer', sorted([...arm.matchAll(/old_data ->> '([a-z_]+)'/g)].map((m) => m[1])),
    sorted([...row[1].matchAll(/\bold\.([a-z_]+)/g)].map((m) => m[1])));

  // The further ids, in order: the tombstone's own Sparkplug id, then the one it was published under where that is another.
  const ids = need(arm, /array_remove\(ARRAY\[r\.([a-z_]+), NULLIF\(r\.old_data ->> '([a-z_]+)'::text, r\.([a-z_]+)\)\]/, "the retired arm's further ids");
  const own = need(row[1], /\[r\.([a-z_]+), old\.([a-z_]+) === r\.([a-z_]+) \? null : old\.([a-z_]+)\]/, "retiredRow()'s further ids");
  if (ids && own) compare('retired', 'the further ids of a retired entity, in order', ids.slice(1, 4), own.slice(1, 4));

  for (const [what, sql, js] of [
    ['state', /'(retired)'::text/, /state: '([a-z]+)'/],
    ['variant of a replay lane', /THEN '([a-z_]+)'::text/, /shadow_of \? '([a-z_]+)'/],
  ]) {
    const inView = need(arm, sql, `the retired arm's ${what}`);
    const inRow = need(row[1], js, `retiredRow()'s ${what}`);
    if (inView && inRow) compare('retired', `the ${what}, in the view and the drawer`, inView[1], inRow[1]);
  }
}
