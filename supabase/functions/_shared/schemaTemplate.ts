/**
 * The semantic ids a metric's Property carries in the submodel of one schema version (0342). In a version
 * built from a submodel template, `schemas.template_elements` names the element each metric fills, and the
 * element's id is the Property's `semanticId`: the metric's own id and its further ids are its
 * `supplementalSemanticIds`. In any other version the metric's own id is the `semanticId` and its further
 * ids are supplemental, as they were. Decided in #481.
 *
 * Pure, with no import, so the AAS exporter and its tests read one rule.
 */

/** The rows of `schemas` this reads: PostgREST's, as the exporter's loader returns them. */
export type SchemaRow = Record<string, unknown> | null | undefined;

/** The id of the element a metric fills in a version built from a template, or null. */
export function filledElementId(schema: SchemaRow, metricName: string): string | null {
  if (!schema?.template_id) return null;
  const elements = schema.template_elements;
  if (!elements || typeof elements !== "object" || Array.isArray(elements)) return null;
  const entry = (elements as Record<string, unknown>)[metricName];
  if (!entry || typeof entry !== "object") return null;
  const id = (entry as Record<string, unknown>).semantic_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * A metric's ids in one version's submodel: the primary one, and the supplemental ones sorted and each once,
 * never the primary, or undefined when there are none (the list is `minItems: 1`).
 */
export function templateSemanticIds(
  schema: SchemaRow,
  metricName: string,
  ownId: string | null | undefined,
  furtherIds: readonly string[] | null | undefined,
): { semanticId: string | null; supplementalSemanticIds: string[] | undefined } {
  const element = filledElementId(schema, metricName);
  const semanticId = element ?? ownId ?? null;
  const rest = [...(element ? [ownId] : []), ...(furtherIds ?? [])]
    .filter((id): id is string => typeof id === "string" && id !== "" && id !== semanticId);
  const distinct = [...new Set(rest)].sort();
  return { semanticId, supplementalSemanticIds: distinct.length > 0 ? distinct : undefined };
}

/**
 * The ids of the elements the metrics of these versions fill, sorted and each once: a shell references
 * them, so the loader reads their definitions too.
 */
export function templateElementIds(schemas: readonly SchemaRow[]): string[] {
  const ids = new Set<string>();
  for (const schema of schemas) {
    const elements = schema?.template_id ? schema.template_elements : null;
    if (!elements || typeof elements !== "object" || Array.isArray(elements)) continue;
    for (const name of Object.keys(elements)) {
      const id = filledElementId(schema, name);
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}
