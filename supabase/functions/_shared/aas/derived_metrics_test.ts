/**
 * The derived metrics of a device's shell are the ones its schemas name, a replay lane's being its
 * original's: the AAS exporter's answers to test-harness/fixtures/device-derived-metrics.json, which the
 * database's device_derived_metrics() and the dashboard's derivedMetricsOfDevice() give too.
 */
import { derivedMetricsFor, loadDeviceRecord } from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

interface Rule {
  catalog: Record<string, unknown>[];
  schemas: { key: string; derived_metrics: string[] }[];
  devices: { key: string; shadow_of?: string; schemas: string[]; expected: string[] }[];
}

const RULE: Rule = JSON.parse(
  Deno.readTextFileSync(new URL("../../../../test-harness/fixtures/device-derived-metrics.json", import.meta.url)),
);

const names = (rows: Record<string, unknown>[]) => rows.map((r) => r.name);

Deno.test("every device of the fixture has exactly its derived metrics", () => {
  if (RULE.devices.length <= 5) throw new Error("the fixture holds no devices");
  for (const device of RULE.devices) {
    const owner = device.shadow_of ? RULE.devices.find((d) => d.key === device.shadow_of)! : device;
    const schemas = RULE.schemas.filter((s) => owner.schemas.includes(s.key));
    assert.equal(names(derivedMetricsFor(schemas, RULE.catalog)), device.expected, device.key);
  }
});

Deno.test("a schema row with no list, as an older database answers, names none", () => {
  assert.equal(derivedMetricsFor([{ id: "s1" }, { id: "s2", derived_metrics: null }], RULE.catalog), []);
});

/** A client over one table each, filtered as PostgREST filters. */
function client(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const rows = () =>
        (tables[table] ?? []).filter((row) =>
          filters.every(([column, value]) => Array.isArray(value) ? value.includes(row[column]) : row[column] === value)
        );
      const builder = Object.assign(Promise.resolve().then(() => ({ data: rows(), error: null })), {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push([column, value]), builder),
        in: (column: string, values: unknown[]) => (filters.push([column, values]), builder),
        // deno-lint-ignore no-explicit-any
      }) as any;
      return builder;
    },
  };
}

const tables = {
  devices: [
    { id: "d1", sparkplug_id: "dev1", name: "Press 1", shadow_of: null },
    { id: "lane", sparkplug_id: "dev2", name: "Press 1 (replay)", shadow_of: "d1" },
  ],
  device_schemas: [
    { device_id: "d1", schema_id: "press", submodel_key: null },
    { device_id: "lane", schema_id: "meter", submodel_key: null },
  ],
  schemas: RULE.schemas.map((s) => ({ id: s.key, schema_name: s.key, derived_metrics: s.derived_metrics })),
  metric_catalog: RULE.catalog,
};

Deno.test("the loader reads a replay lane's original's schemas for its derived metrics, and its own for the rest", async () => {
  const lane = await loadDeviceRecord(client(tables), "lane");
  assert.equal(names(lane!.schemas.map((s) => ({ name: s.id }))), ["meter"]);
  assert.equal(
    names(derivedMetricsFor(lane!.derivedSchemas ?? lane!.schemas, RULE.catalog)),
    RULE.devices.find((d) => d.key === "a-lane-has-its-originals")!.expected,
  );
});

Deno.test("the loader reads nothing more for a device that is no lane", async () => {
  const device = await loadDeviceRecord(client(tables), "d1");
  assert.equal(device!.derivedSchemas === undefined, true);
  assert.equal(
    names(derivedMetricsFor(device!.derivedSchemas ?? device!.schemas, RULE.catalog)),
    ["Fixture_0336_D/PARTS_PER_HOUR", "Fixture_0336_D/SCRAP_PER_HOUR"],
  );
});
