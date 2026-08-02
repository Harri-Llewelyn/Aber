#!/usr/bin/env node
/**
 * Generate the MTConnect vocabulary migration from the published MTConnect JSON Schema.
 *
 * The vocabulary is large (249 data item types, 123 subtypes, 100 units, 128 components) and is
 * maintained by the MTConnect Institute, not by us. Transcribing it by hand would be both
 * error-prone and unauditable, so the migration is generated and the generator is committed
 * alongside it: to adopt a newer MTConnect release, bump SCHEMA_URL and re-run.
 *
 *   node scripts/generate-mtconnect-vocabulary.mjs
 *
 * Source: https://github.com/mtconnect/schema -- Apache-2.0, which permits redistribution of
 * these values in a derived work. Note this is distinct from the MTConnect *specification*
 * documents, which carry separate terms, and from the Implementer License required to claim
 * MTConnect compliance in a product. Adopting the vocabulary is not a compliance claim.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = '2.8';
const SCHEMA_URL =
  `https://raw.githubusercontent.com/mtconnect/schema/master/MTConnectDevices_${SCHEMA_VERSION}_draft-04.schema.json`;

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'supabase', 'migrations', 'archive', '20260101000018_mtconnect_vocabulary.sql'
);

/** Enum values sometimes carry regex escaping (e.g. "DEGREE/SECOND\\^2"). */
const clean = (value) => value.replace(/\\/g, '');
const sqlString = (value) => `'${clean(value).replace(/'/g, "''")}'`;

/** Enums live inside a `oneOf` wrapper in this schema, not directly on the definition. */
function enumOf(defs, name) {
  const node = defs[name];
  if (!node) throw new Error(`definition not found: ${name}`);
  for (const candidate of [...(node.oneOf ?? []), node]) {
    if (Array.isArray(candidate.enum)) return candidate.enum.map(clean);
  }
  throw new Error(`no enum on definition: ${name}`);
}

/**
 * Structural components are the definitions that can themselves carry DataItems -- that is what
 * makes them a place a metric can live, and therefore a metric-name prefix. `Component` is the
 * abstract base and `Device` is the root rather than a path segment, so neither is a group.
 */
