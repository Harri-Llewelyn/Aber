import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, gitignored, isDriftCheck, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 19c. A name the platform retired does not come back.
//
// Every rename left the old name behind somewhere, and after 1.0 an identifier that survives the
// release stays for good. RETIRED is one line a name: an example of the old name, the pattern that
// finds it, and what it is now. KEPT is where an old name stays on purpose -- the code that moves
// it, the tests that plant it, and history -- each with its reason.
//
// A KEPT phrase exempts the paragraph that holds it (the lines between blank lines, or one list
// item), not the file, so a stale use elsewhere in the same file is still caught. A KEPT entry
// that exempts nothing fails, so the list shrinks with the tree. A gitignored file is not read,
// and a migration filename is not scanned: it records what the change was.
// -------------------------------------------------------------------------------------------------
export default function check() {
  /** [an example of the old name, the pattern that finds it, what it is now]. */
  const RETIRED = [
    ['supabase-kong', /\bsupabase-kong\b(?!-init)/, 'supabase-envoy'],
    ['supabaseEnvoy.serviceName', /\bsupabaseEnvoy\.serviceName\b/, 'nothing: the Service is always supabase-envoy'],
    ['the Overview page', /\bOverviewTab\b|\bthe Overview\b|\bOverview (?:page|map|card|tab)\b|tab id `overview`/, 'the Site Map'],
    ['floor-plans', /\bfloor-plans\b/, 'area-plans'],
    ['floor_plans_read_authenticated', /\bfloor_plans_/, 'area_plans_*'],
    ['is_floor_plan_path', /\bis_floor_plan_path\b/, 'is_area_plan_path'],
    ['uploadFloorPlan', /FloorPlan|floorPlan|FLOOR_PLAN|FloorPlacement/, 'AreaPlan, areaPlan, AREA_PLAN, CellPlacement'],
    ['.floor-pin-label', /\bfloor-(?:plan|pin|placement)\b/, '.area-plan…'],
    ['a floor plan', /\bfloor plans?\b/i, 'an area plan'],
    ['ACS-Cymru', /acs[-_ ]?cymru/i, 'Aber'],
    // An escaped `\n` is a boundary too: JSON-encoded text, such as a flow's notes, has no space there.
    ['acs/flow-shape', /(?<=^|[^\w-]|\\n)(?:acs[-_/.]|ACS_|X-ACS-)\w[\w./-]*|(?<=-n )acs\b/, 'aber…'],
    ['factoryplus_ingestion', /\bfactoryplus_(?:ingestion|i3x|monitor)\b/, 'aber_ingestion, aber_i3x, aber_monitor'],
    ['.factoryplus-seeded', /\.factoryplus-(?:seeded|editor-users)/, '.aber-seeded, .aber-editor-users.json'],
    ['factoryplus-tls-config', /\bfactoryplus-tls-config\b/, 'aber-tls-config'],
    ['acsCredentialsEnv', /\bacsCredentialsEnv\b/, 'aberCredentialsEnv'],
    ['supabase_anon_key', /\bsupabase_anon_key\b/, 'supabase_publishable_key'],
    ['nodered_admin_token', /\bnodered_admin_token\b/, 'nothing: Node-RED reads NODERED_ADMIN_TOKEN from its environment'],
    ['Node-RED (Virtual Edge Gateway Simulator)', /\b(?:virtual edge )?gateway simulator\b/i, 'Node-RED (Host-Run Gateways)'],
    ['the demo simulator', /\bdemo(?:nstration)? simulator\b|\bsimulated shopfloor\b/i, 'nothing: no demonstration ships'],
    ['the Digital Thread', /digital[_ -]?thread/i, 'the Audit Trail: audit_trail, audit-trail, AuditTrail, AUDIT_TRAIL'],
    // A class, custom property or fixture id, not the <dt> element, a `dt {` selector or a word such as qudt-all.
    ['.dt-lane', /(?<![\w-])(?:--|\.)?dt-[a-z0-9]/, 'trail-: .trail-lane, --trail-label-width, \'trail-1\''],
    ['applied_thread_id', /\b(?:applied_)?thread_(?:id|rows)\b|MAX_THREAD_ROWS|\b(?:onView|onSelect|load|canRead)Thread\b|\bviewThreadFor\b/,
      'applied_trail_id, trail_id, trail_rows, MAX_TRAIL_ROWS, onViewTrail, loadTrail'],
  ];

  /** Text next to those names that is still right, and which no pattern may flag. */
  const STILL_RIGHT = [
    'the scheduling floor and the upgrade floor',
    'A building with two floors is two areas; an overview of the chart',
    '`factoryplus_payload_uuid` and the Factory+ payload marker',
    'SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are the tokens the upstream images read',
    'a simulated gateway beside a host-run one, inspired by the AMRC Connectivity Stack (ACS)',
    'supabase-envoy, area-plans, aber-tls-config, aber/flow-shape, dacs-1 and MACS_ADDR',
    'the writer thread, threading.Thread and daemon_threads beside the audit trail and audit_trail',
  ];

  /** [file or directory/, the phrase marking the paragraph kept (null: the whole file), why]. */
  const KEPT = [
    ['supabase/migrations/archive/', null, 'never executed: the record of what each archived migration did'],
    ['docs/incidents.md', null, 'names what each incident happened to'],
    ['.gitleaksignore', null, 'its fingerprints name historical paths and must match them exactly'],
    ['ingestion/README.md', "ACS's `acs-edge`", 'names the upstream ACS component'],
    ['test-harness/load_generator.py', 'NOT the demonstration simulator', 'says what the load generator is not'],
    ['test-harness/README.md', 'Not the demonstration simulator', 'says what the load generator is not'],
    ['deploy/helm/aber/values.yaml', 'The demonstration simulator was removed', 'history, beside the value it explains'],
    ['docs/gateway.md', "Envoy kept the Kong Service's name", "the gateway's History"],
  ];

  const MIGRATION_FILENAME = /\b(?:\d{4}|\d{14})_\w+\.sql\b/g;
  const matches = (marker, line) => (typeof marker === 'string' ? line.includes(marker) : marker.test(line));
  const covers = (path, file) => (path.endsWith('/') ? file.startsWith(path) : file === path);
  /** [start, end) of each paragraph: split at blank lines and at each list item. */
  const paragraphs = (lines) => {
    const out = [];
    let start = null;
    lines.forEach((line, i) => {
      const blank = !line.trim();
      if (start !== null && (blank || /^\s*(?:[-*+]|\d+\.)\s/.test(line))) { out.push([start, i]); start = null; }
      if (!blank && start === null) start = i;
    });
    if (start !== null) out.push([start, lines.length]);
    return out;
  };

  const broken = [
    ...RETIRED.filter(([was, pattern]) => !pattern.test(was)).map(([was]) => `the pattern for "${was}" no longer finds it`),
    ...STILL_RIGHT.flatMap((text) => RETIRED.filter(([, pattern]) => pattern.test(text)).map(([was]) => `the pattern for "${was}" flags "${text}"`)),
    ...KEPT.flatMap(([paths]) => [paths].flat().filter((p) => !existsSync(join(REPO, p))).map((p) => `KEPT names ${p}, which is not in the tree`)),
  ];

  const offences = [];
  const used = new Set();   // `${entry}:${marker}:${path}` for every KEPT marker that exempted a mention
  const scanned = allFiles.filter(
    (f) =>
      !isDriftCheck(f) &&
      !gitignored(f) &&
      !f.startsWith('frontend/dist/') &&
      !f.startsWith('.claude/') &&
      !f.startsWith('backups/') &&
      !/(^|\/)(?:package-lock\.json|deno\.lock)$/.test(f) &&
      !/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|zip|gz|pdf|glb)$/i.test(f)
  );
  for (const file of scanned) {
    let text;
    try { text = read(file); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    const found = lines.map((line) => {
      const bare = line.replace(MIGRATION_FILENAME, '');
      return RETIRED.map(([, pattern, now]) => [bare.match(pattern)?.[0], now]).filter(([hit]) => hit);
    });
    if (!found.some((hits) => hits.length)) continue;

    const keptBy = lines.map(() => []);
    KEPT.forEach(([paths, marker], entry) => {
      for (const path of [paths].flat().filter((p) => covers(p, file))) {
        if (marker === null) { lines.forEach((_, i) => keptBy[i].push(`${entry}:0:${path}`)); continue; }
        const markers = Array.isArray(marker) ? marker : [marker];
        for (const [start, end] of paragraphs(lines)) {
          markers.forEach((m, n) => {
            if (!lines.slice(start, end).some((line) => matches(m, line))) return;
            for (let i = start; i < end; i += 1) keptBy[i].push(`${entry}:${n}:${path}`);
          });
        }
      }
    });

    found.forEach((hits, i) => {
      if (!hits.length) return;
      if (keptBy[i].length) { keptBy[i].forEach((k) => used.add(k)); return; }
      for (const [hit, now] of hits) offences.push(`${file}:${i + 1} "${hit}" is ${now}: ${lines[i].trim().slice(0, 80)}`);
    });
  }

  KEPT.forEach(([paths, marker, why], entry) => {
    const markers = marker === null ? [null] : Array.isArray(marker) ? marker : [marker];
    for (const path of [paths].flat()) {
      markers.forEach((m, n) => {
        if (!used.has(`${entry}:${n}:${path}`)) {
          broken.push(`KEPT ${path}${m === null ? '' : ` "${m}"`} (${why}) exempts no retired name any more; remove it`);
        }
      });
    }
  });

  if (broken.length) {
    fail('check 19c cannot be trusted as written:\n' + broken.map((b) => `        ${b}`).join('\n'));
  }
  if (offences.length) {
    fail(
      'a retired name is back:\n' +
        offences.map((o) => `        ${o}`).join('\n') +
        '\n        (a deliberate mention goes in check 19c\'s KEPT, with its reason)'
    );
  } else if (!broken.length) {
    pass(`no retired name is back (${RETIRED.length} names, ${KEPT.length} kept on purpose, ${scanned.length} files scanned)`);
  }
}
