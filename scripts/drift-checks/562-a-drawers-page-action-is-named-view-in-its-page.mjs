import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 562. A drawer's action that opens a page of the dashboard is named "View in <page>", with the page's
// own name as the rail has it: "View in Audit Trail", or "View in Devices (3)" with what it would
// show. The actions are read out of every component that draws a ContextPanel: an object literal
// with a `label` and a `to`. The address says which page (PAGE_OF_URL), so a name that says another
// page fails too. The one action that keeps its words is listed (DOES_SOMETHING). An automation's own
// page, which is no drawer, names its link to the Audit Trail the same way. No help page and no doc
// quotes a name an action used to have; a released upgrade note says what its release did, and is left.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const offences = [];
  const nav = read('frontend/src/navigation.jsx');
  // The rail's pages by id. Their rows are the ones with a group, which no page's own tab has.
  const pageById = new Map([...nav.matchAll(/\{ id: '([a-z-]+)',\s+label: '([^']+)',\s+group: /g)].map((m) => [m[1], m[2]]));
  if (pageById.size < 15) offences.push(`could read only ${pageById.size} of the rail's pages out of frontend/src/navigation.jsx`);
  pageById.set('profile', 'Profile');
  const PAGES = new Set(pageById.values());

  // Each address builder a drawer's action uses, and the page it opens.
  const PAGE_OF_URL = {
    trailUrl: 'Audit Trail', changesByUrl: 'Audit Trail',
    deviceHistoryUrl: 'History', cellHistoryUrl: 'History', areaHistoryUrl: 'History', metricHistoryUrl: 'History',
    siteMapAreaUrl: 'Site Map', devicesInCellUrl: 'Devices', devicesForSchemaUrl: 'Devices',
    approvalsForUrl: 'Approvals', automationsForEntityUrl: 'Automations', areaUrl: 'Areas', cellUrl: 'Cells',
  };
  // It opens the subject's page to add to the open request, which is what it is named for.
  const DOES_SOMETHING = { 'Add to this proposal': 'proposalSubjectUrl' };

  /** The object literal around `at`, from its `{` to its `}`, by counting braces, or null. */
  const objectAround = (src, at) => {
    let depth = 0;
    let start = at;
    for (; start >= 0; start -= 1) {
      if (src[start] === '}') depth += 1;
      else if (src[start] === '{') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (start < 0) return null;
    depth = 0;
    for (let end = start; end < src.length; end += 1) {
      if (src[end] === '{') depth += 1;
      else if (src[end] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(start, end + 1);
      }
    }
    return null;
  };
  /** An object literal's own keys: its text without whatever is in braces inside it. */
  const ownText = (object) => {
    let depth = 0;
    let own = '';
    for (const c of object) {
      if (c === '}') depth -= 1;
      if (depth === 1) own += c;
      if (c === '{') depth += 1;
    }
    return own;
  };
  /** The strings a label's expression may come to, read up to the end of its line. */
  const labelsOf = (object) => {
    const line = object.slice(object.indexOf('label:')).split('\n')[0].split(', icon:')[0];
    return [...line.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
  };

  const DRAWERS = allFiles.filter((f) => /^frontend\/src\/components\/.+\.jsx$/.test(f) && /<ContextPanel\b/.test(read(f)));
  if (DRAWERS.length < 15) offences.push(`found only ${DRAWERS.length} components that draw a ContextPanel`);
  let found = 0;
  for (const file of DRAWERS) {
    const src = read(file);
    for (const m of src.matchAll(/(?<=[\s{])to: /g)) {
      const object = objectAround(src, m.index - 1);
      const own = object ? ownText(object) : '';
      if (!/(^|\s)label: /.test(own) || !/(^|\s)icon: /.test(own) || !/(^|\s)to: /.test(own)) continue;
      const at = `${file}:${src.slice(0, m.index).split('\n').length}`;
      const url = src.slice(m.index + 'to: '.length).split('\n')[0];
      const labels = labelsOf(object);
      if (labels.length === 0) {
        offences.push(`${at}: an action that opens a page has a label this check cannot read`);
        continue;
      }
      found += 1;
      for (const label of labels) {
        if (DOES_SOMETHING[label]) {
          if (!url.startsWith(`${DOES_SOMETHING[label]}(`)) offences.push(`${at}: "${label}" keeps its words only as ${DOES_SOMETHING[label]}()'s action`);
          continue;
        }
        // The event's own entity, whose page ENTITY_PAGES names.
        if (label === 'View in ${entityPage.page}' && url.startsWith('entityUrl(entityPage.type,')) {
          const pages = [...src.matchAll(/type: '[a-z]+',\s+page: '([^']+)'/g)].map((x) => x[1]);
          for (const p of pages) if (!PAGES.has(p)) offences.push(`${file}: ENTITY_PAGES names ${p}, which the rail does not`);
          if (pages.length === 0) offences.push(`${file}: could not read ENTITY_PAGES`);
          continue;
        }
        const name = label.match(/^View in ([A-Z][A-Za-z ]+?)(?: \(\$\{.+\}\))?$/)?.[1];
        if (!name || !PAGES.has(name)) {
          offences.push(`${at}: "${label}" opens a page, so it is named View in <page>, with the page's name in the rail`);
          continue;
        }
        const opens = [...url.matchAll(/\b(\w+Url)\(('([a-z-]+)')?/g)]
          .map(([, fn, , id]) => (fn === 'tabUrl' ? pageById.get(id) : PAGE_OF_URL[fn]));
        if (opens.length === 0 || opens.some((p) => p === undefined)) offences.push(`${at}: "${label}" goes to ${url.trim()}, which this check does not know the page of`);
        else if (opens.some((p) => p !== name)) offences.push(`${at}: "${label}" opens ${[...new Set(opens)].join(' and ')}`);
      }
    }
  }
  if (found < 18) offences.push(`read only ${found} actions that open a page out of the drawers`);

  if (!read('frontend/src/components/tabs/AutomationDetail.jsx').includes('/> View in Audit Trail')) {
    offences.push('frontend/src/components/tabs/AutomationDetail.jsx does not name its link View in Audit Trail, as the drawers do');
  }

  const RETIRED = ['View Audit Trail', 'View History', 'View Their Changes', 'Show Its Devices', 'Open on Cells page',
    'Open on Areas page', 'Open Devices page', 'Open Gateways page', 'View N Devices', '**Open Profile**'];
  for (const file of allFiles.filter((f) => /^(help|docs)\/.+\.md$/.test(f) && f !== 'help/site/upgrading.md').concat('frontend/README.md')) {
    const text = read(file);
    for (const old of RETIRED) if (text.includes(old)) offences.push(`${file} quotes "${old}", which the action is no longer named`);
  }
  if (!read('frontend/README.md').includes('is named `View in <page>`')) offences.push('frontend/README.md does not say an action that opens a page is named `View in <page>`');

  if (offences.length) {
    fail(`A drawer's action that opens a page is named for the page:\n${offences.map((o) => `        ${o}`).join('\n')}`);
  } else {
    pass(`the ${found} drawer actions that open a page of the dashboard are named View in <page>, and the help, the docs and the README quote them so`);
  }
}
