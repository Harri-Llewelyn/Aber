import { compare, lastDefinition, need, ok, problems, read, SCHEMA } from './lib.mjs';

// 108. Who may apply a document of device schemas, in the dashboard and in the database (0295). The
// Schemas page greys Upload for anyone without the schema:manage permission; apply_device_schemas()
// asks for the permission fork_schema() asks for, which is what versioning a schema in the builder
// asks, and then for the second factor. A page that offers Upload to a role the function refuses is a
// button that errors on every click, and one that withholds it from a role the function admits is a
// control nobody can reach.
export default function check() {
  const before = problems.length;
  const permissions = (source, what) => [...(need(source, /has_authority\(ARRAY\[([^\]]*)\]\)/, what)?.[1].matchAll(/'([a-z:_]+)'/g) ?? [])]
    .map((m) => m[1]).join(', ');
  const apply = lastDefinition('CREATE OR REPLACE FUNCTION public.apply_device_schemas(', '$$;', 'apply_device_schemas()');
  const fork = lastDefinition('CREATE OR REPLACE FUNCTION public.fork_schema(', '$$;', 'fork_schema()');
  if (apply && fork) {
    compare('deviceSchemasWriters', `the permission apply_device_schemas() (${apply.file}) and fork_schema() (${fork.file}) ask for`,
      permissions(apply.body, `apply_device_schemas()'s has_authority() list (${apply.file})`),
      permissions(fork.body, `fork_schema()'s has_authority() list (${fork.file})`));
    for (const [name, fn] of [['apply_device_schemas', apply], ['fork_schema', fork]]) {
      if (!fn.body.includes('PERFORM public.require_mfa();')) {
        problems.push(`deviceSchemasWriters: ${name}() (${fn.file}) does not call require_mfa()`);
      }
    }
    if (!apply.body.includes('public.is_machine_principal(v_uid)')) {
      problems.push(`deviceSchemasWriters: apply_device_schemas() (${apply.file}) no longer refuses a machine identity, which the schemas table's insert policy does`);
    }
  }
  // The page: Upload is permitted by the permission the schema builder's controls are, and the
  // permission's id in constants.js is the one the seed gives schema:manage.
  const tab = read('frontend/src/components/tabs/SchemasTab.jsx');
  const canManage = need(tab, /const canManageSchema = hasPermission\(PERMISSION_UUIDS\.(\w+)\)/, 'canManageSchema in SchemasTab.jsx');
  const upload = need(tab, /permitted=\{canManageSchema\}[^>]*\n(?:[^\n]*\n){0,4}?[^\n]*<IconUpload/,
    'the Upload button of SchemasTab.jsx, permitted by canManageSchema');
  const constants = read('frontend/src/constants.js');
  const uuid = canManage && need(constants.split('\n').find((line) => line.trim().startsWith(`${canManage[1]}:`)) ?? '', /'([0-9a-f-]{36})'/,
    `${canManage[1]} in constants.js`);
  const seeded = uuid && need(SCHEMA.split('\n').find((line) => line.startsWith(`INSERT INTO public.permissions VALUES ('${uuid[1]}',`)) ?? '', /', '([a-z:_]+)'/,
    `the seed's permission ${uuid[1]}`);
  if (apply && seeded) {
    compare('deviceSchemasWriters', `the permission the Schemas page greys Upload by (${canManage[1]}) and the one apply_device_schemas() asks for (${apply.file})`,
      seeded[1], permissions(apply.body, 'apply_device_schemas()'));
  }
  if (problems.length === before && upload) ok.push('deviceSchemasWriters: Upload is greyed for a role without the permission apply_device_schemas() asks for');
}
