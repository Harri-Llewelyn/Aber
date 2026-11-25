## What this page is for

A schema says what a kind of device is expected to publish: which metrics, of what datatype, and what they mean. This page is where you build schemas, version them and publish them. Assigning a schema to a device turns its list of metric names into something a query, a dashboard or another system can rely on.

You can also **export** schemas as a YAML file and **upload** one. That moves a schema to another site, lets you review a change as text, and lets you write many similar schemas in an editor. [Move schemas as a file](#move-schemas-as-a-file) says how.

## What the controls do

- **Build Schema from Catalog** creates a schema from the form. **Upload** creates the schemas a file names. In the form, every metric is one this site has adopted, with its catalog name and datatype. A metric carries its standard and semantic id where it has them. The device tags and the check for unmodelled metrics read the names.
- Each metric also brings its description, and its **Permitted Values** where the Metrics page lists them. These are the only values the metric may report.
- **min** and **max** appear beside a numeric metric once you tick it. They are the valid range of the reading for this kind of device, such as a sensor that cannot read below −40. Leave a side blank for no bound. The range belongs to the schema, not the metric, because two kinds of device can measure the same thing over different ranges. It is not an alarm limit.
- The builder's metric list is grouped as on the Metrics page. Once any metrics in a group are ticked, the group's heading says how many. The total is beside **Metrics**.
- **Search** comes first, and matches the name, the UUID and the change description. **The Status filter** beside it opens on **Current**: **Active** and **Draft** ticked, which hides versions that a newer one has replaced. Tick **Archived** too to see every version. Each status shows how many schemas the search leaves with it. **Clear filters** resets both.
- **The Metrics page** holds the catalog that schemas are built from: every metric this deployment has adopted, with a search. Before you define something, check there that it does not already exist under another name.
- **A box at the start of each row** ticks the schema for **Export**. The box in the heading ticks every row shown. It is separate from opening a row's drawer.
- **Export** saves schemas as `device-schemas.yaml`. With none ticked, it saves every schema in force. With some ticked, it says how many, such as **Export (2)**, and saves those. Any role can export.
- **Upload** reads a `.yaml` file, checks it and shows what each schema would become. Nothing changes until you choose **Apply**. It needs the same permission as building a schema.
- **Selecting a row**, by clicking it or pressing Enter, opens the schema's drawer. It shows the UUID, version, lifecycle, **Change Description**, **Parent Schema** and **Devices**.
- **A column's heading sorts the table** by that column. Click it again to reverse the order, and a third time to go back to the usual order. A status sorts the most serious first, and an empty cell always sorts last. The page's address keeps the order, so a link or a reload shows the table the same way.
- The drawer's first action is **Edit Draft** (for a draft) or **View Schema Detail** (for a published version). Then come **Create Version vN**, **View N Devices**, **Validate Payload**, **Export YAML** and **View Audit Trail**, which opens the Audit Trail on this version's own history. **Validate Payload** checks one message of readings (a Sparkplug DDATA) against the version. It applies the rules of **Schema Conformance**, which is set on each device. It lists every finding, and says whether a device set to Enforce would drop that reading. A metric the message leaves out is not a fault: a device sends only the readings that changed. A device with several schemas is judged against all of them together. So a metric that another of its schemas models reads as unmodelled here. **Export YAML** saves this schema, as it is in force, as `device-schemas.yaml`. It is a schema's one export: the detail dialog has none of its own.
- **The detail dialog** shows a version's metrics and its **Version History**: the whole line of versions, oldest first. For a draft, it is also where you edit. **Save Draft** keeps your edits without activating anything. The count beside **Metrics** is measured against the last saved draft: **+** for metrics added, **−** for metrics removed, and **changed** for metrics a save would rewrite.
- **Publish Version vN** saves any unsaved edits and activates the version. It also archives the version before it, and moves every device across at once.
- **Publishing keeps a device's AAS ids.** The Submodel a device exports for a schema keeps the id it had, whichever version is in force. The id is made from the name the first version was built with. The Submodel's version says which version made it. An export of a device with two versions attached, a draft and the version in force, names the draft's Submodel with its version, such as `Robot_Arm_Schema_v2`, until you publish it.
- **Saving a draft brings each metric up to date with the Metrics page.** Its description and permitted values become the ones listed there now. A metric whose permitted values were removed there loses them here too. A note above the list says when opening a draft has already changed a metric this way.
- In a draft, **min** and **max** beside a numeric metric show its stored range. Change them to change it.
- **A save keeps everything else the dialog does not edit**, such as a metric's pattern, and whether the schema refuses metrics it does not list. The dialog names what each metric carries after its name, such as `enum · minimum`.
- **Discard Draft** deletes a draft after you type its name. Any devices attached to try the draft out are detached with it.
- **A version's Change Description** says why the version exists. It is optional. You enter it when you create the version, and can edit it while it is a draft. Once published, it is frozen. Publishing asks for nothing more.
- Schemas are versioned, so an edit never silently redefines what past readings were checked against.
- **Semantic ID** says which standard Submodel a schema matches, such as an IDTA template. It is shown on every version. A draft takes its parent's, and you can change or clear it before publishing. A published version keeps the one it was published with.
- **Create Version vN** makes **Draft vN**: an editable copy of the current version, with every metric it models. Nothing changes for any device until the draft is published. The draft takes the name the first version was built with, and its own number, such as `Robot_Arm_Schema_v3`. When that name is taken, Aber numbers the draft further, such as `Robot_Arm_Schema_v3_2`. The version after it is `Robot_Arm_Schema_v4`. A schema's line of versions can have only one open draft at a time. Publish or discard it before you create another version.
- **Devices** on a schema counts the devices in service that use it. Archived devices, replay lanes and quarantined devices are not counted. A replay lane is the stand-in device a playback replays a recording through. The count is a link, such as **3 devices**, that opens the Devices page on those three. **—** means no device in service uses it. The drawer's **Devices** field and **View N Devices** count the same devices. The warning in **Create Version vN** is the one count that includes archived devices and replay lanes, because publishing moves them too. It says how many of them there are.

## Move schemas as a file

1. Tick the schemas to move, or tick none for all of them. Choose **Export**.
2. Open `device-schemas.yaml` in an editor. Change what you want to change.
3. Choose **Upload** on this site or another, and pick the file. Aber checks the whole file and lists each schema.
4. Read the list. Each schema is **New**, **Changed**, **Unchanged** or **Refused**. A refused schema names the line to fix. Fix it and upload again.
5. Choose **Apply**. All of the file applies, or none of it. The toast links to what it made.

Things to know:

- **A schema is found by the name its first version was built with.** Its versions are `Robot_Arm_Schema`, `Robot_Arm_Schema_v2` and so on. The file names the schema `Robot_Arm_Schema`, on any site. When a version's name is taken, Aber numbers it further, such as `Robot_Arm_Schema_v2_2`. The file still names the schema `Robot_Arm_Schema`. An older file may name it `Robot_Arm_Schema_v2_2` instead. Aber still finds it by that name where that version exists, even when a newer one is in force.
- **A schema that does not exist is made, as version 1 and in force.** That is how **Build Schema from Catalog** makes one.
- **A changed schema becomes a new draft.** A published version is never edited. The draft is named, numbered and linked as **Create Version** does it, with the file's `change_description`. Open it with **Edit Draft**, and publish it when you are ready.
- **A schema with a draft already refuses a different change.** Publish or discard the draft, then upload again.
- **An upload never deletes.** A schema the file leaves out stays as it is.
- **A metric is named by its catalogue name.** The file holds its range, `minimum` and `maximum`, and the catalogue's semantic id. A metric the catalogue lacks is refused by name, and so is a derived metric. A schema cannot model a derived metric, since nothing publishes it.
- **An export holds the schemas in force.** A draft is not in it until it is published.

[The file format](../../docs/device-schemas.md) lists every key.

## What the states mean

**Conformance is worked out when you look, not stored.** A device is checked against its schema when you look at it. So editing a schema reclassifies its devices at once, not at their next birth. This matters because rebirths are rare by design, and can be weeks apart.

**To hold devices to permitted values and ranges, publish a new version of their schema.**

1. Select the schema and choose **Create Version vN**.
2. Open the draft with **Edit Draft**. Each metric takes its permitted values from the Metrics page. Type any ranges.
3. Check the values and ranges, then choose **Publish Version vN**.

Within a few minutes, a device set to Enforce starts dropping each reading outside those values or ranges. A dropped reading is never stored and cannot be recovered. The Audit Trail records each new fault as a schema rejection. A device set to Audit keeps the reading, and the fault is recorded the same way.

A published version never changes. So a version published before a metric had permitted values, or before a range was typed, still checks the datatype alone.

A schema whose definition lists no metrics at all is treated as "cannot be evaluated". That is a different answer from "models nothing". The difference decides whether its devices are flagged for publishing unmodelled metrics.

Aber creates schema UUIDs itself. Each version of a schema has its own. They are stable and safe to quote within Aber. They are not registered identifiers in anyone else's namespace.
