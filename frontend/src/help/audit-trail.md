## What this page is for

The Audit Trail records what changed, who changed it, and what it looked like before. Use it to find out when something was changed, and by whom. Every modelling action in Aber is a row here: creating a gateway, assigning a schema, archiving a device or editing a setting. Rows cannot be edited or deleted afterwards.

Each entity has a lane on the timeline, and each change is a marker on that lane.

## What the controls do

- **The search box** matches a name or an id. It takes the three ids shown in the event drawer: an entity ID, a mutation ID or a transaction ID. A term made only of digits also matches a mutation ID and a transaction ID. A deleted entity can be found by its name too, because the trail keeps the name it had.
- **The range select** limits the timeline to the last 15 minutes, hour, day, week or month. It can also take a custom range between two dates and times. **All time** is the default.
- **Filters** opens the two filters used less often, the kind filter and the action filter. Its number is how many of them are set, and its own **Clear** resets just those two.
- **The kind filter** narrows the timeline to one kind of entity: areas, cells, gateways, devices, schemas, metrics and so on. It does not pick out one entity. For one entity's history, paste its name or id into the search box. Or open the Audit Trail from that entity's page, which fills in the search box for you. From a device, that also shows its nameplate and schema changes.
- **The action filter** narrows the timeline to one database action across every entity. That is Insert, Update, Delete, or a named act such as Token minted or Proposal applied. The markers use a separate classification, which the key above the timeline explains.
- **Show deleted entities** brings back the rows for things no longer in the database, such as a deleted schema or a deleted cell. They are hidden by default, so the page shows the plant as it stands now. Their records are kept either way. The number on the button is how many entities it would show. The button appears only when there is something to show.
- **Clear filters** puts every control back to its default, including the deleted entities toggle. Its number is how many controls are changed.
- **Export CSV** saves the events loaded on the page. The changes are flattened into one column. Its number says how many events are loaded and, when more match, how many match in all. To export them all, load the rest first.
- **The key** above the timeline says what each marker means. Each kind has its own shape as well as its own colour, so you can tell them apart without colour vision. A circle is **Operational**, the most common. A square is **Created**, and a diamond is **Configuration**. A triangle is **Lifecycle**: deletes and archives.
- **Grouped** is a violet badge with a count. It replaces markers too close together to draw apart. Hover over it for a breakdown, or narrow the range and the markers separate.
- **The event drawer** opens when you click a marker. It shows when the change was recorded, the actor, the entity ID, the mutation ID, the transaction ID and the description. **Previous** and **Next**, or the arrow keys, step through that entity's history.
- **Property** and **Previous** in the drawer show the field that changed and the value it held before. Together they answer "when did this become wrong?".
- **Same transaction** lists the other rows written by the same act. **Show whole transaction** loads all of them, by searching for the transaction ID.
- **Raw audit payload** opens the entry exactly as it was recorded, for when the summary is not enough.
- **Show more** at the foot loads the next 200 events, older than those already loaded. Beside it is the number loaded out of the number that match, such as "200 of 242". **All N shown.** appears once every matching event is loaded.
- The page **refreshes itself** every 60 seconds, unless an Administrator changed that on the Settings page. A refresh adds new events at the top, and keeps the pages you already loaded.

## What the states mean

**The Audit Trail is deliberately not the logs.** Entries here are only ever added, each is linked to an actor, and none can be changed once written. Container and pod logs are none of those things. They are for diagnosing faults, and they are lost when the container is recreated. Anything that matters for audit is recorded here as a row.

**Not every entry is visible to every role.** The trail has a security lane, for role assignments, machine identities, settings and backups. Only an Administrator or an Auditor can read it. Other roles see the plant's lanes, and the kind filter does not offer them the security kinds.

Rows are kept until an owner retires a whole month. Nothing removes old rows on a timer. Whoever runs the database retires history on purpose, by detaching a month's partition. The steps are in [Trimming the Audit Trail](https://github.com/Harri-Llewelyn/Aber/blob/main/deploy/k8s/README.md#trimming-the-audit-trail).
