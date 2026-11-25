### From 1.10.0, the id of a record cannot be changed

From 1.10.0 the database refuses an API request that gives a record another `id`. There is nothing to run.
Read this if a script of yours writes to Aber's API.

- **What is refused.** A `PATCH` whose body holds an `id` other than the record's own, on `areas`,
  `cells`, `gateways`, `devices`, `schemas`, `metric_catalog`, `metric_groups`, `links`,
  `directory_services` or `change_proposals`. So is an upsert on another key that brings an `id` of its own.
- **The answer is HTTP 400,** and its message names the record: `the id of device "Press 4" cannot be
  changed.`
- **What to do.** Leave `id` out of the body, or send the one the record has. Both are accepted, as
  before.
- **No earlier change is undone.** A record whose id was changed before the upgrade keeps the id it has
  now.
