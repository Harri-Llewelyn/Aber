## What this page is for

An automation watches a reading and raises an alert. For example: when the spindle bearing temperature on Lathe 3 stays above 80 for five minutes, raise a warning.

You write each automation as YAML, a plain-text format for lists and settings. There is no form. Write one in the page's editor, or upload a file that holds many.

Everyone who can sign in can read this page. An Administrator or a Shopfloor Manager writes automations. For anyone else, each button that would change something is greyed, and its tooltip says who may use it.

## The list

Open **Automations** in the sidebar, under **Metrics**. Each row is one automation:

- **Automation** is its name, with its id under it. Select the name to open it.
- **Watches** says in words what its triggers watch, such as **Spindle/BEARING_TEMPERATURE above 80 for 5 min on Lathe 3**. Two or more devices are counted, as **on 2 devices**. After two triggers it says how many more there are.
- **Enabled** is a switch, with **On** or **Off** beside it. Turning one off resolves the alerts it raised. The change is recorded in the Audit Trail, and a toast links to the automation.
- **Firing now** says how many alerts it is raising. There is one for each device that is past its limit.
- **Last fired** says when it last raised an alert. **Never** means it has not.

**Search** comes first in the toolbar. It matches a name, an id, a description, a metric and a device's name. A heading sorts the table, and the address keeps the order.

Tick the box at the start of a row to pick it for **Export**.

## Writing an automation

1. Select **New Automation**. The editor opens on an example.
2. Replace the example's device. Type a device's name on the `device:` line and choose it from the list. The editor writes its id, because device names are not unique.
3. Name a metric. Type on the `metric:` line and choose from the list. Only metrics that hold numbers are offered.
4. Set `above:` or `below:` to a number, with no unit. The number is in the metric's own unit.
5. Select **Save**. A dialog checks the text and lists what saving would do, before anything changes. Select **Save 1 Automation** to apply it.

The editor helps as you type:

- **Completion** offers keys, types, severities, devices and metrics. Press **Ctrl Space** to ask for it.
- **Point at a key, a device id or a metric** to read what it is. A metric shows its unit and the valid range its device's schema allows.
- **A wavy line** marks a problem. A threshold outside a metric's valid range is a warning: it can never fire, or it is always past its limit, but it is allowed. A syntax error, or a reason the database refuses the file, is an error.
- **The page keeps no comments.** Put your words in `description:`. The name beside each device id is written again every time the automation opens.

Saving under a new `id:` makes a new automation. The old one stays as it was.

If the dialog lists a refusal, nothing is saved. Each reason names its line. Close the dialog, fix those lines, and save again. The editor marks the same lines.

## The file

An automation file is a list. This one has one automation:

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

- **`id`** is the automation's fixed name. A file with the same `id` updates that automation.
- **`alias`** is the name the list shows.
- **`triggers`** says what starts it. A `threshold` trigger fires while a device's metric is `above` or `below` a number, for as long as `for` says. `device` takes one id, or a list of ids. Each device in a list fires on its own.
- **`for`** is a whole number and `s`, `m` or `h`, such as `30s`, `5m` or `1h`.
- **`actions`** says what it does. This release has one action, `alert`, with a `severity` of `critical`, `warning` or `info`.

Every key and every value is listed in [the format's reference](../../docs/automations.md). Anything not listed there is refused, never ignored.

## Upload and Export

**Upload** takes an `automations.yaml` file. The page reads it in your browser, then shows what applying it would do before it does anything:

- **New**, **Changed** and **Unchanged** automations, and **Refused** ones with each reason and the line it is on. Refusals are listed first.
- **Apply 3 Automations**, the button, says how many it will write. It is greyed while anything is refused.
- **All or nothing.** If anything is refused, nothing is applied.
- **An upload never deletes.** An automation the file leaves out stays as it is. To remove one, open it and select **Delete**.

**Export** downloads `automations.yaml`. With no row ticked it holds every automation. Tick some rows, and **Export** holds only those and counts them, for example **Export (2)**. Inside an automation, **Export** holds that one.

A file from another site needs its device ids changed first. Each site's devices have ids of their own.

## One automation

Select a name in the list. The page shows:

- **The editor**, with the automation as YAML. A comment beside each device id names the device and where it is.
- **Disable** or **Enable**, **Export**, **Delete** and **Save**. **Delete** asks first. Deleting an automation resolves the alerts it raised.
- **Recent firings**: the latest times it raised an alert, newest first. Each row shows the device, the metric, how long it fired, and the labels and values it carried.
- **View Audit Trail**, for anyone who may open it. It shows who created, changed, enabled, disabled or deleted this automation, and when.

For an Operator or an Auditor, the editor is read-only. You can read and copy the text.

## From a device, and from an alert

- **On the Devices page**, open a device and select **View in Automations**. The number beside it is how many automations apply. The list opens on those, with a chip naming the device. Select the chip's **×** to see every automation again.
- **Applies because** says why each one applies. **Named** means one of its triggers names the device. **Site-wide** means it applies to every modelled device.
- **An alert an automation raised** opens that automation, from the alert counter or from its toast.

## In VS Code

To get the same completion and hover in VS Code, install its YAML extension. Start your file with the line the page shows under the editor. It looks like this, with your own address:

```yaml
# yaml-language-server: $schema=https://aber.example.com/json-schema/automations.schema.json
```

## What the states mean

- **Enabled** and **Disabled**: whether Aber evaluates it. A disabled automation raises nothing, and its open alerts are resolved.
- **Firing now**: it is raising at least one alert. The alert is in the alert counter and on History's Alerts tab.
- **An automation that has lost its triggers is turned off.** This happens when every device it named is archived or deleted. The Audit Trail says why. Restoring a device brings its triggers back, and leaves the automation off for you to turn on.
- **New, Changed, Unchanged, Refused**: what a file or a save would do to each automation.
