### From 1.10.0, a nameplate and an attached schema stay with their device

From 1.10.0 the database refuses an API request that moves a nameplate or an attached schema to another
device. There is nothing to run. Read this if a script of yours writes to Aber's API.

- **What is refused.** A `PATCH` of `device_nameplate` or `device_submodels` whose body holds a `device_id`
  other than the row's own.
- **The answer is HTTP 400,** and its message names the device: `the device_id of the nameplate of "Press 4"
  cannot be changed.`
- **What to do.** Delete the row and post it again with the other device. The Audit Trail then shows it under
  both devices.
