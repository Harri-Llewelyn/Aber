# Device schemas: the file format and its rules

A device schema says which catalogue metrics a kind of device is expected to publish, the valid range of
each number, and which derived metrics its devices get. This page is the reference for the file a person exports from the Schemas page
or writes and uploads to it. It is for the people who build that page and the editor, and for anything
that calls the API. It says what the file may hold, and what the database does with it.

The rows in the platform database are the record. The YAML is how a person sees and moves them. It is
rendered from the rows on export and parsed on upload, and it is never stored.

To use it, open the Schemas page and read [its help](../help/pages/schemas.md). The Automations page
reads its files the same way: see [the automations reference](automations.md).

## An example

```yaml
- name: Robot_Arm_Schema
  description: What a six-axis robot arm publishes. The range is the sensor's.
  semantic_id: https://admin-shell.io/idta/nameplate/3/0/Nameplate
  semantic_id_type: IRI
  change_description: Added the spindle load and a range for the temperature
  metrics:
    - name: Spindle/BEARING_TEMPERATURE
      minimum: -40
      maximum: 120
    - name: Spindle/LOAD
      minimum: 0
    - name: Spindle/MODE
  derived_metrics:
    - Spindle/TIME_IN_AUTOMATIC
```

A file is a list of schemas. Aber takes a closed set of keys. Anything else is refused, never
ignored.

## The JSON Schema

The dashboard serves the schema at `/json-schema/device-schemas.schema.json`. It is the file
[`frontend/public/json-schema/device-schemas.schema.json`](../frontend/public/json-schema/device-schemas.schema.json).
It describes exactly the keys on this page, with a description on each, so an editor can complete a key
and explain it when it is hovered.

To use it in VS Code's YAML extension, start the file with a comment:

```yaml
# yaml-language-server: $schema=https://<your dashboard address>/json-schema/device-schemas.schema.json
```

The schema is a convenience. The database is the authority, and it checks more: that each metric is in
the catalogue and is not a derived one, that each derived metric is computed from metrics the schema
lists, and that no `name` is used twice in a file. A test holds the two together over the files in [`supabase/device-schemas-fixtures/`](../supabase/device-schemas-fixtures/):
one document and one reason each.

## The keys

### A schema

A file is a list of schemas. Each is a set of these keys.

| Key | Required | What it is |
| :--- | :--- | :--- |
| `name` | Yes | The schema's name: 1 to 120 characters, with no space at either end. Leave off the version. |
| `description` | No | What the schema is for, up to 4,000 characters. |
| `semantic_id` | No | The published id of the standard Submodel the schema matches, 1 to 1,000 characters. |
| `semantic_id_type` | No | How to read `semantic_id`: `IRI`, `IRDI` or `ExpandedNodeId`. Only with `semantic_id`. |
| `change_description` | No | Why this version exists, up to 1,000 characters. Used only when the file makes a new version or a new schema. |
| `metrics` | Yes | The catalogue metrics the schema models: a list of 1 to 1,000. |
| `derived_metrics` | No | The derived metrics the schema's devices get, by name: a list of up to 1,000. Left out, the schema names none. |

### A metric

| Key | Required | What it is |
| :--- | :--- | :--- |
| `name` | Yes | The metric's catalogue name, such as `Spindle/LOAD`. |
| `minimum` | No | The lowest valid reading, for a number. |
| `maximum` | No | The highest valid reading, for a number. |
| `semantic_id` | No | The semantic id the catalogue gives the metric. |

Things to know:

- **A schema is found by its lineage's name.** A schema's versions are called `Robot_Arm_Schema`,
  `Robot_Arm_Schema_v2`, `Robot_Arm_Schema_v3`. Every version carries the name of the first,
  `Robot_Arm_Schema`: the lineage's name. An export writes it, and Aber finds the schema by it on any
  site, whatever its versions are called.
- **A new version is named from its lineage.** Its name is the lineage's name, `_v` and the version's
  number. When that name is already taken, Aber numbers it further, as `Robot_Arm_Schema_v2_2`. The
  version after that one is `Robot_Arm_Schema_v3`. A version made before Aber 1.10 keeps the name it
  has, which may be `Robot_Arm_Schema_v2_2_v3`.
- **A name no lineage has is found by its versions' names.** Aber takes one trailing `_v<n>` off the
  name and off each version's name, and finds the lineage of a version where the two agree. A file
  exported before Aber 1.10 named a schema that way, such as `Robot_Arm_Schema_v2_2` for the lineage
  above. It still applies, whatever the version in force is called now. Where the name is a lineage's,
  and other versions' names without their `_v<n>` match it too, the lineage whose name it is wins. Two
  schemas in one file that find one lineage are refused, as a name used twice.
