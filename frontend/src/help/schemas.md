## What this page is for

A schema says what a kind of device is expected to publish: which metrics, of what datatype, and what they mean. This page is where you build schemas, version them and publish them. Assigning a schema to a device turns its list of metric names into something a query, a dashboard or another system can rely on.

## What the controls do

- **Build Schema from Catalog** is the only way to create a schema. Building from the catalog makes sure every metric carries a standard and a semantic id. The device tags, the check for unmodelled metrics and the tag filters all read these.
- The builder's metric list is grouped as on the Metrics page. Once any metrics in a group are ticked, the group's heading says how many. The total is beside **Metrics**.
- **The Status filter** opens on **Current**, which hides versions that a newer one has replaced. The other options are **Active**, **Draft**, **Archived** and **All versions**, and each shows its count. **Search** matches the name, the UUID and the change description. **Clear filters** resets both.
- **The Metrics page** holds the catalog that schemas are built from: every metric this deployment has adopted, with a search. Before you define something, check there that it does not already exist under another name.
- **Selecting a row**, by clicking it or pressing Enter, opens the schema's drawer. It shows the UUID, version, lifecycle, **Change Description**, **Parent Schema** and **Provisioned Devices**.
- The drawer's first action is **Edit Draft** (for a draft) or **View Schema Detail** (for a published version). Then come **Create Version vN**, **View N Provisioned Device(s)**, **Validate Payload** and **Download JSON**. **Validate Payload** tests a sample payload against the version. **Download JSON** saves the stored definition as a `.schema.json` file.
- **The detail dialog** shows a version's metrics and its **Version History**: the whole line of versions, oldest first. For a draft, it is also where you edit. **Save Draft** keeps your edits without activating anything. The +/- count is measured against the last saved draft.
- **Publish Version vN** saves any unsaved edits and activates the version. It also archives the version before it, and moves every device across at once.
- **Discard Draft** deletes a draft after you type its name. Any devices attached to try the draft out are detached with it.
- **A version's Change Description** says why the version exists. It is optional. You enter it when you create the version, and can edit it while it is a draft. Once published, it is frozen. Publishing asks for nothing more.
- Schemas are versioned, so an edit never silently redefines what past readings were checked against.
- **Semantic ID** says which standard Submodel a schema matches, such as an IDTA template. It is shown on every version. A draft takes its parent's, and you can change or clear it before publishing. A published version keeps the one it was published with.
- **Create Version vN** makes **Draft vN**: an editable copy of the current version, with every metric it models. Nothing changes for any device until the draft is published. A schema's line of versions can have only one open draft at a time. Publish or discard it before you create another version.
- **Devices** on a schema shows what currently claims to implement it. It is a link, such as **3 devices**, that opens the Devices page filtered to that schema. **—** means no device uses it.

## What the states mean

**Conformance is worked out when you look, not stored.** A device is checked against its schema when you look at it. So editing a schema reclassifies its devices at once, not at their next birth. This matters because rebirths are rare by design, and can be weeks apart.

A schema whose definition lists no metrics at all is treated as "cannot be evaluated". That is a different answer from "models nothing". The difference decides whether its devices are flagged for publishing unmodelled metrics.

Aber creates schema UUIDs itself. They are stable and safe to quote within Aber. They are not registered identifiers in anyone else's namespace.
