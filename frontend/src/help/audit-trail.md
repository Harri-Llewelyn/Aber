## Summary

The record of what changed, who changed it, and what it looked like before. Every modelling action in this stack -- creating a gateway, assigning a schema, archiving a device, editing a setting -- lands here as a row, and the rows cannot be edited or deleted afterwards. Each entity gets a lane on the timeline, and each change is a marker on it.

## What the controls do

- **The search box** matches a name or an id. It takes an entity ID, a mutation ID or a transaction ID, the three ids in the event drawer, and a term that is only digits also matches a mutation ID and a transaction ID. A deleted entity is found by its name too, because the trail keeps the name it had.
- **The range select** limits the timeline to the last 15 minutes, hour, day, week or month, or to a custom range of two dates and times. **All time** is the default.
- **Filters** opens the two less used filters. Its number is how many of them are set, and its own **Clear** resets just those two.
  - **The kind filter** narrows to one kind of entity: areas, cells, gateways, devices, schemas, metrics and so on. It does not pick one entity. For one entity's history, paste its name or id into the search box, or open the Audit Trail from that entity's page, which fills the search box for you.
  - **The action filter** narrows to one database action across every entity: Insert, Update, Delete, or a named act such as Token minted or Proposal applied. The markers are a separate classification, explained by the key above the timeline.
- **Show deleted entities** brings back the rows belonging to things that are no longer in the database -- a deleted schema, a deleted cell. They are hidden by default, so the page reads as the plant as it stands; their records are kept either way, and the number on the button is how many entities are behind it. The button appears only when there is something to reveal.
- **Clear filters** puts every control back to its default, including the deleted entities toggle. Its number is how many controls are off their default.
- **Export CSV** writes the events loaded on the page, with the computed changes flattened into one column. Its number says how many are loaded and, when more match, how many match in all: load the rest first to export them all.
- **The key** above the timeline says what each marker means. Each class has a shape as well as a colour, so the classes can be told apart without colour vision: a circle for **Operational**, the most common, a square for **Created**, a diamond for **Configuration** and a triangle for **Lifecycle**, the deletes and archives. Markers too close together to draw apart become one violet **Grouped** badge carrying a count; hover it for a breakdown, or narrow the range and they separate.
- **The event drawer** opens on a click and shows when it was recorded, the actor, the entity ID, the mutation ID, the transaction ID and the description. **Previous** and **Next**, or the arrow keys, step through that entity's history.
- **Property** and **Previous** in the drawer show the field that changed and the value it held before, which is the pair that answers "when did this become wrong".
- **Same transaction** lists the other rows the same act wrote, and **Show whole transaction** loads all of them by searching for the transaction ID.
- **Raw audit payload** opens the entry exactly as it was recorded, for the cases where the rendered summary is not enough.
- **Show more** at the foot loads the next 200 events, older than those loaded. Beside it, the number loaded out of the number that match, such as "200 of 242". **All N shown.** appears once every matching event is loaded.
- The page **refreshes itself** every 60 seconds unless an Administrator changed that on the Settings page. A refresh adds new events at the top and does not discard pages you loaded.

## What the states mean

**The Audit Trail is deliberately not the logs.** Entries here are append-only, attributed to an actor, and immutable once written. Container and pod logs are none of those things; they are diagnostics, and they are gone when the container is recreated. If something matters for audit it belongs in a row, which is why it is here.

**Not every entry is visible to every role.** The trail carries a security lane -- role assignments, machine identities, settings and backups -- that only an Administrator or an Auditor can read. The other roles see the plant's lanes and are not offered the security kinds in the filter.

Rows are kept until an owner retires a whole month. Nothing prunes the trail on a timer: history is retired by detaching a month's partition, which is a deliberate step by whoever runs the database, and the steps are in [Trimming the Audit Trail](https://github.com/Harri-Llewelyn/Aber/blob/main/deploy/k8s/README.md#trimming-the-audit-trail).
