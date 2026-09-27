## Summary

A schema says what a class of device is expected to publish: which metrics, of what datatype, meaning what. Assigning one to a device is what turns a list of metric names into something a query, a dashboard or another system can rely on.

## What the controls do

- **Build Schema from Catalog** is the only way to create a schema. Building from the catalog is what guarantees every metric carries a standard and a semantic id, which the device tags, the unmodelled-metric detection and the tag filters all read.
- **The Metrics page** holds the catalog a schema is built from -- every metric this deployment has adopted, searchable. Check there first whether the thing you are about to define already exists under another name.
- **Publishing a version** takes a **Change Description**. Schemas version themselves; an edit does not silently redefine what past readings were validated against.
- **Semantic ID** says which standard Submodel a schema matches, such as an IDTA template, and is shown on every version. A draft inherits its parent's, and can change or clear it before it is published; a published version keeps the one it was published with.
- **Fork** cuts the next version as an editable draft. A lineage holds at most one open draft, so it must be published or discarded before another can be cut.
- **Devices** on a schema is the reverse lookup: what currently claims to implement it.

## What the states mean

**Conformance is derived, not stored.** A device is judged against its schema when you look at it, so editing a schema reclassifies its devices immediately rather than at their next birth -- which matters because rebirths are rare by design and can be weeks apart.

A schema whose definition lists no metrics at all is treated as "cannot be evaluated", which is a different answer from "models nothing" -- and the difference is what decides whether its devices are flagged for publishing unmodelled metrics.

Schema UUIDs are minted locally. They are stable and safe to quote inside this stack, but they are not registered identifiers in anyone else's namespace.
