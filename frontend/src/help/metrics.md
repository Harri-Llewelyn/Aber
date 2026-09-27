## Summary

The catalog of metrics every schema is built from. A metric is a name, a datatype and a meaning; a schema is a selection of them. Most metrics are not invented here -- they are taken from a published standard on the Vocabulary page, which hands the entry straight to the Add Metric form rather than expecting the values to be typed.

## What the controls do

- **Add Metric** composes a name from its parts: **Group** (the component it belongs to), an optional **Instance**, the **Type** from the selected standard's vocabulary, and for MTConnect an optional **Sub Type**. The composed name is shown before you commit to it.
- **Standard** decides which vocabulary the Type picker draws from, and is recorded on the metric as its provenance. Changing it clears everything the previous vocabulary decided, because a stale type would be a wrong interoperability claim.
- **Semantic ID** and **Reference Type** are where a metric stops being local to this stack and becomes a term somebody else also uses. ISO 22400, OPC UA and ASHRAE 223P supply theirs; MTConnect metrics get their data item type's id, shared by every metric of that type, until you type your own; a custom type gets none.
- **Sparkplug Datatype** is how the value is encoded on the wire, and the one field that cannot be changed afterwards. ISO 22400 and OPC UA entries fill it in; a 223P concept names a thing rather than a reading, so it leaves the choice to you and the metric cannot be added until you make it.
- **Search** reaches a known metric without opening every group. The groups are collapsed by default and carry a count, so a shut catalog still says what is in it.
- **Deprecate** retires a metric from the schema builder and can name the metric that supersedes it. The confirmation says how many schemas model it.
- **Restore**, on the Deprecated Metrics card, is the way back: it offers the metric to schema authors again and clears the replacement it named. It asks first, as Deprecate does. Both are recorded in the Digital Thread, under Metric catalog, with who made them.

## What the states mean

**A metric name is immutable.** It is what the device publishes, so it reaches MQTT, TimescaleDB and Grafana, and renaming it would orphan every reading already stored under it. That is why the composed name is shown before the metric is created, and why the way to withdraw one is to deprecate it.

**Deprecated is not deleted.** A deprecated metric keeps its readings and stays on the schemas that already model it; it is withheld from the builder so no new schema picks it up. Deprecated metrics are listed on a card of their own below the catalog, with the metric each was superseded by, and the card appears only when something is deprecated.

**A group is part of the name.** `Axes/X/POSITION` belongs to the group `Axes` because of the text before the first slash, not because of a column, and a name with no slash is listed under Ungrouped. A case variant of a group that already exists resolves to the established spelling, so the two do not fork.

## What this page is not

**It is not the Vocabulary page**, which holds the published standards themselves -- MTConnect, ISO 22400, OPC UA, ASHRAE 223P -- as reference to read. This page is what this deployment has actually adopted from them. **It is not Schemas** either: a schema is a contract naming a selection of these metrics, and it versions; a metric does not.
