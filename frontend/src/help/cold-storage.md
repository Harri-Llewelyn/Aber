## Summary

Telemetry that has aged out of the live historian and been written to object storage. The readings are still there and still yours; they are no longer in the database, and they are no longer on the path any dashboard queries.

The sentence under the page heading says how long the historian keeps raw telemetry and where older readings are. While archiving is on, the historian drops a raw chunk only once this page lists it as verified, so an archive that falls behind grows the database rather than losing readings.

## What the controls do

- **The Destination card** is shown to an Administrator, first on the page. It names where objects are written, and **Set key** (or **Replace**, once one is stored) writes the secret access key to the vault; the key is never shown again. The endpoint, region, bucket and key ID are set under Settings. When archiving is on but part of the destination is missing, the card says what is still to set.
- **The summary strip** above the catalogue reads **On cold storage** (chunks whose raw rows are gone), **Rows archived**, **Object storage used** and **Oldest span held**, then **Unexported since**, and **Awaiting drop** and **Failed** when either is above zero.
- **Object** is the file on object storage. **Range** is the window of time it covers, and **Chunk** the historian partition it came from.
- **Rows** and **Size** are what it holds, which is how you judge whether a range is worth retrieving before you retrieve it.
- **State** says where a range currently is in the tiering lifecycle: **Claimed** (selected, nothing written), **Exported** (written, not yet read back), **Verified** (read back and matched, rows still in the database), **On cold storage** (the rows are dropped and the object is the only copy) or **Failed** (the error is shown under the badge). The count beside the card title is the number of chunks listed.
- **Unexported since** is where the data that has **not** reached the endpoint begins. Everything after that date is telemetry no object is yet known to hold. Up to a week behind is normal -- a chunk is not exported until its whole span has passed the threshold -- and the tooltip gives the exact figure. It turns amber, and the Archive Backlog alert fires, once it runs two weeks past the threshold, which usually means the endpoint cannot be reached.

## What the states mean

**Nothing on this page is deleted by this page.** Tiering moves telemetry out of the database on a schedule; this page is the catalogue of what was moved. Reading it changes nothing.

**These objects are the only copy.** Once a range has been tiered, the database no longer holds those readings -- so an object removed from storage by some other route is plant history that is gone. That is the sentence on this page worth remembering.

**They are not in this cluster.** Tiered objects are written to the S3 endpoint named on the Destination card, deliberately somewhere a site loss does not reach. Their durability, versioning and retention are the provider's to configure -- this stack cannot check them and its backups do not include them.

## What this page is not

**It is not Archived Entities**, which sits two places below it in the rail, past Backups, and holds archived **entities** -- areas, cells, gateways and devices -- with a Restore button and an auto-purge timer. This page holds **readings**, and it has neither.

**There is no restore button, and that is deliberate.** Charting an archived range would mean recovering a resolution nothing currently plots, at the cost of another container, another gateway route and another authenticated surface over raw plant history. Retrieval is a deliberate act taken outside the dashboard, not a click.
