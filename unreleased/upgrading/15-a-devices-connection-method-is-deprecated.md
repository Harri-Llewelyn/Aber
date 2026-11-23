### From 1.9.0, `devices.connection_method` is deprecated

From 1.9.0, the dashboard no longer sends a device's connection method, and nothing in Aber uses the
column. It still works in 1.9.x, and it is removed no sooner than 1.10.0. There is nothing to run.

- **The dashboard stops writing it.** The Devices form, the dialog that approves a device from
  Quarantine and a change proposal for a device no longer carry it. Saving a device leaves the stored
  value as it is.
- **The REST API still accepts it.** `/rest/v1/devices` reads and writes `connection_method`, and
  `docs/openapi.yaml` marks it deprecated. A change proposal that names it is still applied when it is
  approved. The Audit Trail still files a change to it as Configuration.
- **It is removed no sooner than 1.10.0.** Change any script that reads or writes it before then.
  Nothing replaces it: the value was always Sparkplug B, or empty, so a script that reads it learns
  nothing.
- **Its value no longer reaches the AAS export.** See [*a device's nameplate no longer carries
  ConnectionMethod or Status*](./08-a-devices-nameplate-no-longer-carries-connectionmethod-or-status.md).