function componentsOf(defs) {
  const excluded = new Set(['Component', 'Device']);
  return Object.entries(defs)
    .filter(([name, node]) =>
      !excluded.has(name) && !name.endsWith('Enum') && JSON.stringify(node).includes('"DataItems"'))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

const response = await fetch(SCHEMA_URL);
if (!response.ok) throw new Error(`fetch failed: ${response.status} ${SCHEMA_URL}`);
const schema = await response.json();
const defs = schema.definitions;

const dataItemTypes = [
  ...enumOf(defs, 'SampleEnum').map(name => [name, 'SAMPLE']),
  ...enumOf(defs, 'EventEnum').map(name => [name, 'EVENT']),
  ...enumOf(defs, 'ConditionEnum').map(name => [name, 'CONDITION'])
].sort((a, b) => a[0].localeCompare(b[0]));

const subTypes = enumOf(defs, 'DataItemSubTypeEnum').sort();
const units = enumOf(defs, 'UnitEnum').sort();
const nativeUnits = enumOf(defs, 'NativeUnitEnum').sort();
const components = componentsOf(defs);

// A type may legitimately appear in more than one category; the primary key would reject the
// duplicate silently under ON CONFLICT, so fail loudly instead of shipping a truncated vocabulary.
const seen = new Set();
for (const [name] of dataItemTypes) {
  if (seen.has(name)) throw new Error(`duplicate data item type across categories: ${name}`);
  seen.add(name);
}

const rows = [
  ...dataItemTypes.map(([name, category]) => `  ('DATA_ITEM_TYPE', ${sqlString(name)}, '${category}')`),
  ...subTypes.map(name => `  ('SUB_TYPE', ${sqlString(name)}, NULL)`),
  ...units.map(name => `  ('UNIT', ${sqlString(name)}, NULL)`),
  ...nativeUnits.filter(n => !units.includes(n)).map(name => `  ('NATIVE_UNIT', ${sqlString(name)}, NULL)`),
  ...components.map(name => `  ('COMPONENT', ${sqlString(name)}, NULL)`)
];

const sql = `-- Migration: 20260101000018_mtconnect_vocabulary.sql
--
-- GENERATED FILE -- do not edit by hand.
-- Regenerate with: node scripts/generate-mtconnect-vocabulary.mjs
-- Source: ${SCHEMA_URL}
--         (mtconnect/schema, Apache-2.0)
--
-- Description: The MTConnect controlled vocabularies, plus the columns on metric_catalog that
-- carry them.
--
-- Why a reference table rather than ${dataItemTypes.length} rows in metric_catalog: an MTConnect data item
-- type is not a metric name. "ANGLE" is a *type*; the metric a device publishes is a component
-- path plus that type -- "Axes/C/ANGLE". Which axes exist is per-device, so the standard cannot
-- enumerate the metrics, only the words they are built from. metric_catalog keeps its meaning
-- ("metrics this deployment's devices actually publish", immutable and append-only) and this table
-- is the vocabulary the Add Metric form composes names from.
--
-- Adopting the vocabulary is not a claim of MTConnect compliance, which requires the MTConnect
-- Implementer License. The Apache-2.0 schema repository is the source of these values.
--
-- What MTConnect does NOT cover, and why some groups are not from it:
--   * OEE. MTConnect deliberately reports raw machine state and leaves KPI computation out, so
--     availability/performance/quality stay on ISO 22400. Note MTConnect's own AVAILABILITY is an
--     EVENT meaning "the device is connected" -- NOT the ISO 22400 availability ratio. Mapping one
--     onto the other would silently corrupt the OEE dashboards.
--   * Units are per data item, chosen by the implementer from UnitEnum; the schema carries no
--     per-type default, so metric_catalog.units is a constrained choice, never auto-derived.

CREATE TABLE IF NOT EXISTS public.mtconnect_vocabulary (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    -- SAMPLE / EVENT / CONDITION, for DATA_ITEM_TYPE rows only.
    category TEXT,
    PRIMARY KEY (kind, name)
);

COMMENT ON TABLE public.mtconnect_vocabulary IS
  'MTConnect controlled vocabularies, generated from the Apache-2.0 mtconnect/schema repository. Reference data, not deployment state.';

ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS units TEXT;
ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS sub_type TEXT;
-- Provenance, so a standard metric is distinguishable from a local extension. MTConnect itself
-- permits extension, so a NULL here is a legitimate state, not a gap to be filled.
ALTER TABLE public.metric_catalog ADD COLUMN IF NOT EXISTS standard TEXT;

-- category is a closed 3-value set; the rest are deliberately unconstrained so a local extension
-- is always possible. Same stance as the separator: the convention is enforced in the form, not
-- in a constraint that would make a legitimate non-standard metric unrecordable.
ALTER TABLE public.metric_catalog DROP CONSTRAINT IF EXISTS metric_catalog_category_valid;
ALTER TABLE public.metric_catalog ADD CONSTRAINT metric_catalog_category_valid
  CHECK (category IS NULL OR category IN ('SAMPLE', 'EVENT', 'CONDITION'));

ALTER TABLE public.metric_groups ADD COLUMN IF NOT EXISTS standard TEXT;

ALTER TABLE public.mtconnect_vocabulary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mtconnect_vocabulary_select_authenticated" ON public.mtconnect_vocabulary;
CREATE POLICY "mtconnect_vocabulary_select_authenticated" ON public.mtconnect_vocabulary
  FOR SELECT TO authenticated USING (true);

-- Reference data maintained by regenerating this migration, never by the application.
REVOKE ALL ON public.mtconnect_vocabulary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mtconnect_vocabulary TO authenticated;

INSERT INTO public.mtconnect_vocabulary (kind, name, category) VALUES
${rows.join(',\n')}
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;

-- Repoint the group vocabulary at MTConnect's component types. The seven hand-picked groups from
-- migration 0017 were a placeholder for exactly this. Environmental and Process are real MTConnect
-- components and survive; OEE is retained under ISO 22400, which is where those KPIs actually come
-- from. The rest are removed only if nothing has used them yet -- a group with metrics behind it
-- has names that are immutable, so it must not be pulled out from under them.
INSERT INTO public.metric_groups (name, description, standard)
SELECT v.name,
       'MTConnect component type',
       'MTConnect'
  FROM public.mtconnect_vocabulary v
 WHERE v.kind = 'COMPONENT'
   AND NOT EXISTS (
     SELECT 1 FROM public.metric_groups g WHERE lower(g.name) = lower(v.name)
   );

-- Groups that already existed under the same name *are* MTConnect components (Environmental and
-- Process both are), so they are relabelled rather than left looking like local inventions. Done
-- as a separate UPDATE because the INSERT above deliberately skips them to preserve their
-- descriptions and any metrics already filed under them.
UPDATE public.metric_groups g SET standard = 'MTConnect'
 WHERE g.standard IS NULL
   AND EXISTS (
     SELECT 1 FROM public.mtconnect_vocabulary v
      WHERE v.kind = 'COMPONENT' AND lower(v.name) = lower(g.name)
   );

UPDATE public.metric_groups SET standard = 'ISO 22400'
 WHERE name = 'OEE' AND standard IS NULL;

DELETE FROM public.metric_groups g
 WHERE g.standard IS NULL
   AND g.name IN ('Robot', 'Safety', 'Diagnostics', 'Energy')
   AND NOT EXISTS (
     SELECT 1 FROM public.metric_catalog c WHERE c.metric_group = g.name
   );

NOTIFY pgrst, 'reload schema';
`;

writeFileSync(OUT, sql, 'utf8');

console.log(`Wrote ${OUT}`);
console.log(`  MTConnect schema ${SCHEMA_VERSION}`);
console.log(`  data item types : ${dataItemTypes.length} ` +
  `(${dataItemTypes.filter(t => t[1] === 'SAMPLE').length} SAMPLE, ` +
  `${dataItemTypes.filter(t => t[1] === 'EVENT').length} EVENT, ` +
  `${dataItemTypes.filter(t => t[1] === 'CONDITION').length} CONDITION)`);
console.log(`  sub types       : ${subTypes.length}`);
console.log(`  units           : ${units.length} (+${nativeUnits.filter(n => !units.includes(n)).length} native-only)`);
console.log(`  components      : ${components.length}`);
console.log(`  total rows      : ${rows.length}`);
