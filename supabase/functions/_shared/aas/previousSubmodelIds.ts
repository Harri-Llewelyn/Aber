/**
 * The Submodel ids a schema's lineage used to have. Until 1.9 a Submodel's key was the name of the
 * schema version that made it, so publishing version 2 moved `.../submodel/Robot_Arm_Schema/...` to
 * `.../submodel/Robot_Arm_Schema_v2/...`. The key is now the lineage's name and stays. aas-api
 * answers the old ids too, with the current Submodel, for one minor release: a consumer that stored
 * one keeps working while it moves to the new id. Files carry only the new id.
 */
import { type BuiltShell, toIdShort } from "./shell.ts";

/** Any Aber client, as shell.ts takes one. */
// deno-lint-ignore no-explicit-any
type Client = any;

const OLD_ID = /^(.*)\/submodel\/([^/]+)\/([A-Za-z]+)$/;

/**
 * The current Submodel that `identifier` named under an earlier version's key, or null when it names
 * none. Only the device's own lineages are asked about: the identifier must belong to this shell,
 * name a lineage it carries by any of that lineage's version names, and name a Submodel that
 * lineage's current version makes.
 */
export async function submodelOfAPreviousVersion(
  client: Client,
  built: BuiltShell,
  identifier: string,
): Promise<Record<string, unknown> | null> {
  const parts = OLD_ID.exec(identifier);
  if (!parts || `${parts[1]}/shell` !== built.shell.id) return null;
  const [, , key, role] = parts;

  const current = built.schemaSubmodels.filter((s) => s.kept && s.ids[role]);
  if (current.length === 0) return null;

  const roots = [...new Set(current.map((s) => s.rootId))];
  const { data, error } = await client
    .from("schemas")
    .select("lineage_root_id, schema_name")
    .in("lineage_root_id", roots);
  if (error) throw new Error(error.message);

  const named = (data ?? []).find((row: { schema_name: string }) =>
    toIdShort(String(row.schema_name || ""), "Submodel") === key
  );
  if (!named) return null;
  const lineage = current.find((s) => s.rootId === named.lineage_root_id);
  if (!lineage) return null;
  return built.submodels.find((s) => s.id === lineage.ids[role]) ?? null;
}
