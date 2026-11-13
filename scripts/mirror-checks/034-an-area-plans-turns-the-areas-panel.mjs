import { compare, need, problems, read, SCHEMA } from './lib.mjs';

// 34. An area plan's turns. The Areas panel turns a plan by the quarter turns PLAN_ROTATIONS lists
// (utils/areaPlans.js), and 0221's CHECK admits the turns the column may hold. A turn only the
// dashboard offers is a button the database refuses; one only the CHECK admits is a row a client
// wrote that the dashboard draws unturned. planRotation() falls back to the column's default.
export default function check() {
  const ui = read('frontend/src/utils/areaPlans.js');
  const uiTurns = need(ui, /^export const PLAN_ROTATIONS = \[([^\]]+)\]$/m, 'PLAN_ROTATIONS in frontend/src/utils/areaPlans.js');
  const uiFallback = need(ui, /return PLAN_ROTATIONS\.includes\(turn\) \? turn : (\d+)$/m, "planRotation()'s fallback in frontend/src/utils/areaPlans.js");
  const checks = [...SCHEMA.matchAll(/ADD CONSTRAINT areas_plan_rotation_quarter_turn CHECK \(\(plan_rotation = ANY \(ARRAY\[([^\]]+)\]\)\)\)/g)];
  const column = [...SCHEMA.matchAll(/ADD COLUMN IF NOT EXISTS plan_rotation smallint DEFAULT (\d+) NOT NULL/g)];
  if (!checks.length) problems.push('could not find areas_plan_rotation_quarter_turn in the applied chain — the file\'s shape changed, so this check is no longer checking anything');
  if (!column.length) problems.push('could not find areas.plan_rotation\'s ADD COLUMN in the applied chain — the file\'s shape changed, so this check is no longer checking anything');
  const list = (text) => text.split(',').map((t) => Number(t.trim())).sort((a, b) => a - b).join(',');

  if (uiTurns && checks.length) compare('planRotation', 'turns the panel offers and the CHECK admits', list(uiTurns[1]), list(checks.at(-1)[1]));
  if (uiFallback && column.length) compare('planRotation', "turn the dashboard draws for an unknown value and the column's default", uiFallback[1], column.at(-1)[1]);
}
