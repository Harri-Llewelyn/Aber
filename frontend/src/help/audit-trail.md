## Summary

The record of what changed, who changed it, and what it looked like before. Every modelling action in this stack -- creating a gateway, assigning a schema, archiving a device, editing a setting -- lands here as a row, and the rows cannot be edited or deleted afterwards.

## What the controls do

- **The entity filter** narrows to one asset's history: everything that has ever been done to this device, in order.
- **The action filter** narrows to one kind of change across every asset -- every archive, every schema assignment.
- **Show deleted entities** brings back the rows belonging to things that are no longer in the database -- a deleted schema, a decommissioned cell. They are hidden by default, so the page reads as the plant as it stands; their records are kept either way, and the number on the button is how many are behind it. The button appears only when there is something to reveal.
- **Property** and **Previous** show the field that changed and the value it held before, which is the pair that answers "when did this become wrong".
- **Raw audit payload** opens the entry exactly as it was recorded, for the cases where the rendered summary is not enough.

## What the states mean

**The Audit Trail is deliberately not the logs.** Entries here are append-only, attributed to an actor, and immutable once written. Container and pod logs are none of those things; they are diagnostics, and they are gone when the container is recreated. If something matters for audit it belongs in a row, which is why it is here.

**Not every entry is visible to every role.** The trail carries more than one lane, and some of what is recorded is deliberately unreadable to the engineering roles -- an audit trail an engineer can edit or fully inspect is worth less than one they cannot.

Entries are retained on a bounded window rather than for ever. The trail stopped growing without end on purpose: a store with no retention answer is one that eventually fails at the worst moment.
