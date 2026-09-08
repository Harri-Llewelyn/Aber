## Summary

Telemetry that has aged out of the live historian and been written to object storage. The readings are still there and still yours; they are no longer in the database, and they are no longer on the path any dashboard queries.

## What the controls do

- **Object** is the file on object storage. **Range** is the window of time it covers, and **Chunk** the historian partition it came from.
- **Rows** and **Size** are what it holds, which is how you judge whether a range is worth retrieving before you retrieve it.
- **State** says where a range currently is in the tiering lifecycle.

## What the states mean

**Nothing on this page is deleted by this page.** Tiering moves telemetry out of the database on a schedule; this page is the catalogue of what was moved. Reading it changes nothing.

**These objects are the only copy.** Once a range has been tiered, the database no longer holds those readings -- so an object removed from storage by some other route is plant history that is gone. That is the sentence on this page worth remembering.

## What this page is not

**It is not Archives**, which is two groups up the rail and holds decommissioned **assets** -- cells, gateways and devices -- with a Restore button and a purge timer. This page holds **readings**, and it has neither.

**There is no restore button, and that is deliberate.** Charting an archived range would mean recovering a resolution nothing currently plots, at the cost of another container, another gateway route and another authenticated surface over raw plant history. Retrieval is a deliberate act taken outside the dashboard, not a click.
