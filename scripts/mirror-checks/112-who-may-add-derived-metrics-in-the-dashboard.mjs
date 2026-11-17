import { compare, lastDefinition, need, ok, problems, read, SCHEMA } from './lib.mjs';

// 112. Who may add a document of derived metrics, in the dashboard and in the database (0297). Add
// Derived Metric writes a catalogue row, which the insert policy admits for an Administrator behind the
// second factor; apply_derived_metrics() asks for the same, and so does a seed that gives the page's
// permission to that role alone. It also sets a description, which the update policy admits for the same
// role and the same factor, so the function never writes what the table would refuse its caller. The page greys Upload, New in YAML and Add Derived Metric by the one
// permission. A page that offers Upload to a role the function refuses is a button that errors on every
// click, and one that withholds it from a role the function admits is a control nobody can reach.
export default function check() {
  const before = problems.length;
  const roles = (source, what) => [...(need(source, /has_role\(ARRAY\[([^\]]*)\]/, what)?.[1].matchAll(/'([A-Za-z_]+)'/g) ?? [])].map((m) => m[1]).join(', ');
  const apply = lastDefinition('CREATE OR REPLACE FUNCTION public.apply_derived_metrics(', '$$;', 'apply_derived_metrics()');
  const policy = SCHEMA.split('\n').filter((line) => line.startsWith('CREATE POLICY metric_catalog_insert_privileged ON public.metric_catalog')).pop();
  const updatePolicy = SCHEMA.split('\n').filter((line) => line.startsWith('CREATE POLICY metric_catalog_update_privileged ON public.metric_catalog')).pop();
  if (apply && policy && updatePolicy) {
    compare('derivedMetricsWriters', `the roles apply_derived_metrics() (${apply.file}) and the catalogue's insert policy ask for`,
      roles(apply.body, `apply_derived_metrics()'s has_role() list (${apply.file})`), roles(policy, "the catalogue's insert policy"));
    if (!apply.body.includes('PERFORM public.require_mfa();')) problems.push(`derivedMetricsWriters: apply_derived_metrics() (${apply.file}) does not call require_mfa(), which the catalogue's insert policy does`);
    if (!policy.includes('require_mfa()')) problems.push("derivedMetricsWriters: the catalogue's insert policy no longer asks for the second factor, which apply_derived_metrics() does");
    compare('derivedMetricsWriters', `the roles the catalogue's update policy and apply_derived_metrics() (${apply.file}), which changes a description, ask for`,
      roles(updatePolicy, "the catalogue's update policy"), roles(apply.body, `apply_derived_metrics()'s has_role() list (${apply.file})`));
    if (!updatePolicy.includes('require_mfa()')) problems.push("derivedMetricsWriters: the catalogue's update policy no longer asks for the second factor, which apply_derived_metrics() does");
  } else {
    problems.push("derivedMetricsWriters: could not find the catalogue's insert and update policies metric_catalog_insert_privileged and metric_catalog_update_privileged -- the file's shape changed, so this check is no longer checking anything");
  }

  // The page: all three buttons are permitted by the permission the schema builder's controls are, and
  // that permission's id in constants.js is the one the seed gives schema:manage, to the Administrator alone.
  const tab = read('frontend/src/components/tabs/MetricsTab.jsx');
  const canManage = need(tab, /const canManageSchema = hasPermission\(PERMISSION_UUIDS\.(\w+)\)/, 'canManageSchema in MetricsTab.jsx');
  const buttons = ['Upload', 'New in YAML', 'Add Derived Metric'];
  const chunks = tab.split('<ActionButton');
  for (const label of buttons) {
    const button = chunks.find((chunk) => chunk.includes(`/> ${label}\n`));
    if (!button) problems.push(`derivedMetricsWriters: could not find the ${label} button of MetricsTab.jsx -- the file's shape changed, so this check is no longer checking anything`);
    else if (!button.includes('permitted={canManageSchema}')) problems.push(`derivedMetricsWriters: the ${label} button of MetricsTab.jsx is not permitted by canManageSchema, as the others of the Derived tab are`);
  }
  const constants = read('frontend/src/constants.js');
  const uuid = canManage && need(constants.split('\n').find((line) => line.trim().startsWith(`${canManage[1]}:`)) ?? '', /'([0-9a-f-]{36})'/,
    `${canManage[1]} in constants.js`);
  const seeded = uuid && need(SCHEMA.split('\n').find((line) => line.startsWith(`INSERT INTO public.permissions VALUES ('${uuid[1]}',`)) ?? '', /', '([a-z:_]+)'/,
    `the seed's permission ${uuid[1]}`);
  const holders = uuid && SCHEMA.split('\n')
    .filter((line) => line.startsWith('INSERT INTO public.role_permissions VALUES (') && line.includes(`, '${uuid[1]}')`))
    .map((line) => line.match(/VALUES \((\d+),/)?.[1]);
  const names = new Map([...SCHEMA.matchAll(/INSERT INTO public\.roles VALUES \((\d+), '([A-Za-z_]+)'/g)].map((m) => [m[1], m[2]]));
  if (apply && seeded && holders) {
    compare('derivedMetricsWriters', `the roles that hold the permission the Derived tab greys its buttons by (${canManage[1]}, ${seeded[1]}) and the roles apply_derived_metrics() asks for (${apply.file})`,
      holders.map((id) => names.get(id)).sort().join(', '), roles(apply.body, 'apply_derived_metrics()').split(', ').sort().join(', '));
  }
  if (problems.length === before) ok.push('derivedMetricsWriters: Upload, New in YAML and Add Derived Metric are greyed for every role the catalogue\'s insert policy and apply_derived_metrics() refuse');
}
