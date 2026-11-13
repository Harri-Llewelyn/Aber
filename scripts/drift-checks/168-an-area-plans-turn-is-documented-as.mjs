import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 168. An area plan's turn is documented as the code holds it. The API reference gives
// areas.plan_rotation the turns and the default 0221 states, on Area and on AreaWrite. The Areas
// help names Turn left and Turn right as the panel labels them, and says Replace plan keeps the
// turn and Remove plan removes it, which holds while uploadAreaPlan() writes no plan_rotation and
// removeAreaPlan() writes 0.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const MIGRATION = 'supabase/migrations/0221_an_area_plan_can_be_turned.sql';
  const PANEL = 'frontend/src/components/common/AreaPlanPanel.jsx';
  const HELP = 'help/pages/areas.md';
  const offences = [];

  const migration = read(MIGRATION);
  const turns = /ADD CONSTRAINT areas_plan_rotation_quarter_turn CHECK \(\(plan_rotation = ANY \(ARRAY\[([^\]]+)\]\)\)\)/.exec(migration);
  const fallback = /ADD COLUMN IF NOT EXISTS plan_rotation smallint DEFAULT (\d+) NOT NULL/.exec(migration);
  if (!turns || !fallback) offences.push(`${MIGRATION} no longer states the CHECK's turns or the column's default where this check reads them`);
  const list = (text) => text.split(',').map((t) => t.trim()).join(', ');

  const spec = read('docs/openapi.yaml');
  // A component schema's body: the lines after its 4-space key, up to the next 4-space key.
  const components = {
    Area: spec.match(/^ {4}Area:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
    AreaWrite: spec.match(/^ {4}AreaWrite:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
  };
  for (const [name, body] of Object.entries(components)) {
    const entry = body && /^ {8}plan_rotation: \{ type: integer, enum: \[([^\]]+)\](?:, default: (\d+))?/m.exec(body);
    if (body === null) offences.push(`docs/openapi.yaml has no ${name} schema`);
    else if (!entry) offences.push(`docs/openapi.yaml's ${name} does not document plan_rotation as an integer enum`);
    else if (turns && list(entry[1]) !== list(turns[1])) offences.push(`docs/openapi.yaml's ${name}.plan_rotation lists [${entry[1]}], and the CHECK admits [${turns[1]}]`);
    else if (name === 'Area' && fallback && entry[2] !== fallback[1]) offences.push(`docs/openapi.yaml's Area.plan_rotation defaults to ${entry[2] ?? 'nothing'}, and the column to ${fallback[1]}`);
  }

  const panel = read(PANEL);
  const help = read(HELP);
  for (const label of ['Turn left', 'Turn right']) {
    if (!panel.includes(`/> ${label}\n`)) offences.push(`${PANEL} has no button labelled ${label}`);
    if (!help.includes(`**${label}**`)) offences.push(`${HELP} does not name **${label}**`);
  }
  if (!help.includes('**Replace plan** keeps the turn') || !help.includes('**Remove plan** removes the turn')) {
    offences.push(`${HELP} no longer says Replace plan keeps the turn and Remove plan removes it`);
  }
  const api = read('frontend/src/api.js');
  const upload = /uploadAreaPlan: async[\s\S]*?\.update\(([^)]*)\)/.exec(api);
  const remove = /removeAreaPlan: async[\s\S]*?\.update\(([^)]*)\)/.exec(api);
  if (!upload || /plan_rotation/.test(upload[1])) offences.push("frontend/src/api.js's uploadAreaPlan() writes plan_rotation, or no longer writes the row where this check reads it");
  if (!remove || !/plan_rotation: 0\b/.test(remove[1])) offences.push("frontend/src/api.js's removeAreaPlan() does not write plan_rotation: 0");

  if (offences.length) {
    fail(`An area plan's turn is documented as the code holds it (0221):\n  ${offences.join('\n  ')}`);
  } else {
    pass(`An area plan's turn is documented as the code holds it: the API reference lists the CHECK's turns and the column's default, and the Areas help names the panel's buttons and what Replace and Remove do to the turn`);
  }
}
