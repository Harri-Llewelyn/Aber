## What this page is for

This page is the catalog of metrics that every schema is built from. A metric is a name, a datatype and a meaning, and a schema is a selection of metrics. Most metrics are not invented here. They are taken from a published standard on the Vocabulary page. That page passes the entry straight to the Add Metric dialog, so you do not have to type the values.

## What the controls do

- **Metric Catalog** and **Deprecated Metrics** are the two tabs of the page's one card. The open tab's table scrolls inside the card, and its header and group headings stay in view. The two tabs' columns line up.
- **Add Metric**, at the right-hand end of the Metric Catalog tab's toolbar, opens a dialog that builds a name from its parts. You see the full name before you commit to it. Its parts are **Group** (the component the metric belongs to), **Instance** (optional), **Type** (from the selected standard's vocabulary) and **Sub Type** (optional, for MTConnect only).
- **Standard** decides which vocabulary the Type picker draws from. It is stored on the metric as its source. Changing it clears everything the previous vocabulary decided, because a leftover type would make a wrong claim to other systems.
- **Semantic ID** and **Reference Type** link a metric to a term somebody else also uses, so it is no longer local to Aber. The field suggests the id the metric's standard gives it, marked **suggested**. An MTConnect metric gets its data item type's id, which every metric of that type shares. An ISO 22400 or OPC UA entry brings its own id. An ASHRAE 223P concept brings none.
- The suggestion stays until you type or pick another id, and **Use suggested** puts it back. A Custom metric, or a custom MTConnect type, gets no suggestion, and leaving it blank is correct. An invented id would only repeat the name, and would hide the metric from the export's count of unmapped metrics.
- **Search vocabularies**, beside the field, finds a concept by name, standard or id. It searches MTConnect, ISO 22400 and OPC UA, and the IDTA Digital Nameplate's elements. It sets the id and its reference type together, so you choose a nameplate IRDI rather than typing it. You can still type any id.
- A metric carries one semantic id. So a concept from another standard replaces the one the metric's own standard gives it. The metric keeps its standard as its source, and a note under the field says where the id came from.
- **Units** and **Sparkplug Datatype** are filled in from a vocabulary entry where its standard states them. Otherwise you choose. MTConnect gives units to SAMPLE data items only.
- The datatype is how the value is encoded on the wire. Like the name, it cannot be changed once the metric exists: to change it, deprecate the metric and create a new one. ISO 22400 and OPC UA entries fill it in. A 223P concept names a thing rather than a reading, so it leaves the datatype to you. The metric cannot be added until you choose one.
- **ASHRAE 223P is a reference here.** A 223P concept names a piece of equipment, such as a temperature sensor, not its reading. So choosing one fills in the group and the type, but no semantic id. Type the reading's own id if you know it. For example, the QUDT quantity kind `http://qudt.org/vocab/quantitykind/Temperature` names a temperature.
- **Search** finds a known metric by name without opening every group, and opens the groups that match. The groups are collapsed by default, and a group's tooltip says how many metrics it holds. **Clear filters** empties the search.
- **Expand all** opens every group, and reads **Collapse all** while any is open. Collapse all also closes the groups a search opened, and keeps the search.
- **Semantic ID** in the table is cut short in the middle, so its end stays visible: the end is what tells two ids apart. Click it to copy the whole id.
- **Selecting a row**, on either tab, opens the metric's drawer. Click anywhere on the row, or press Enter on it. The drawer shows the name, standard, category, units, datatype, semantic id, description and how many schemas model the metric. For a deprecated metric, it also shows the metric that replaced it.
- The drawer holds **Edit**, **Deprecate** and **Restore**. All three need the Administrator role.
- **Edit**, in the drawer, corrects a metric's **Semantic ID** and **Reference Type**, and nothing else. Use it to fix a mistyped id, or a mapping that has moved on. It offers the same suggestion and search as Add Metric, so a cleared id is one click from restored. Clearing the id leaves the metric unmapped.
- Edit's confirmation says how many schemas model the metric, because every AAS shell exported from them carries the new id. The edit is recorded in the Audit Trail.
- **Deprecate**, in the drawer of a catalog metric, takes it out of the schema builder. It can name the metric that replaces it. The confirmation says how many schemas model it.
- **Restore**, in the drawer of a metric on the Deprecated Metrics tab, is the way back. It offers the metric to schema authors again, and clears the replacement it named. It asks first, as Deprecate does. Both are recorded in the Audit Trail, under Metric catalog, with who made them.

## What the states mean

**A metric name cannot be changed.** The name is what the device publishes, so it reaches MQTT, TimescaleDB and Grafana. Renaming it would strand every reading already stored under the old name. That is why you see the full name before the metric is created, and why you withdraw a metric by deprecating it. The datatype is fixed for the same reason. The semantic id is not sent on the wire. It is a claim about what the metric means, so it can be corrected.

**Deprecated is not deleted.** A deprecated metric keeps its readings, and stays on the schemas that already model it. It is held back from the builder, so no new schema picks it up. The Deprecated Metrics tab lists deprecated metrics, each with the metric that replaced it. The tab is always there, and says so when nothing is deprecated.

**A group is part of the name.** `Axes/X/POSITION` belongs to the group `Axes` because of the text before the first slash, not because of a separate column. A name with no slash is listed under Ungrouped. A group typed with different capital letters from an existing one takes the existing spelling, so you do not get two groups.

## What this page is not

**It is not the Vocabulary page**, which holds the published standards themselves for you to read: MTConnect, ISO 22400, OPC UA and ASHRAE 223P. This page holds what this deployment has actually adopted from them. **It is not Schemas** either. A schema is a contract that names a selection of these metrics, and it has versions; a metric does not.
