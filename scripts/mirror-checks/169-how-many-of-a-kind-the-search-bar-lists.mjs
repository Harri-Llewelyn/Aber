import { compare, lastDefinition, need, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 169. How many of a kind the search bar lists, and which (0321). find_entities() keeps the best of each kind
// and shortlist() orders them with people's rows, so the two order a kind alike: how the text names a row, then
// its state, then its name. A kind the database orders otherwise loses rows the bar would have put first. The
// kinds' limits together fit in one answer, or the total would cut a kind short.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const bar = read('frontend/src/components/common/GlobalSearch.jsx');
  const page = read('frontend/src/utils/entities.js');
  const call = read('frontend/src/api.js').match(/supabase\.rpc\('find_entities', \{[\s\S]*?\}\);/)?.[0] ?? '';
  const api = read('docs/openapi.yaml');
  const apiFind = api.slice(api.indexOf('\n  /rest/v1/rpc/find_entities:\n'), api.indexOf('\n  /rest/v1/retired_entities:\n'));
  const find = lastDefinition('CREATE OR REPLACE FUNCTION public.find_entities(', '$$;', 'public.find_entities()');
  if (!find) return;

  // -- the argument -------------------------------------------------------------------------------
  const named = need(find.body, /\(([^)]*)\)\nRETURNS SETOF/, "find_entities()' arguments");
  if (named) {
    const args = [...named[1].matchAll(/\b(p_[a-z_]+) /g)].map((m) => m[1]);
    compare('search', "find_entities()' arguments, and those the dashboard sends", args, [...call.matchAll(/\b(p_[a-z_]+):/g)].map((m) => m[1]));
    compare('search', "find_entities()' arguments, and the API reference's", args, [...apiFind.matchAll(/^ {16}(p_[a-z_]+):/gm)].map((m) => m[1]));
    need(named[1], /p_per_kind integer DEFAULT NULL/, "find_entities()' p_per_kind, which a caller may leave out");
  }

  // -- a kind's order -----------------------------------------------------------------------------
  const order = need(find.body, /PARTITION BY e\.kind\s+ORDER BY ([^)]*\([^)]*\)[^)]*)\)/, "find_entities()' order within a kind");
  if (order) compare('search', "a kind's order in find_entities(): the rank, the state, then the name, a shorter one first", order[1].replace(/\s+/g, ' '), 'm.rank, e.state, length(e.name), e.name, e.id');
  const states = need(page, /const STATE_ORDER = \{([^}]*)\}/, 'STATE_ORDER in utils/entities.js');
  if (states) {
    // The database orders the states by their letters.
    const own = [...states[1].matchAll(/(\w+): (\d)/g)].sort((a, b) => a[2] - b[2]).map((m) => m[1]);
    compare('search', "the states in the browser's order, and by their letters", own, [...own].sort());
    const view = lastDefinition('CREATE OR REPLACE VIEW public.entity_directory', ';', 'public.entity_directory');
    if (view) {
      const listed = new Set([...view.body.matchAll(/'(active|archived|retired)'::text/g)].map((m) => m[1]));
      compare('search', 'the states the view gives and the browser orders', [...listed].sort(), [...own].sort());
    }
  }
  const sort = need(page, /export function shortlist\([\s\S]*?\.sort\(\(a, b\) => ([\s\S]*?)\)\n {2}const taken/, "shortlist()'s order in utils/entities.js");
  if (sort) {
    const terms = sort[1].split('||').map((t) => ['rank', 'stateRank', 'name', 'byKindThenName'].find((w) => t.includes(w)));
    compare('search', "shortlist()'s order: the rank, the state, the name", terms.slice(0, 3), ['rank', 'stateRank', 'name']);
  }

  // -- the numbers --------------------------------------------------------------------------------
  const perKind = need(bar, /export const RECORD_KIND_LIMIT = (\d+)/, 'RECORD_KIND_LIMIT in GlobalSearch.jsx');
  const total = need(read('frontend/src/constants.js'), /export const ENTITY_FIND_LIMIT = (\d+)/, 'ENTITY_FIND_LIMIT in constants.js');
  const kinds = need(page, /export const ENTITY_KINDS = \[([\s\S]*?)\n\]/, 'ENTITY_KINDS in utils/entities.js');
  if (perKind && total && kinds) {
    const listed = [...kinds[1].matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]).filter((k) => k !== 'user_roles');
    compare('search', `whether ${perKind[1]} of each of ${listed.length} kinds fits in an answer of ${total[1]}`, listed.length * perKind[1] <= total[1], true);
  }
}
