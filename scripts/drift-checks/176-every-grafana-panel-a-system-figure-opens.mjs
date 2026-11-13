import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 176. Every Grafana panel a System figure opens is a panel of that dashboard. A tile links to
// `/d/<uid>?viewPanel=<id>` from FIGURE_PANELS in frontend/src/utils/systemFigures.js; a uid or an
// id the provisioned dashboards do not hold opens Grafana on "Dashboard not found" or an empty view.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FIGURES_FILE = 'frontend/src/utils/systemFigures.js';
  const block = read(FIGURES_FILE).match(/export const FIGURE_PANELS = Object\.freeze\(\{([\s\S]*?)\n\}\)/);
  const pairs = block
    ? [...block[1].matchAll(/(\w+):\s*\{\s*uid:\s*'([^']+)',\s*panel:\s*(\d+)\s*\}/g)].map((m) => ({ tile: m[1], uid: m[2], panel: Number(m[3]) }))
    : [];

  // uid -> the ids of every panel, rows' nested panels included.
  const dashboards = new Map();
  const walkPanels = (panels, ids) => {
    for (const p of panels || []) {
      if (Number.isInteger(p.id)) ids.add(p.id);
      walkPanels(p.panels, ids);
    }
    return ids;
  };
  const walkDir = (dir) => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const f = `${dir}/${e.name}`;
      if (e.isDirectory()) walkDir(f);
      else if (e.name.endsWith('.json')) {
        const d = JSON.parse(read(f));
        if (d.uid) dashboards.set(d.uid, { file: f, ids: walkPanels(d.panels, new Set()) });
      }
    }
  };
  walkDir('grafana/provisioning/dashboards');

  if (!pairs.length || !dashboards.size) {
    fail(`could not read FIGURE_PANELS from ${FIGURES_FILE} or any dashboard under grafana/provisioning/dashboards`);
  } else {
    const missing = pairs.filter(({ uid, panel }) => !dashboards.get(uid)?.ids.has(panel));
    if (missing.length) {
      for (const m of missing) {
        fail(
          `${FIGURES_FILE}: the ${m.tile} tile opens panel ${m.panel} of dashboard ${m.uid}, which ` +
            (dashboards.has(m.uid) ? `${dashboards.get(m.uid).file} does not hold` : 'no provisioned dashboard has as its uid') +
            '. Point it at the panel that holds the figure\'s history, or drop the link.'
        );
      }
    } else {
      pass(`all ${pairs.length} System figure link(s) open a panel their dashboard holds`);
    }
  }
}
