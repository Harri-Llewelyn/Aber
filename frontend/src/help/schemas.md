## Summary

A schema says what a class of device is expected to publish: which metrics, of what datatype, meaning what. Assigning one to a device is what turns a list of metric names into something a query, a dashboard or another system can rely on.

## What the controls do

- **The schema builder** defines the metrics. **Data Point**, **Sparkplug Datatype**, **Group** and **Description** are the fields a metric needs to be usable by something that did not write it.
- **Semantic ID** and **Reference Type** are where a metric stops being local to this stack and starts being a term somebody else also uses. The Vocabulary page is where those values come from -- it hands an entry straight to this builder rather than expecting the URI to be typed.
- **The Metric Catalog** is every metric defined across every schema, searchable. It is the fastest way to find out whether the thing you are about to define already exists under another name.
- **Publishing a version** takes a **Change Description**. Schemas version themselves; an edit does not silently redefine what past readings were validated against.
- **Devices** on a schema is the reverse lookup: what currently claims to implement it.

## What the states mean

**Conformance is derived, not stored.** A device is judged against its schema when you look at it, so editing a schema reclassifies its devices immediately rather than at their next birth -- which matters because rebirths are rare by design and can be weeks apart.

A schema whose definition lists no metrics at all is treated as "cannot be evaluated", which is a different answer from "models nothing" -- and the difference is what decides whether its devices are flagged for publishing unmodelled metrics.

Schema UUIDs are minted locally. They are stable and safe to quote inside this stack, but they are not registered identifiers in anyone else's namespace.
