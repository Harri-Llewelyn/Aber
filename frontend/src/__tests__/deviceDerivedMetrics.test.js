import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivedMetricsOfDevice, derivedOffered, derivedProblems, derivedSchemaIds, schemasNaming } from '../utils/derivedMetric'
import { modelledMetrics } from '../utils/deviceTags'
import { deviceMetrics, metricDevices } from '../utils/history'

/**
 * The browser's half of the rule that says which derived metrics a device has, and of what a schema may
 * name: test-harness/fixtures/device-derived-metrics.json, which the db lane gives the same answers to
 * (test_a_device_has_the_derived_metrics_its_schemas_name.py) and the AAS exporter's suite the rule's.
 */

const RULE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'device-derived-metrics.json'), 'utf8'))

const schemas = RULE.schemas.map(s => ({
  schema_uuid: s.key, schema_name: s.key, derived_metrics: s.derived_metrics,
  schema_definition: { type: 'object', properties: Object.fromEntries(s.metrics.map(m => [m, {}])) },
}))

/** The fixture's devices as /api/v1/devices gives them, through the function api.js gives each its ids with. */
const bound = new Map(RULE.devices.map(d => [d.key, d.schemas]))
const devices = RULE.devices.map(d => ({
  asset_id: d.key, asset_name: d.key, last_birth_metrics: d.birth ?? [], submodel_schema_ids: d.schemas,
  derived_schema_ids: derivedSchemaIds({ id: d.key, shadow_of: d.shadow_of ?? null }, bound),
}))

describe('the derived metrics a device has', () => {
  it.each(RULE.devices.map((d, i) => [d.key, devices[i], d.expected]))('%s', (_key, device, expected) => {
    expect(derivedMetricsOfDevice(device, schemas, RULE.catalog)).toEqual(expected)
    // What History, the export dialog and the drawers read: measured and derived, and nothing more derived.
    const names = new Set(deviceMetrics(device, schemas, RULE.catalog))
    expect(RULE.catalog.filter(m => m.derivation && names.has(m.name)).map(m => m.name).sort()).toEqual(expected)
  })

  it('are none of the devices that only report the inputs', () => {
    const { key } = RULE.devices.find(d => d.key === 'reports-every-input-and-no-schema-names-it')
    const device = devices.find(d => d.asset_id === key)
    expect(deviceMetrics(device, schemas, RULE.catalog)).toEqual(['Fixture_0336/PART_COUNT'])
  })

  it('are not asked of a device with no ids of its own to a lane, and a device row without the lane rule has its own', () => {
    expect(derivedMetricsOfDevice({ submodel_schema_ids: ['press'] }, schemas, RULE.catalog)).toHaveLength(2)
    expect(derivedMetricsOfDevice({}, schemas, RULE.catalog)).toEqual([])
    expect(derivedMetricsOfDevice(null, schemas, RULE.catalog)).toEqual([])
  })

  it('leave out a name the catalog does not hold as a derived metric', () => {
    const measured = RULE.catalog.filter(m => !m.derivation)
    expect(derivedMetricsOfDevice({ submodel_schema_ids: ['press'] }, schemas, measured)).toEqual([])
  })

  it('are what the Metric tab compares the devices on, replay lanes left out as ever', () => {
    const inService = devices.map(d => ({ ...d, status: 'ONLINE', location_source: d.asset_id.startsWith('a-lane') ? 'shadow' : 'inherited' }))
    expect(metricDevices(inService, schemas, 'Fixture_0336_D/NET', { catalog: RULE.catalog }).map(d => d.asset_id))
      .toEqual(['several-schemas-have-the-union', 'never-reported-anything'])
  })
})

describe('what a schema may name', () => {
  it.each(RULE.problems.map(c => [c.about, c]))('%s', (_about, c) => {
    const schema = { definition: c.definition, modelled: modelledMetrics({ schema_definition: c.definition }) }
    expect(derivedProblems(schema, c.names, RULE.catalog, c.kept ?? []).map(p => p.problem)).toEqual(c.problems)
    // Offered exactly where it may be saved.
    const offered = derivedOffered(schema, RULE.catalog, c.kept ?? []).map(m => m.name)
    for (const name of c.names) {
      expect(offered.includes(name)).toBe(derivedProblems(schema, [name], RULE.catalog, c.kept ?? []).length === 0)
    }
  })

  it('offers the derived metrics in name order, and no measured one', () => {
    const definition = { properties: Object.fromEntries(RULE.catalog.filter(m => !m.derivation).map(m => [m.name, {}])) }
    expect(derivedOffered({ definition, modelled: modelledMetrics({ schema_definition: definition }) }, RULE.catalog).map(m => m.name))
      .toEqual(['Fixture_0336_D/AUTOMATIC', 'Fixture_0336_D/DOOR_OPEN', 'Fixture_0336_D/NET', 'Fixture_0336_D/PARTS_PER_HOUR', 'Fixture_0336_D/SCRAP_PER_HOUR'])
  })

  it('counts the versions that name one', () => {
    expect(schemasNaming('Fixture_0336_D/PARTS_PER_HOUR', schemas).map(s => s.schema_uuid)).toEqual(['press', 'meter'])
    expect(schemasNaming('Fixture_0336_D/AUTOMATIC', schemas)).toEqual([])
    expect(schemasNaming('Fixture_0336_D/AUTOMATIC', null)).toEqual([])
  })
})
