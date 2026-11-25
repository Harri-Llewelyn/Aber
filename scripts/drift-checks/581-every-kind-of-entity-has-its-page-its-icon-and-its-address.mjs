import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 581. Every kind the Entities page lists has a page its drawer opens, an icon, and a name for each further
// id it has; and the page it opens is the one entityUrl() builds an address on, by the rail's name. A kind
// with none is a row whose drawer leads nowhere. The kinds are the words audit_trail.entity_type uses.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems581 = [];
  const entities = read('frontend/src/utils/entities.js');
  const drawer = read('frontend/src/components/tabs/EntityDrawer.jsx');
  const routes = read('frontend/src/routes.js');
  const nav = read('frontend/src/navigation.jsx');
  const constants = read('frontend/src/constants.js');

  const block = (source, name) => {
    const at = source.indexOf(`const ${name} = {\n`);
    return at < 0 ? '' : source.slice(source.indexOf('\n', at) + 1, source.indexOf('\n}', at));
  };
  const kinds = [...(entities.match(/export const ENTITY_KINDS = \[([\s\S]*?)\n\]/)?.[1] ?? '').matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]);
  const words = [...constants.matchAll(/\btable: '([a-z_]+)'/g)].map((m) => m[1]);
  const pages = new Map([...block(drawer, 'ENTITY_PAGES').matchAll(/^ {2}([a-z_]+): \{ type: '([a-z]+)', page: '([^']+)' \}/gm)].map((m) => [m[1], { type: m[2], page: m[3] }]));
  const icons = [...block(drawer, 'KIND_ICONS').matchAll(/^ {2}([a-z_]+): Icon\w+,/gm)].map((m) => m[1]);
  const named = [...block(entities, 'SECOND_ID_LABELS').matchAll(/^ {2}([a-z_]+): \[/gm)].map((m) => m[1]);
  const built = new Map((routes.match(/export const entityUrl = [\s\S]*?\{ ([^}]*) \}\[type\]/)?.[1] ?? '')
    .split(',').map((p) => p.split(':').map((x) => x.trim())).filter(([type, fn]) => type && fn));
  const rail = new Map([...nav.matchAll(/\{ id: '([a-z-]+)',\s+label: '([^']+)',\s+group: /g)].map((m) => [m[2], m[1]]));

  // The page each builder's address is on, through the wrapper an entity's variant needs.
  const pageOf = (fn, depth = 0) => {
    if (depth > 3) return null;
    const line = routes.split('\n').find((l) => l.startsWith(`export const ${fn} = `) || l.startsWith(`const ${fn} = `));
    const at = line ? routes.indexOf(line) : -1;
    const body = at < 0 ? '' : routes.slice(at, at + 400).split('\n').slice(0, 2).join('\n');
    const direct = body.match(/pageUrl\('([a-z-]+)'/)?.[1] ?? body.match(/`\/([a-z-]+)\//)?.[1];
    if (direct) return direct;
    const inner = body.match(/=> (\w+Url)\(/)?.[1];
    return inner ? pageOf(inner, depth + 1) : null;
  };

  if (kinds.length < 10) problems581.push(`read only ${kinds.length} kinds out of utils/entities.js`);
  if (built.size < 10) problems581.push(`read only ${built.size} kinds out of entityUrl()`);
  for (const kind of kinds) {
    if (!words.includes(kind)) problems581.push(`${kind} is no word of AUDIT_TRAIL_ENTITY_TYPES, so its Audit Trail cannot be opened by kind`);
    if (!icons.includes(kind)) problems581.push(`EntityDrawer.jsx has no icon for ${kind}`);
    const page = pages.get(kind);
    if (!page) { problems581.push(`EntityDrawer.jsx has no page for ${kind}`); continue; }
    if (!rail.has(page.page)) problems581.push(`${kind} opens ${page.page}, which the rail does not list`);
    const builder = built.get(page.type);
    if (!builder) { problems581.push(`entityUrl() builds no address for ${page.type}, ${kind}'s`); continue; }
    const opens = pageOf(builder);
    if (opens !== rail.get(page.page)) problems581.push(`${kind} is said to open ${page.page}, and ${builder}() opens ${opens ?? 'a page this check cannot read'}`);
  }
  // The kinds the view gives no further id need no name for one.
  const CREATES = 'CREATE OR REPLACE VIEW public.entity_directory ';
  const view = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort().map((f) => read(f)).findLast((sql) => sql.includes(CREATES)) ?? '';
  const arms = view.slice(view.indexOf(CREATES)).split(';')[0].split('UNION ALL');
  if (arms.length < 10) problems581.push(`read only ${arms.length} arms of entity_directory out of the migrations`);
  for (const arm of arms) {
    const kind = arm.match(/SELECT '([a-z_]+)'::text/)?.[1];
    const none = /'\{\}'::text\[\]/.test(arm);
    if (kind && !none && !named.includes(kind)) problems581.push(`utils/entities.js has no name for ${kind}'s further ids`);
    if (kind && none && named.includes(kind)) problems581.push(`utils/entities.js names further ids for ${kind}, which has none`);
  }

  if (problems581.length) {
    fail(`a kind of entity is not drawn in full:\n${problems581.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`each of the ${kinds.length} kinds the Entities page lists has an icon, names for its further ids, and the page its address opens`);
  }
}
