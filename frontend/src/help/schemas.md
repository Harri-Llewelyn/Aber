## Summary

A schema says what a class of device is expected to publish: which metrics, of what datatype, meaning what. Assigning one to a device is what turns a list of metric names into something a query, a dashboard or another system can rely on.

## What the controls do

- **Build Schema from Catalog** is the only way to create a schema. Building from the catalog is what guarantees every metric carries a standard and a semantic id, which the device tags, the unmodelled-metric detection and the tag filters all read.
- **The count** beside the title is the number of versions in the chosen status view, and reads `shown / total` while the search narrows it.
- **The Status filter** opens on **Current**, which hides superseded versions; **Active**, **Draft**, **Archived** and **All versions** are the others, each with its count in the option. **Search** matches the name, the UUID and the change description, and **Clear filters** puts both back.
- **The Metrics page** holds the catalog a schema is built from -- every metric this deployment has adopted, searchable. Check there first whether the thing you are about to define already exists under another name.
- **Selecting a row** opens the schema's drawer: its UUID, version, lifecycle, **Change Description**, **Parent Schema** and **Provisioned Devices**. Its actions are **Edit Draft** (for a draft) or **View Schema Detail** (for a published version), **Create Version vN**, **View N Provisioned Device(s)**, **Validate Payload**, which tests a sample payload against the version, and **Download JSON**, which saves the stored definition as a `.schema.json` file.
- **The detail dialog** shows a version's metrics, its **Version History** (the whole lineage, oldest first) and, for a draft, edits. **Save Draft** keeps the edits without activating anything, and the +/- count is measured against the last saved draft. **Publish Version vN** saves any unsaved edits, activates the version, archives its predecessor and moves every device across at once. **Discard Draft** deletes a draft after you type its name, and any devices attached to try it out are detached with it.
- **A version's Change Description** says why it exists. It is optional, entered when the version is created, editable while it is a draft and frozen once published. Publishing itself takes nothing more. Schemas version themselves; an edit does not silently redefine what past readings were validated against.
- **Semantic ID** says which standard Submodel a schema matches, such as an IDTA template, and is shown on every version. A draft inherits its parent's, and can change or clear it before it is published; a published version keeps the one it was published with.
- **Create Version vN** makes **Draft vN** from the current version, as an editable copy that carries every metric it models. Nothing changes for any device until the draft is published. A lineage holds at most one open draft, so it must be published or discarded before another version can be created.
- **Devices** on a schema is the reverse lookup: what currently claims to implement it.

## What the states mean

**Conformance is derived, not stored.** A device is judged against its schema when you look at it, so editing a schema reclassifies its devices immediately rather than at their next birth -- which matters because rebirths are rare by design and can be weeks apart.

A schema whose definition lists no metrics at all is treated as "cannot be evaluated", which is a different answer from "models nothing" -- and the difference is what decides whether its devices are flagged for publishing unmodelled metrics.

Schema UUIDs are minted locally. They are stable and safe to quote inside this stack, but they are not registered identifiers in anyone else's namespace.
