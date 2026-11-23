/**
 * The key in a schema's Submodel id: `<globalAssetId>/submodel/<key>/OperationalTelemetry`. It comes
 * from the schema's lineage, the name its first version was built with, so publishing a version
 * leaves the id where it was and `administration.version` says which edition it is. Pure: no I/O,
 * and nothing here imports shell.ts, which imports this.
 */

/** A schema attached to a device, as far as its key is concerned. */
export interface KeyedSchema {
  /** `schemas.id`. */
  id: string;
  /** `schemas.lineage_root_id`: the first version of the lineage. */
  rootId: string;
  /** The lineage's name as an idShort. */
  rootKey: string;
  version: number;
  status: string;
  /** `device_submodels.submodel_key`, the operator's own key, which is used as it stands. */
  declaredKey: string | null;
}

export interface SubmodelKeys {
  /** The key of each schema, by `schemas.id`. */
  keys: Map<string, string>;
  /** Keys that were already taken and were qualified to stay apart. */
  clashes: number;
}

/** The first eight hex digits of a lineage's root id, which tells two lineages with one name apart. */
export function shortRootId(rootId: string): string {
  const hex = rootId.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return hex.length >= 8 ? hex.slice(0, 8) : (hex || "0").padEnd(8, "0");
}

/**
 * One key for each schema a device carries, unique among them.
 *
 * - A key the operator declared is used as it stands.
 * - Otherwise it is the lineage's name.
 * - Where a device carries two versions of one lineage (a draft beside the version in force), the
 *   one in force keeps the lineage's name, and each other is `<name>_v<version>` until it is
 *   published. With no version in force the highest version keeps it. A draft alone keeps it too.
 * - A key that is still taken, by a declared one or by another lineage with the same name, is
 *   qualified with a short form of its lineage's root id and counted. The order is declared keys
 *   first, then by root id, which a publish never changes, so the same device gets the same keys
 *   until a schema with the same key is attached or detached. Set `submodel_key` to pin one.
 */
export function assignSubmodelKeys(schemas: KeyedSchema[]): SubmodelKeys {
  const byLineage = new Map<string, KeyedSchema[]>();
  for (const schema of schemas) {
    const members = byLineage.get(schema.rootId) ?? [];
    members.push(schema);
    byLineage.set(schema.rootId, members);
  }

  const keeper = new Map<string, string>();
  for (const [rootId, members] of byLineage) {
    const inForce = members.find((m) => m.status === "active");
    const highest = members.reduce((a, b) => (b.version > a.version ? b : a));
    keeper.set(rootId, (inForce ?? highest).id);
  }

  const wanted = (s: KeyedSchema): string => {
    if (s.declaredKey) return s.declaredKey;
    const shared = (byLineage.get(s.rootId)?.length ?? 0) > 1;
    return shared && keeper.get(s.rootId) !== s.id ? `${s.rootKey}_v${s.version}` : s.rootKey;
  };

  const ordered = [...schemas].sort((a, b) =>
    Number(!a.declaredKey) - Number(!b.declaredKey) ||
    (a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0) ||
    Number(keeper.get(b.rootId) === b.id) - Number(keeper.get(a.rootId) === a.id) ||
    a.version - b.version ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  const keys = new Map<string, string>();
  const taken = new Set<string>();
  let clashes = 0;
  for (const schema of ordered) {
    let key = wanted(schema);
    if (taken.has(key)) {
      clashes += 1;
      const base = `${key}_${shortRootId(schema.rootId)}`;
      key = base;
      for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
    }
    taken.add(key);
    keys.set(schema.id, key);
  }
  return { keys, clashes };
}
