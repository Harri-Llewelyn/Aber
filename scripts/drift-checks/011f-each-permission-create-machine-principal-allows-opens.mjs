import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11f. Each permission create_machine_principal() allows opens, for a machine, what the Access
// Control page says it does.
//
// A machine holds permissions through principal_permissions and never a role, so it passes
// has_authority() and never has_role(). MACHINE_REACH names, for each allowed permission, the
// policies and functions it is meant to open, and each must consult it through has_authority() in
// its LAST definition in the chain. "Consulted somewhere" is not enough: `retired_entities` consulted
// audit_trail:read while the trail itself admitted no machine.
//
// telemetry:read and quarantine:view open nothing by design: what they describe is open to every
// authenticated caller. Their entries name those reads and assert both halves of that sentence:
// each read is open to all, and no has_authority() consults the permission. Gating one later
// moves its entry to `gates`.
//
// Two refusal reasons are facts and are held here too: nothing consults link:manage through
// has_authority(), and cell:manage and gateway:manage are consulted only
// where a proposal is decided. So is may_decide_proposal()'s answer: its cell and gateway lanes
// consult the permission, those tables' write policies name a role pair, that pair are the only
// roles granted the permission, and no machine may hold it -- so the lane agrees with the table
// for a person, and no machine reaches it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const chain = readdirSync(join(REPO, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, sql: read(`${dir}/${name}`) }));
  // Applied after the chain by storage-init; a storage policy could consult a permission too.
  const storageSql = { name: 'supabase/storage-policies.sql', sql: read('supabase/storage-policies.sql') };

  const uncommented = (text) => text.replace(/--[^\n]*/g, '');
  const quoted = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // Static patterns only: each has_authority(ARRAY[...]) call, as the permissions it names.
  const consults = (text, perm) =>
    [...uncommented(text).matchAll(/has_authority\(\s*ARRAY\[([^\]]*)\]/g)].some((m) => quoted(m[1]).includes(perm));

  // The last definition of every function, keyed by its signature: replay order makes it the one
  // that runs.
  const functions = new Map();
  for (const { sql } of chain) {
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.([a-z_0-9]+)\s*\(/gi)) {
      const rest = sql.slice(m.index);
      const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
      const end = tag ? rest.indexOf(tag[1], tag.index + tag[0].length) : -1;
      if (end < 0) continue;
      const signature = rest.slice(0, rest.search(/\)\s*RETURNS\b/)).replace(/\s+/g, ' ');
      functions.set(signature, { fn: m[1].toLowerCase(), text: rest.slice(0, end) });
    }
  }
  const definitionsOf = (fn) => [...functions.values()].filter((d) => d.fn === fn);

  // The policy in force: the last CREATE in order, unless a DROP came after it.
  const policiesIn = (sources) => {
    const out = new Map();
    for (const { sql } of sources) {
      const events = [
        ...[...sql.matchAll(/CREATE POLICY\s+"?([a-z_0-9]+)"?\s+ON\s+(?:public|storage)\.([a-z_0-9]+)\b[^;]*;/gi)]
          .map((m) => ({ at: m.index, key: `${m[2]}.${m[1]}`, text: m[0] })),
        ...[...sql.matchAll(/DROP POLICY\s+(?:IF EXISTS\s+)?"?([a-z_0-9]+)"?\s+ON\s+(?:public|storage)\.([a-z_0-9]+)/gi)]
          .map((m) => ({ at: m.index, key: `${m[2]}.${m[1]}`, text: null })),
      ].sort((a, b) => a.at - b.at);
      for (const e of events) {
        if (e.text) out.set(e.key, e);
        else out.delete(e.key);
      }
    }
    return out;
  };
  const policies = policiesIn(chain);
  const everyPolicy = new Map([...policies, ...policiesIn([storageSql])]);

  const consultedBy = (perm) => [
    ...[...functions.values()].filter((d) => consults(d.text, perm)).map((d) => `${d.fn}()`),
    ...[...everyPolicy].filter(([, d]) => consults(d.text, perm)).map(([key]) => `policy ${key}`),
  ];
  const openToAll = (text) => /FOR SELECT\s+TO\s+authenticated\s+USING\s*\(\s*true\s*\)\s*;$/i.test(text);
  const roleArray = (text) => {
    const m = /has_role\(ARRAY\[([^\]]*)\]/.exec(text || '');
    return m ? [...m[1].matchAll(/'(\w+)'/g)].map((r) => r[1]).sort() : null;
  };

  // Who holds each permission, replayed from the seed: grants, less any withdrawal the chain makes.
  const all = chain.map((f) => f.sql).join('\n');
  const roleName = new Map([...all.matchAll(/INSERT INTO public\.roles VALUES \((\d+), '(\w+)'/g)].map((m) => [m[1], m[2]]));
  const permName = new Map(
    [...all.matchAll(/INSERT INTO public\.permissions VALUES \('([0-9a-f-]{36})', '([a-z_]+:[a-z_]+)'/g)].map((m) => [m[1], m[2]])
  );
  const grants = new Set(
    [...all.matchAll(/INSERT INTO public\.role_permissions VALUES \((\d+), '([0-9a-f-]{36})'\)/g)].map((m) => `${m[1]}|${m[2]}`)
  );
  const withdrawals = [...all.matchAll(/DELETE FROM public\.role_permissions\s+WHERE role_id = (\d+)\s+AND permission_id IN \(([^;]*?)\);/g)];
  const unparsed = [...all.matchAll(/DELETE FROM public\.role_permissions/g)].length - withdrawals.length;
  for (const m of withdrawals) for (const u of m[2].matchAll(/'([0-9a-f-]{36})'/g)) grants.delete(`${m[1]}|${u[1]}`);
  const holders = (perm) =>
    [...grants].map((g) => g.split('|')).filter(([, p]) => permName.get(p) === perm).map(([r]) => roleName.get(r)).sort();

  // What each permission a machine may hold is meant to open. `gates` must consult it through
  // has_authority(); `never` must not; `openToAll` must be readable by every authenticated caller;
  // `people` is a policy whose has_role() arm must name exactly the roles holding the permission.
  const MACHINE_REACH = {
    'telemetry:read': {
      openToAll: ['areas.areas_select_authenticated', 'cells.cells_select_authenticated',
        'gateways.gateways_select_authenticated', 'devices.devices_select_authenticated',
        'device_nameplate.device_nameplate_select_authenticated', 'schemas.schemas_select_authenticated',
        'metric_catalog.metric_catalog_select_authenticated'],
      grantedToAll: 'telemetry',
    },
    'quarantine:view': { openToAll: ['devices.devices_select_authenticated'] },
    'audit_trail:read': {
      gates: ['policy audit_trail.audit_trail_select_asset', 'policy retired_entities.retired_entities_select_privileged'],
      never: ['policy audit_trail.audit_trail_select_security'],
      people: 'audit_trail.audit_trail_select_asset',
    },
    'archive:manage': { gates: ['policy retired_entities.retired_entities_select_privileged'] },
    'proposal:create': { gates: ['policy change_proposals.change_proposals_insert_proposer'] },
    'schema:manage': { gates: ['fork_schema()', 'publish_schema_version()', 'discard_schema_draft()'] },
  };

  const [creator] = definitionsOf('create_machine_principal');
  const list = creator && /c_allowed\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/i.exec(creator.text);
  const allowed = list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : null;

  const found = [];
  const bad = (m) => found.push(m);
  const definitionOf = (check) => {
    if (check.startsWith('policy ')) return policies.get(check.slice(7))?.text ?? null;
    const defs = definitionsOf(check.replace(/\(\)$/, ''));
    return defs.length ? defs.map((d) => d.text).join('\n') : null;
  };

  if (!allowed) {
    bad('could not read c_allowed from create_machine_principal(); 11e names the shape it expects');
  } else if (unparsed) {
    bad(`the chain has ${unparsed} DELETE(s) from role_permissions in a shape this check cannot read, so it cannot say who holds a permission`);
  } else {
    for (const perm of allowed) {
      const reach = MACHINE_REACH[perm];
      if (!reach) {
        bad(`create_machine_principal() allows ${perm}, and 11f does not say what it opens for a machine. Name the policy or function it is meant to open.`);
        continue;
      }
      for (const check of reach.gates || []) {
        const text = definitionOf(check);
        if (!text) bad(`${perm} is meant to open ${check}, which no applied migration defines`);
        else if (!consults(text, perm)) bad(`${perm} is meant to open ${check} for a machine, and ${check} does not consult it through has_authority(), so a machine holding it is refused there`);
      }
      for (const check of reach.never || []) {
        const text = definitionOf(check);
        if (text && consults(text, perm)) bad(`${check} consults ${perm} through has_authority(), which opens it to a machine; it is meant to stay closed to machines`);
      }
      for (const key of reach.openToAll || []) {
        const policy = policies.get(key);
        if (!policy || !openToAll(policy.text)) bad(`${perm}'s reach line says a machine reads ${key.split('.')[0]}, which it does only while ${key} is FOR SELECT TO authenticated USING (true); it is now ${policy ? policy.text : 'missing'}`);
      }
      if (reach.grantedToAll) {
        const table = reach.grantedToAll;
        let granted = false;
        for (const m of all.matchAll(/(GRANT|REVOKE)\s+[^;]*?\s+ON\s+TABLE\s+public\.([a-z_0-9]+)\s+(?:TO|FROM)\s+([^;]+);/g)) {
          if (m[2] === table && /\bauthenticated\b/.test(m[3])) granted = m[1] === 'GRANT';
        }
        if (!granted) bad(`${perm}'s reach line says a machine reads ${table}, which authenticated is no longer granted`);
      }
      if (reach.openToAll) {
        const by = consultedBy(perm);
        if (by.length) bad(`${perm} is now consulted through has_authority() by ${by.join(', ')}; name that in 11f's gates, and say on the Access Control page what it opens`);
      }
      if (reach.people) {
        const named = roleArray(policies.get(reach.people)?.text);
        const held = holders(perm);
        if (!named || named.join(',') !== held.join(',')) bad(`${reach.people} admits the roles [${(named || []).join(', ')}] and the seed grants ${perm} to [${held.join(', ')}]; its has_authority() arm changes what a person reads unless the two agree`);
      }
    }
    for (const perm of Object.keys(MACHINE_REACH).filter((p) => !allowed.includes(p))) {
      bad(`11f describes ${perm}, which create_machine_principal() no longer allows; remove the entry`);
    }

    // The refusal reasons that are facts.
    for (const perm of ['link:manage']) {
      const by = consultedBy(perm);
      if (by.length) bad(`create_machine_principal() refuses ${perm} because no check a machine passes consults it, and ${by.join(', ')} now does; decide whether a machine may hold it, and restate the reason`);
    }
    // Each lane of may_decide_proposal() in force, as the predicate and the names it passes.
    const lanes = new Map(
      definitionsOf('may_decide_proposal').flatMap((d) =>
        [...uncommented(d.text).matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+public\.(has_role|has_authority)\(ARRAY\[([^\]]*)\]\)/g)]
          .map((m) => [m[1], `${m[2]}:${quoted(m[3]).join(',')}`]))
    );
    for (const [table, perm, kind] of [['cells', 'cell:manage', 'cell'], ['gateways', 'gateway:manage', 'gateway']]) {
      if (allowed.includes(perm)) {
        bad(`create_machine_principal() allows ${perm}, which lets a machine decide ${kind} proposals through may_decide_proposal(); machines propose, people decide`);
        continue;
      }
      const by = consultedBy(perm).filter((c) => !['approve_proposal()', 'reject_proposal()', 'may_decide_proposal()'].includes(c));
      if (by.length) bad(`create_machine_principal() refuses ${perm} because it would only let a machine decide proposals, and ${by.join(', ')} now consult(s) it too; restate the reason`);
      if (lanes.get(table) !== `has_authority:${perm}`) {
        bad(`may_decide_proposal()'s ${table} lane no longer consults ${perm}; restate the refusal reason in create_machine_principal() and this check`);
      }
      const named = roleArray(policies.get(`${table}.${table}_update_privileged`)?.text);
      const held = holders(perm);
      if (!named || named.join(',') !== held.join(',')) {
        bad(`may_decide_proposal() decides ${kind} proposals on ${perm}, held by [${held.join(', ')}], while ${table}_update_privileged admits [${(named || []).join(', ')}]; a person could apply through the lane what the table refuses them, or the reverse`);
      }
    }
  }

  if (found.length) {
    for (const m of found) fail(m);
    fail(
      'create_machine_principal() allows what a machine may hold, the Access Control page describes\n' +
        '      what each grant reaches, and this check holds the two to the policies and functions that\n' +
        '      decide it. Change them together.'
    );
  } else {
    pass(`each of the ${allowed.length} permissions a machine may hold opens what the page says, and may_decide_proposal()'s cell and gateway lanes agree with their tables for people`);
  }
}
