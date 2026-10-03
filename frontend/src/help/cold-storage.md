## Summary

Telemetry that has aged out of the live historian and been written to object storage. The readings are still there and still yours; they are no longer in the database, and they are no longer on the path any dashboard queries.

The line under the page's description says how long the historian keeps raw telemetry and where older readings are. While archiving is on, the historian drops a raw chunk only once this page lists it as verified, so an archive that falls behind grows the database rather than losing readings.

## What the controls do

- **The button in the header** is shown to an Administrator and opens the destination dialog. It reads **Set up cold storage** while archiving is off; until then raw telemetry past the retention window is dropped and cannot be recovered. It reads **Complete the destination**, in amber with a warning icon, when archiving is on but part of the destination is missing, and its tooltip names what. Once archiving is on and the destination is complete it reads **Change destination**, and its tooltip names the address objects are written to: the endpoint, the bucket and this site's key.
- **The destination dialog** holds the S3 endpoint, region, bucket, access key ID and path style, the secret access key, and the **Archive telemetry before dropping it** switch. The secret key is written to the vault and never shown again; leave the field empty to keep the stored one. The site key is fixed at install and shown for reference. The switch cannot be turned on until every part of the destination is set, and the dialog says beside it what is still missing. Saving writes only the values you changed, each one an ordinary setting recorded in the Audit Trail.
- **The summary strip** above the catalogue reads **On cold storage** (chunks whose raw rows are gone), **Rows archived**, **Object storage used** and **Oldest span held**, then **Unexported since**, and **Awaiting drop** and **Failed** when either is above zero.
- **Object** is the file on object storage; a long key is cut in the middle so its end stays visible, and clicking copies the whole key. **Range** is the window of time it covers, and **Chunk** the historian partition it came from.
- **Rows** and **Size** are what it holds, which is how you judge whether a range is worth retrieving before you retrieve it.
- **State** says where a range currently is in the tiering lifecycle: **Claimed** (selected, nothing written), **Exported** (written, not yet read back), **Verified** (read back and matched, rows still in the database), **On cold storage** (the rows are dropped and the object is the only copy) or **Failed** (the error is shown under the badge).
- **Unexported since** is where the data that has **not** reached the endpoint begins. Everything after that date is telemetry no object is yet known to hold. Up to a week behind is normal -- a chunk is not exported until its whole span has passed the threshold -- and the tooltip gives the exact figure. It turns amber with a warning icon, and the Archive Backlog alert fires, once it runs two weeks past the threshold, which usually means the endpoint cannot be reached.

## What the states mean

**Nothing on this page is deleted by this page.** Tiering moves telemetry out of the database on a schedule; this page is the catalogue of what was moved. Reading it changes nothing.

**These objects are the only copy.** Once a range has been tiered, the database no longer holds those readings -- so an object removed from storage by some other route is plant history that is gone. That is the sentence on this page worth remembering.

**They are not in this cluster.** Tiered objects are written to the S3 endpoint set in the destination dialog, deliberately somewhere a site loss does not reach. Their durability, versioning and retention are the provider's to configure -- this stack cannot check them and its backups do not include them.

## What this page is not

**It is not Archived Entities**, which sits two places below it in the rail, past Backups, and holds archived **entities** -- areas, cells, gateways and devices -- with a Restore button and an auto-purge timer. This page holds **readings**, and it has neither.

**There is no restore button, and that is deliberate.** Charting an archived range would mean recovering a resolution nothing currently plots, at the cost of another container, another gateway route and another authenticated surface over raw plant history. Retrieval is a deliberate act taken outside the dashboard, not a click.
