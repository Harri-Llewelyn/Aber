import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 583. Every column of device_nameplate that a person fills in is in each place that lists them: the
// Nameplate dialog's fields, the save's list in api.js, the proposal form, the Approvals page's names, the
// columns a proposal may name, the ones approve_proposal() sets, the AAS exporter and the API reference. A
// column missing from one of them fails nothing: it is a field that saves and is not exported, or a
// proposal that says it was applied and changed nothing.
// -------------------------------------------------------------------------------------------------
const DATABASES_OWN = ['device_id', 'updated_at', 'updated_by'];

export default function check() {
  const problems583 = [];
  const dir = 'supabase/migrations';
  const chain = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((f) => read(`${dir}/${f}`));

  // The columns: the table as 0001 creates it, and what later files add.
  const columns = new Set();
  for (const sql of chain) {
    const created = sql.match(/CREATE TABLE IF NOT EXISTS public\.device_nameplate \(([\s\S]*?)\n\);/)?.[1] ?? '';
    for (const [, name] of created.matchAll(/^ {4}([a-z_]+) (?:uuid|text|date|timestamp)\b/gm)) columns.add(name);
    for (const [, added] of sql.matchAll(/ALTER TABLE public\.device_nameplate\n([\s\S]*?);/g)) {
      for (const [, name] of added.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)) columns.add(name);
    }
  }
  for (const name of DATABASES_OWN) {
    if (!columns.delete(name)) problems583.push(`device_nameplate has no ${name}: this check reads the table wrongly`);
  }

  /** The body of the latest declaration of a function in the chain. */
  const latest = (signature) => {
    let body = '';
    for (const sql of chain) {
      const at = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
      if (at >= 0) body = sql.slice(at, sql.indexOf('\n$$;', at));
    }
    return body;
  };
  const quoted = (text) => new Set([...text.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]));
  const words = (text, pattern) => new Set([...text.matchAll(pattern)].map((m) => m[1]));
  const between = (text, from, to) => {
    const at = text.indexOf(from);
    return at < 0 ? '' : text.slice(at, text.indexOf(to, at));
  };

  const modal = read('frontend/src/components/modals/DeviceNameplateModal.jsx');
  const api = read('frontend/src/api.js');
  const save = api.slice(api.indexOf("* Upsert a device's nameplate."));
  const propose = between(read('frontend/src/utils/proposeFromForm.js'), "kind: 'device_nameplate'", 'withheld');
  const approvals = between(read('frontend/src/components/tabs/ApprovalsTab.jsx'), 'const KEY_LABELS = {', '\n}');
  const lane = between(latest('proposable_columns('), "WHEN 'device_nameplate' THEN ARRAY[", ']');
  const applied = between(latest('approve_proposal('), 'UPDATE public.device_nameplate', 'WHERE device_id');
  const exporter = read('supabase/functions/_shared/aas/shell.ts');
  const reference = between(read('docs/openapi.yaml'), '    DeviceNameplate:\n', '    SparkplugAddress:\n');

  const places = {
    'the Nameplate dialog (FIELDS)': words(between(modal, 'const FIELDS = [', '\n]'), /column: '([a-z_]+)'/g),
    "api.js's nameplate save": quoted(between(save, 'const fields = [', ']')),
    'the proposal form (proposeFromForm.js)': words(propose, /^ {6}([a-z_]+):/gm),
    'the Approvals page (KEY_LABELS)': words(approvals, /^ {2}([a-z_0-9]+):/gm),
    'proposable_columns()': quoted(lane),
    'approve_proposal()': words(applied, /v_plate_new\.([a-z_]+)/g),
    'the AAS exporter (shell.ts)': words(exporter, /nameplate\?\.([a-z_]+)/g),
    'the API reference (DeviceNameplate)': words(reference, /^ {8}([a-z_]+): \{/gm),
  };
  for (const [where, listed] of Object.entries(places)) {
    const lacks = [...columns].filter((c) => !listed.has(c));
    if (lacks.length) problems583.push(`${where} has no ${lacks.join(', ')}`);
  }

  if (problems583.length) {
    fail('a nameplate column is missing from a place that lists them:\n' + problems583.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${columns.size} columns of a nameplate a person fills in are in the ${Object.keys(places).length} places that list them`);
  }
}
