# Automations: the file format and its rules

An automation is a rule that watches a reading and raises an alert: when this device's metric is
above 80 for five minutes, raise a warning. This page is the reference for the file a person writes
or uploads, for the people who build the Automations page, the editor and anything that calls the
API. It says what the file may hold, what the database does with it, and what happens to an
automation when a device goes.

The rows in the platform database are the record. The YAML is how a person sees and moves them: it
is rendered from the rows and parsed back on save, and it is never stored.

To write one, open the Automations page and read [its help](../help/pages/automations.md). The page
and its editor are described in [`frontend/README.md`](../frontend/README.md#automations-and-its-editor).

## An example

```yaml
- id: lathe-3-spindle-hot
  alias: Lathe 3 spindle bearing hot
  description: Bearing above 80 °C for five minutes. Check the coolant feed first.
  enabled: true
  triggers:
    - trigger: threshold
      device: 3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13
      metric: Spindle/BEARING_TEMPERATURE
      above: 80
      for: 5m
  actions:
    - action: alert
      severity: warning
```

The keys follow Home Assistant's automations, so someone who knows them can read a file at a glance.
Aber takes a closed set of them. Anything else is refused, never ignored.

## The JSON Schema

The dashboard serves the schema at `/json-schema/automations.schema.json`. It is the file
[`frontend/public/json-schema/automations.schema.json`](../frontend/public/json-schema/automations.schema.json).
It describes exactly the keys on this page, with a description on each, so an editor can complete
a key and explain it when it is hovered.

To use it in VS Code's YAML extension, start the file with a comment:

```yaml
# yaml-language-server: $schema=https://<your dashboard address>/json-schema/automations.schema.json
```

The schema is a convenience. The database is the authority, and it checks more: that each device
and metric exists, and that no `id` is used twice in a file. A test holds the two together over
the files in [`supabase/automations-fixtures/`](../supabase/automations-fixtures/): one document
and one reason each.

## The keys

### An automation

A file is a list of automations. Each is a set of these keys.

| Key | Required | What it is |
| :--- | :--- | :--- |
| `id` | Yes | The automation's fixed name: 1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or a digit. A file with the same `id` updates that automation. |
| `alias` | Yes | The name the list shows: 1 to 120 characters, with no space at either end. |
| `description` | No | What it is for, up to 1,000 characters. The file keeps no comments, so words go here. |
| `enabled` | No | `true` or `false`. True when left out. An enabled automation needs a trigger. |
| `triggers` | Yes | What starts it: a list of at most 100 triggers. Any one fires it. |
| `conditions` | No | Checks made when a trigger fires. This release has no condition types, so leave it out or empty. |
| `actions` | Yes | What it does: a list of exactly one `alert` action. |

### The `threshold` trigger

It fires when the latest value of a metric on a device is above, or below, a number, and has stayed
so for `for`. It compares the last value known: a reading that does not arrive neither starts it
nor clears it.

| Key | Required | What it is |
| :--- | :--- | :--- |
| `trigger` | Yes | The type. `threshold` is the one this release has. |
| `device` | Yes | One device id, or a list of 1 to 500. Each device in a list is evaluated, and fires, on its own. |
| `metric` | Yes | The metric's catalogue name, such as `Spindle/BEARING_TEMPERATURE`. |
| `above` | One of the two | Fires while the value is greater than this number. |
| `below` | One of the two | Fires while the value is less than this number. |
| `for` | No | How long the breach must hold before it fires: a whole number and `s`, `m` or `h`, such as `30s`, `5m` or `1h`, up to 999 of one unit. `0s` when left out. |

Things to know:

- **Devices are named by id.** Device names are not unique. The id is on the Devices page, and the
  editor completes a typed name into its id. The file the page renders writes the device's name and
  place in a comment beside each id.
- **The metric is a number in the metric catalogue.** A text or flag metric has no threshold to
  compare with. A [derived metric](#a-threshold-on-a-derived-metric) works too.
- **Give `above` or `below`, not both.** A number, with no unit. The value is in the metric's
  catalogue unit, which the editor shows.
- **A hold is judged at each evaluation.** A `for` shorter than the evaluation interval fires at
  the next evaluation that finds the breach that old. [How an automation is evaluated](#how-an-automation-is-evaluated)
  says how often that is.

### A threshold on a derived metric

A derived metric is computed, so no device publishes it and it has no latest reading. A threshold on
one is judged against its **current value**, by one rule for each kind:

| Kind | The value judged |
| :--- | :--- |
| Counter rate | The rate per hour **over the last hour**: the 60 minutes ending at the last whole minute. |
| Time in state | The share of the **last hour** spent in the states, from 0 to 1. |
| Sum or difference | The sum **at the last whole minute**. |

The Devices drawer shows the same number, with the window in words. A time in state is shown as a percentage there and in History, and is a fraction wherever it is data: the API, an alert's `values` and a threshold.

- **Why an hour.** A rate from one minute swings between 0 and sixty times the count, and one
  minute's share is 0 or 1. An hour is what "parts per hour" and "uptime" mean.
- **A counter that stops counting reads 0 per hour.** A `below` threshold on a rate fires for a machine
  that stops, and for one that stops reporting. A device that reports only some of a definition's inputs
  has no value, so it never fires.
- **`for` and the hold work as for any metric.** Each run judges the current value again. The alert
  says the window: "Controller/PARTS_PER_HOUR is 4.2 over the last hour, below 5".
- **A time in state's threshold is a fraction from 0 to 1.** The dashboard shows the value as a
  percentage, but the file holds the fraction: `below: 0.9` is 90%. An alert on one reads
  "Press 1: Controller/UPTIME is 42% over the last hour, below 90% for 10m".
- **Time in state is resolved to the minute.** A counter that resets and passes its old value inside one
  minute is under-counted by that old value.

### The `alert` action

It raises an alert on the Alerts page, in History and in the counter, for the device and metric
that breached. It resolves when the breach ends, or when the automation is turned off or deleted.

| Key | Required | What it is |
| :--- | :--- | :--- |
| `action` | Yes | The type. `alert` is the one this release has. |
| `severity` | Yes | `critical`, `warning` or `info`: the vocabulary an alert's severity holds. |

### Conditions

There are none yet. A condition is a check made when a trigger fires, as in Home Assistant, and the
first one arrives with a later release. `conditions` is accepted when it is left out or empty, so
the shape of a file does not change when it comes.

## How an automation is evaluated

The platform database evaluates every enabled automation once a minute. Nothing else has to run.
A run reads the historian, judges each device, and writes the alerts. It writes them as any other
alert is written, so acknowledging, suppressing and sending one work as they do for the rest.

- **A run reads the latest value of each metric an automation watches.** It asks the historian once
  for each metric, and names only the devices that metric is watched on. A derived metric's current
  value is [computed from the minutes](#a-threshold-on-a-derived-metric) instead.
- **The latest value is compared, whenever it arrived.** A device that sends a reading only when it
  changes is compared by its last reading. A value that is a flag, a text or not a number is no
  reading.
- **A breach fires when it has held for `for`.** The first run that finds the value breaching
  starts the clock. The first run at which `for` has passed, with the value still breaching, raises
  the alert.
- **A hold is judged at each run, so it rounds up to a run.** `for: 30s` fires at the second run,
  about a minute after the first. `for: 5m` fires at the sixth. A `for` of `0s` fires at the first
  run that finds the breach.
- **An alert resolves at the first run that finds the value back inside the threshold.** A breach
  that ends before `for` has passed raises nothing. The next breach starts the clock again.
- **A changed threshold starts the clock again for a breach that has not yet fired.** An alert that
  is already firing stays firing while the new threshold is breached, and resolves when it is not.
- **No reading is not a breach.** A device with no latest value is left as it was. It may never
  have published, or last have published longer ago than the historian keeps raw readings (14 days
  by default). A firing alert stays firing, and a breach that is waiting to fire neither starts nor
  clears. Silence that should raise an alert is a different rule, not this one.
- **Each run confirms the alerts it holds.** A reminder is sent only while the last run confirmed
  the alert, within the past five minutes.

The state of each device is in `automation_trigger_states`: when its breach began, when it began to
fire, its last value, and when that value arrived. Every signed-in role may read it at
`/rest/v1/automation_trigger_states`. Nobody writes it but the evaluator.

### When the historian cannot be read

A run that cannot read the historian changes nothing. It fires no alert and resolves none, and the
state is left as it was. It raises one platform alert instead, **Automations Not Evaluated**, with
the fingerprint `condition:not-evaluated`. The first run that reads the historian again resolves it.

Alerts that were firing stay firing meanwhile. No reminder is sent for them, because no run is
confirming them.

### What an alert holds

- **The name** is the automation's `alias`, and **the severity** is the `alert` action's.
- **The subject** is the device, so the alert opens on the Devices page and its history is the
  device's.
- **The summary** names the device, the metric, the value and the threshold:
  `Lathe 3: Spindle/BEARING_TEMPERATURE is 82.5, above 80 for 5m`. For a derived metric the value is
  rounded to three decimals and followed by its window:
  `Press 1: Controller/PARTS_PER_HOUR is 4.167 over the last hour, below 5 for 10m`.
- **The labels** are `severity`, `entity_type`, `metric`, `automation` (the automation's `id`) and
  `trigger_id`.
- **The values** are `value`, the reading that fired it, and `threshold`. `value` is not rounded.
- **It has no Grafana rule.** The alert counter and the device's drawer do not link to Grafana for it.

## What the database does with a file

One function, `apply_automations(p_doc, p_dry_run)`, checks and applies a document. The page calls
it twice: once with `p_dry_run` true for the preview, once with it false when the person confirms.

- **It answers one result per automation:** its `key`, its `status` and, for a refusal, `reasons`.
  The status is `new`, `changed`, `unchanged` or `refused`. For a changed automation `changes`
  lists the keys that differ.
- **Each reason has a `path` and a `message`.** The path is a JSON path, such as
  `$[0].triggers[1].above`, which the editor maps back to a line.
- **Every field is checked, and every reason is reported,** so a file is fixed in one pass. A file
  holds at most 500 automations and 10,000 devices across its triggers.
- **All or nothing.** With any refusal, nothing is written. A preview writes nothing either.
- **A file never deletes.** An automation the file leaves out is left alone. Deleting one is a
  separate act on the page. Home Assistant's `automations.yaml` is the whole set; an Aber file is a
  batch of changes.
- **An automation is found by its `id`.** A changed one keeps the trigger rows that still name the
  same device and metric, so an alert already firing for them keeps its fingerprint.
- **An omitted key means its default.** A file without `enabled` turns a disabled automation back
  on. Render a file with `automations_document()` and edit that, rather than writing from memory.

`automations_document(p_keys)` renders the rows back to this shape, all of them or the keys asked
for, with each device's name and place for the comment beside its id.
`apply_automations(automations_document() -> 'automations', true)` reports every automation
unchanged.

## When a device goes

An automation is bound to the devices it names.

- **Archiving a device archives the triggers that name it.** They are kept, and nothing evaluates
  them. Restoring the device brings them back, and enables nothing.
- **Deleting a device removes them.**
- **An automation left with no live trigger is disabled,** and the Audit Trail records why.
- **Turning an automation off, deleting it, or archiving or deleting a trigger's device resolves
  its open alerts.** So does a file that removes a trigger or points it at another device or
  metric. A new threshold does not: the trigger keeps its identity and its alert.

An alert an automation raises has the fingerprint `condition:<trigger id>:<device id>:<metric>`,
composed by `automation_alert_fingerprint()` and nowhere else.

## Who may write

An Administrator or a Shopfloor Manager applies, turns on and off, and deletes automations. Every
signed-in role reads them. With the second-factor switch on, a writer needs a session that gave its
code. Each act writes one Audit Trail row per automation, in the asset lane, naming who did it:
`AUTOMATION_CREATED`, `AUTOMATION_CHANGED`, `AUTOMATION_ENABLED`, `AUTOMATION_DISABLED` and
`AUTOMATION_DELETED`.

The database design, and why it is shaped so, is in
[`supabase/README.md`](../supabase/README.md#automations-are-kept-as-rows-0255).
