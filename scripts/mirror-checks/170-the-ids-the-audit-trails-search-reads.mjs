import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 170. The Audit Trail's search reads every further id entity_directory lists (0331). A further id the search
// does not read is one a person can paste out of a drawer and find no history for. The view's second_ids are
// columns of the tables beneath it, and an audit row's snapshot names each field as its column is named, so
// the two lists are the same words. The page and its help say which they are.
// -------------------------------------------------------------------------------------------------

/** One arm's select list, split at the commas outside every bracket. */
function columnsOf(arm) {
  const list = arm.slice(arm.indexOf('SELECT') + 'SELECT'.length);
  const columns = [''];
  let depth = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(' || list[i] === '[') depth += 1;
    if (list[i] === ')' || list[i] === ']') depth -= 1;
    if (depth === 0 && list.startsWith('\n   FROM ', i)) break;
    if (depth === 0 && list[i] === ',') columns.push('');
    else columns[columns.length - 1] += list[i];
  }
  return columns;
}

/** Each column of second_ids, and what the help and the page's hint call it. */
const WORDS = {
  sparkplug_id: 'Sparkplug', reported_identity: 'published', semantic_id: 'semantic', key: 'automation', storage_path: "capture's file", stamp: "backup's stamp",
};

export default function check() {
  const view = lastDefinition('CREATE OR REPLACE VIEW public.entity_directory', ';', 'public.entity_directory');
  const search = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_trail_matching(', '$$;', 'public.audit_trail_matching()');
  if (!view || !search) return;

  const arms = view.body.split('UNION ALL').map(columnsOf);
  const at = arms[0].findIndex((column) => /\bAS second_ids$/.test(column.trim()));
  if (at < 0) {
    problems.push("trailSearch: entity_directory's first arm has no second_ids, so this check is checking nothing");
    return;
  }
  // A lookup's own WHERE and ORDER BY name columns that are not the id, and a snapshot is not one either.
  const listed = [...new Set(arms.flatMap((columns) => {
    const ids = columns[at].replace(/\bFROM\b[^)]*\bORDER BY\b[^)]*/g, '').replace(/\b[a-z]\.old_data\b/g, '');
    return [...ids.matchAll(/\b[a-z]\.([a-z_]+)\b|->> '([a-z_]+)'/g)].map((m) => m[1] ?? m[2]);
  }))].sort();
  compare('trailSearch', "the columns of entity_directory's second_ids, and those this check has a word for", listed, Object.keys(WORDS).sort());

  // Both snapshots: an INSERT has only the new one and a DELETE only the old.
  const inNew = [...search.body.matchAll(/t\.new_data ->> '([a-z_]+)'/g)].map((m) => m[1]);
  const inOld = [...search.body.matchAll(/t\.old_data ->> '([a-z_]+)'/g)].map((m) => m[1]);
  compare('trailSearch', 'the fields the search reads in the new snapshot, and in the old', inNew, inOld);
  compare('trailSearch', 'the further ids entity_directory lists that the search does not read', listed.filter((column) => !inNew.includes(column)), []);
  // A metric's further ids are in no row of the metric's own.
  need(search.body, /SELECT s\.metric_id FROM public\.metric_semantic_ids s\s+WHERE s\.semantic_id ILIKE p_pattern/, "audit_trail_matching()'s lookup of a metric by a further semantic id");

  const help = read('help/pages/audit-trail.md').split('\n').find((line) => line.startsWith('- **The search box**')) ?? '';
  const hint = need(read('frontend/src/components/tabs/AuditTrailTab.jsx'), /const SEARCH_HELP =\s+((?:'[^\n]*'|"[^\n]*")(?:\s+\+ (?:'[^\n]*'|"[^\n]*"))*)/, 'SEARCH_HELP in AuditTrailTab.jsx');
  for (const [where, text] of [["the Audit Trail's help", help], ["the Audit Trail's hint", hint?.[1] ?? '']]) {
    const unsaid = listed.filter((column) => !text.toLowerCase().includes((WORDS[column] ?? column).toLowerCase()));
    if (unsaid.length) problems.push(`trailSearch: ${where} does not name ${unsaid.map((column) => WORDS[column] ?? column).join(', ')} among what the search takes`);
  }
}
