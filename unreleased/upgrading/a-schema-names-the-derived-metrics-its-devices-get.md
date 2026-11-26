### From 1.10.0, a schema names the derived metrics its devices get

Before 1.10 a derived metric was on every device that reported all its inputs. From 1.10 a device has the
derived metrics its schemas name. You choose them in the schema editor, under **Derived Metrics**.

#### What the upgrade does for you

The upgrade fills the list once, so what you see today stays. Each schema version a device uses, and each
draft, names the derived metrics whose inputs that version models. No Audit Trail entry is made.

#### What to check

Read db-init's log after the upgrade, and look for lines that start `0336:`.

1. **A device with no schema no longer has any derived metric.** The line names each device and its metrics.
   Give the device a schema that names them.
2. **A device whose schemas each model only some of the inputs loses that derived metric.** The line names
   these devices too. Add the missing inputs to one of their schemas, name the derived metric there, and
   publish the version.

The log names up to 100 devices in each line. The values are not lost. They are computed from the
readings, so they are back, with their whole past, as soon as a schema names the metric.

#### Files of schemas exported before 1.10

**Such a file takes the derived metrics away when you apply it.** It has no `derived_metrics` list, and a file
says what is saved. The preview warns you and names each one before anything is written, and the change is a
draft you can discard. Export the schemas again, and edit that file.

#### Automations, the AAS export and scripts

- **An automation you have goes on as it was.** Where none of the device's schemas names the derived metric it
  watches, the editor marks it with a warning. A new threshold on such a metric is refused.
- **The AAS export's `DerivedMetrics` submodel** holds the derived metrics the device's schemas name.
- **A script that deletes a derived metric** gets HTTP 409 while a schema names it. Deprecate it, or remove it
  from the schemas first.
- **`schemas.derived_metrics`** is a new field of the API. A schema made without it names none, and a new
  version without it takes the ones of the version before.
- **The result of `apply_device_schemas`** has `derived_metrics`, with what a changed schema gains and loses.
  Its `changes` now lists a key the file leaves out, such as a description.
