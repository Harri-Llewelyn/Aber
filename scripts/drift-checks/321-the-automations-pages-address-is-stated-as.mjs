import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 321. The Automations page's address is stated as the code reads it. frontend/README.md's routing
// table names each query key the page reads and its two path forms; the page reads each key through
// the hook that puts it in the address, and routes.js builds the links other pages send there (a
// device's View in Automations, an alert) with the same keys. A key in the table the page does not
// read is a link that opens the unfiltered list.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TAB = 'frontend/src/components/tabs/AutomationsTab.jsx';
  const readme = read('frontend/README.md');
  const tab = read(TAB);
  const routes = read('frontend/src/routes.js');
  const problems321 = [];
  const row = readme.split('\n').find((l) => /^\| Automations \|/.test(l));
  const reads = {
    search: "useUrlState('search'",
    entity: "useUrlState('entity'",
    trigger: "params.get('trigger')",
    sort: 'useSortableRows(',
  };
  if (!row) {
    problems321.push('frontend/README.md has no Automations row in its routing table');
  } else {
    for (const [key, needle] of Object.entries(reads)) {
      if (!row.includes(`\`${key}\``)) problems321.push(`the routing table's Automations row does not name \`${key}\``);
      if (!tab.includes(needle)) problems321.push(`${TAB} does not read \`${key}\` (${needle})`);
    }
    for (const form of ['<id>', 'new']) {
      if (!row.includes(`\`${form}\``)) problems321.push(`the routing table's Automations row does not name the path form \`${form}\``);
    }
  }
  for (const [key, builder] of [['entity', 'automationsForEntityUrl'], ['trigger', 'automationForTriggerUrl']]) {
    if (!new RegExp(`export const ${builder} = \\(\\w+\\) => pageUrl\\('automations', \\{ ${key}: \\w+ \\}\\)`).test(routes)) {
      problems321.push(`routes.js's ${builder}() does not build /automations?${key}=<id> through pageUrl()`);
    }
  }
  if (!/export const automationUrl = \(key\) => \(key === 'new' \? `\/automations\/new\?open=1` : `\/automations\/\$\{encodeURIComponent\(key\)\}`\)/.test(routes)) {
    problems321.push("routes.js's automationUrl() no longer sends an automation whose id is `new` to ?open=1 or the others to /automations/<id>");
  }
  if (!tab.includes("params.has('open')")) problems321.push(`${TAB} does not read ?open=1, which tells an automation called \`new\` from the starter`);
  // New Automation opens the starter, never the address of a saved automation whose id is new.
  if (!/export const newAutomationUrl = \(\) => '\/automations\/new'\n/.test(routes)) {
    problems321.push("routes.js's newAutomationUrl() is no longer /automations/new with no query");
  }
  if (!tab.includes('navigate(newAutomationUrl())')) problems321.push(`${TAB}'s New Automation does not open newAutomationUrl()`);
  if (problems321.length) {
    fail(`the Automations page's address is not stated as the code reads it:\n${problems321.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`frontend/README.md's routing table gives the Automations page's ${Object.keys(reads).length} query keys and 2 path forms, each read by ${TAB}, and routes.js builds the entity, trigger and \`new\` links with them`);
  }
}