- **A metric is named by its catalogue name.** Its type, its description and its permitted values come
  from the catalogue, as the schema builder writes them. The file does not repeat them.
- **A metric the catalogue lacks is refused by name.** So is a derived metric under `metrics`: nothing
  publishes one, so it goes under `derived_metrics`. A deprecated metric is accepted only where the schema
  already models it.
- **`derived_metrics` names the derived metrics a device bound to the schema gets.** A device with several
  schemas has every one they name. Aber computes them, so they are not among the metrics a device is judged
  against.
- **A schema is whole on its own.** Each metric a derived one is computed from must be under the same
  schema's `metrics`. For a time in state, each state must be one the schema's copy of the input permits.
  The reason names the derived metric and what is missing.
- **A deprecated derived metric is accepted only where the schema already names it.** A name the catalogue
  lacks is refused, and so is a measured metric.
- **A file without `derived_metrics` names none.** A file says what is saved. A file exported before Aber
  1.10 has no such key, so applying it removes every one the schema names. The preview lists each.
- **A range is a number in the metric's catalogue unit.** Never write a unit. It applies to a metric
  that is a number, and `minimum` is not above `maximum`. Leave a side out for no bound. A device set to
  Enforce drops a reading outside the range.
- **A metric's `semantic_id` is the catalogue's.** An export writes it, so a file shows which concept
  each name means. A file whose id differs from this site's catalogue is refused: the same name must not
  mean another thing. It is never written to the catalogue, and you can leave it out.
- **The order of the metrics does not matter,** nor of the derived metrics. An export writes both in name
  order.

## What the database does with a file

One function, `apply_device_schemas(p_doc, p_dry_run)`, checks and applies a document. The page calls
it twice: once with `p_dry_run` true for the preview, once with it false when the person confirms.

- **It answers one result per schema:** its `name`, its `status` and, for a refusal, `reasons`. The
  status is `new`, `changed`, `unchanged` or `refused`. For a changed schema `version` and
  `schema_name` say the draft it would make, and `metrics` lists the metrics it adds, removes and
  changes. `derived_metrics` lists the derived metrics it adds and removes, and `changes` the keys that
  differ, with a key the file leaves out among them.
- **Each reason has a `path` and a `message`.** The path is a JSON path, such as
  `$[0].metrics[1].minimum`, which the editor maps back to a line.
- **Every field is checked, and every reason is reported,** so a file is fixed in one pass. A file
  holds at most 200 schemas, and a schema at most 1,000 metrics and as many derived metrics. One thing is
  judged last: a derived metric's state, against the permitted values the new version would hold.
- **All or nothing.** With any refusal, nothing is written. A preview writes nothing either.
- **A file never deletes.** A schema the file leaves out is left alone.
- **A published version is never edited.** The version in force is what the file is compared with:
  - A schema that does not exist is made as version 1 and in force, as the schema builder makes one.
  - A changed schema becomes a new **draft** version, named, numbered and linked to its parent as
    **Create Version** does it, from its lineage, with the file's `change_description`. Publishing is a
    step of its own.
  - An unchanged schema is reported unchanged, and writes nothing.
  - A schema that has a draft already refuses a different change, since a schema holds one draft at a
    time. A file that says what the draft already says is unchanged.
- **A changed schema keeps what a file cannot say.** The draft carries the rest of the stored
  definition, such as a metric's pattern. A metric the file drops leaves `required` too.
- **An unchanged schema is judged on what a file says.** The catalogue's descriptions and permitted
  values, the order of the metrics and `change_description` do not make a schema changed.

`device_schemas_document(p_ids)` renders the schemas in force back to this shape, in name order: every
schema, or those of the lineages the ids given belong to, whichever version an id is. Each is named by
its lineage. A draft is not exported.
`apply_device_schemas(device_schemas_document(), true)` reports every schema unchanged.

## Who may, and what is recorded

- **An Administrator may apply a file,** as only an Administrator may create and version a schema in the
  builder. With the second-factor switch on, the session must have given its code. A machine identity
  may not. Every signed-in role may export.
- **Each schema written is one row in the Audit Trail,** naming the person: an `INSERT` of the schema
  or of the draft. A preview, an unchanged schema and a refusal write none.
