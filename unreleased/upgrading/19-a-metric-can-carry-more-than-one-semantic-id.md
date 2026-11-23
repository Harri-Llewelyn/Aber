### From 1.9.0, a metric can carry more than one semantic id

From 1.9.0, a metric can carry further semantic ids beside its own. The upgrade adds a table and a view and
changes no row. There is nothing to run, and nothing changes in an export until an Administrator adds one.

- **In the dashboard,** **Edit** on the Metrics page lists a metric's **Further Semantic IDs**. Add one when a
  submodel template names a quantity by an id other than the one the metric was named from. The metric keeps its
  own id.
- **In an AAS export,** a metric with further ids has them as `supplementalSemanticIds` on its Property, beside
  its `semanticId`, and a ConceptDescription for each. A metric with none exports as before. A consumer that
  matches on `semanticId` alone sees what it saw.
- **The Digital Nameplate** is also filled from a metric that carries one of its six OPC 40001 Machinery ids as
  a further id. A metric that carries the id as its own still answers first.
- **`metric_catalog.semantic_id` keeps its meaning.** The REST API, i3X and the device-schema documents read the
  metric's own id, as before.
- **A script that edits the catalogue** finds new routes: `/rest/v1/metric_semantic_ids` to read and write the
  further ids, and `/rest/v1/metric_semantic_id_crosswalk` to ask which metric carries an id, own or further. A
  metric carries at most 10, none equal to its own id. Clearing the own id of a metric that carries further ids is
  now refused, and says to remove them first. So is changing its own id to one of its further ids.
- **A script that reads the Audit Trail** finds a new `entity_type`, `metric_semantic_ids`, in the asset lane.
  Its rows are filed under the metric's id, so they appear with the metric's own history.
- **An edge function deployed before the database** still builds a shell, without the further ids.
