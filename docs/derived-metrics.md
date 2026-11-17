# Derived metrics: the file format and its rules

A derived metric is a value Aber computes from other metrics, such as parts per hour. This page is the
reference for the file a person exports from the Derived tab of the Metrics page, or writes and uploads
to it. It is for the people who build that tab and the editor, and for anything that calls the API. It
says what the file may hold, and what the database does with it.

The rows in the platform database are the record. The YAML is how a person sees and moves them. It is
rendered from the rows on export and parsed on upload, and it is never stored.

To use it, open the Metrics page and read [its help](../help/pages/metrics.md). The Automations page and
the Schemas page read their files the same way: see [the automations reference](automations.md) and
[the device schemas reference](device-schemas.md).

## An example

```yaml
- name: Controller/PARTS_PER_HOUR
  description: Parts made per hour, from the controller's part counter.
  kind: counter_rate
  input: Controller/PART_COUNT
- name: Derived/TIME_IN_PICK_BIN_A
  kind: time_in_state
  input: MotionDevice/TaskProgramName
  states: [PICK_BIN_A]
- name: Power/NET
  description: Phase A less phase B.
  kind: sum
  inputs:
    - metric: Power/PHASE_A
      sign: 1
    - metric: Power/PHASE_B
      sign: -1
```

A file is a list of derived metrics. Aber takes a closed set of keys. Anything else is refused, never
ignored.

## The JSON Schema

The dashboard serves the schema at `/json-schema/derived-metrics.schema.json`. It is the file
[`frontend/public/json-schema/derived-metrics.schema.json`](../frontend/public/json-schema/derived-metrics.schema.json).
It describes exactly the keys on this page, with a description on each, so an editor can complete a key
and explain it when it is hovered.

To use it in VS Code's YAML extension, start the file with a comment:

```yaml
# yaml-language-server: $schema=https://<your dashboard address>/json-schema/derived-metrics.schema.json
```

The schema is a convenience. The database is the authority, and it checks more: that each input is in
the catalogue and is measured, that its datatype fits the kind, that a sum's inputs share one unit, and
that no name is used twice. A test holds the two together over the files in
[`supabase/derived-metrics-fixtures/`](../supabase/derived-metrics-fixtures/): one document and one
reason each.

## The keys

### A derived metric

A file is a list of derived metrics. Each is a set of these keys.

| Key | Required | What it is |
| :--- | :--- | :--- |
| `name` | Yes | The name, such as `Controller/PARTS_PER_HOUR`: letters, digits and underscores, with `/` between the parts. |
| `description` | No | What the value means, up to 4,000 characters. A file says what is saved: leave it out and a metric's description is cleared. |
| `kind` | Yes | How the value is computed: `counter_rate`, `time_in_state` or `sum`. |
| `input` | No | The catalogue metric a `counter_rate` or a `time_in_state` is computed from. Required for those two kinds. |
| `states` | No | The values of the input that count as being in the state: a list of at least 1. Required for `time_in_state`. |
| `inputs` | No | The metrics a `sum` adds and takes away: a list of 2 to 8. Required for `sum`. |

### An input of a sum

| Key | Required | What it is |
| :--- | :--- | :--- |
| `metric` | Yes | The catalogue name of the input, such as `Power/PHASE_A`. |
| `sign` | Yes | `1` to add the input to the total, `-1` to take it away. |

Things to know:

- **A file says what is saved.** Where a metric already has a description and the file has none, the upload
  clears it. The preview shows the description before and after, with **None** for an empty one, so the
  change is read before it is applied. An export leaves an empty description out, so exporting and
  uploading the same file changes nothing.
- **A file never says the unit or the datatype.** Aber works the unit out from the inputs, and a derived
  metric is always a Double. A file with `units` or `datatype` is refused.
- **A rate is the input's unit per hour.** A counter with no unit gives `COUNT/HOUR`.
- **A time in state has no unit.** Its value is the share of time, a fraction from 0 to 1, and the
  dashboard shows it as a percentage.
- **A sum takes the unit its inputs share.** Its inputs must all have the same one, or all have none.
- **An input is a measured metric.** A derived metric cannot be built on another. A rate takes a numeric
  counter. A time in state takes a string or boolean metric. A deprecated input is accepted, as the
  catalogue accepts it.
- **A state is text.** A boolean reports `true` or `false`, so write them in quotes: `"true"`. Where the
  input lists its permitted values, each state must be one of them.
- **A name is the catalogue's name,** and no device may publish it. A name a device has declared is
  refused. So is one whose group differs from an existing group only in case.
- **A new group is not registered.** The Metrics page lists a group that a metric's name begins with, as it
  does for any metric.
- **The order does not matter.** An export writes the states and the inputs in the order they are saved. A
  file that lists them in another order is the same definition.

## What the database does with a file

One function, `apply_derived_metrics(p_doc, p_dry_run)`, checks and applies a document. The page calls
it twice: once with `p_dry_run` true for the preview, once with it false when the person confirms.

- **It answers one result per derived metric:** its `name`, its `status`, its `units` and
  `derivation`, and what it `changes`. For a refusal it gives `reasons` instead. The status is `new`,
  `changed`, `unchanged` or `refused`.
- **A change lists the keys that differ,** as the Automations page's result does. `changes` is a list of
  document keys, and `before` and `after` hold their old and new values. Today the only key is
  `description`: `{"changes": ["description"], "before": {"description": "Parts per hour."},
  "after": {"description": null}}`. The three are empty for any other status.
- **Each reason has a `path` and a `message`.** The path is a JSON path, such as `$[0].inputs[1].metric`,
  which the editor maps back to a line.
- **Every field is checked, and every reason is reported,** so a file is fixed in one pass. A file holds
  at most 1,000 derived metrics.
- **All or nothing.** With any refusal, nothing is written. A preview writes nothing either.
- **A file changes a description and deletes nothing.** A definition is fixed once saved, so the
  description is the one thing that can change:
  - A name the catalogue lacks is added as a derived metric.
  - A name that exists with the same definition and description is reported `unchanged`, and writes
    nothing.
  - A name that exists with the same definition and another description is reported `changed`. The
    person accepts it by pressing the dialog's **Apply** button. The stored definition is kept as it is,
    whatever the order of the file's states or inputs.
  - A name that exists with another definition is refused. The reason says to add the new one under a new
    name, then deprecate the old one, choosing the new one as **Superseded By**.
  - A name that a measured metric holds is refused. So is the name of a deprecated derived metric: restore
    it on the Metrics page, or choose a new name.
- **An input the catalogue lacks is refused by name,** every one of them in the same pass. The preview does
  not offer to add it. So is an input that is itself a derived metric.
- **Every other refusal is the catalogue's own.** Aber saves each new metric in a step it then undoes, so
  the preview runs the very checks that Add Derived Metric's save runs, and gives their words. That
  covers an input of the wrong datatype, a state it cannot report, units that differ and a name a device
  declares.

`derived_metrics_document(p_ids)` renders the derived metrics back to this shape, in name order: every one,
or those of the metric ids given. A deprecated one is not exported.
`apply_derived_metrics(derived_metrics_document(), true)` reports every metric unchanged.

## Who may, and what is recorded

- **An Administrator may apply a file,** as only an Administrator may add a metric to the catalogue or change one. With
  the second-factor switch on, the session must have given its code. A machine identity may not. Every
  signed-in role may export.
- **Each derived metric added or changed is one row in the Audit Trail,** naming the person: an `INSERT`
  of the metric, or an `UPDATE` that holds its description before and after, under Metric catalog. A
  preview, an unchanged metric and a refusal write none.
