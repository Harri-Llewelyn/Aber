## What this page is for

Cold storage holds telemetry that has aged out of the live historian, the database that stores readings. Those readings are written to object storage instead. The readings are still there and still yours, but they are no longer in the database, and no dashboard reads them. This page is the catalogue of what was moved, and where it went.

The line under the page's description says how long the historian keeps raw telemetry, and where older readings are. The historian stores readings in chunks, each covering a span of time. While archiving is on, the historian drops a raw chunk only once this page lists it as verified. So if archiving falls behind, the database grows, but no readings are lost.

## What the controls do

- **The button in the header** opens the destination dialog. Only an Administrator sees it. It reads **Set up cold storage** while archiving is off. Until then, raw telemetry past the retention window is dropped and cannot be recovered.
- The button reads **Complete the destination**, in amber with a warning icon, when archiving is on but part of the destination is missing. Its tooltip names what is missing.
- Once archiving is on and the destination is complete, the button reads **Change destination**. Its tooltip names the address objects are written to: the endpoint, the bucket and this site's key.
- **The destination dialog** holds the S3 endpoint, region, bucket, access key ID and path style, and the secret access key. It also holds the **Archive telemetry before dropping it** switch.
- The secret key is stored in the vault, and never shown again. Leave the field empty to keep the stored one. The site key is fixed when Aber is installed, and is shown for reference.
- The switch cannot be turned on until every part of the destination is set. The dialog says beside it what is still missing. Saving writes only the values you changed. Each one is an ordinary setting, recorded in the Audit Trail.
- **The summary strip** above the catalogue reads **On cold storage** (chunks whose raw rows are gone), **Rows archived**, **Object storage used** and **Oldest span held**. Then comes **Unexported since**. **Awaiting drop** and **Failed** appear when either is above zero.
- **Object** is the file on object storage, shown by its key. A long key is cut in the middle so its end stays visible. Click it to copy the whole key.
- **Range** is the window of time an object covers, and **Chunk** is the historian chunk it came from.
- **Rows** and **Size** are what an object holds. Use them to judge whether a range is worth retrieving before you retrieve it.
- **State** says how far a range has got on its way to cold storage. Each state is explained below.
- **Unexported since** is the date from which data has **not** reached the endpoint. No object is yet known to hold the telemetry after that date. Up to a week behind is normal, because a chunk is not exported until its whole span has passed the archive threshold (set on the Settings page). The tooltip gives the exact figure.
- Once **Unexported since** is two weeks past the threshold, it turns amber with a warning icon, and the Archive Backlog alert fires. That usually means the endpoint cannot be reached.

## What the states mean

- **Claimed**: the range is selected, and nothing is written yet.
- **Exported**: the object is written, but not yet read back.
- **Verified**: the object is read back and matches. The rows are still in the database.
- **On cold storage**: the rows are dropped, and the object is the only copy.
- **Failed**: something went wrong, and the error is shown under the badge.

**Nothing on this page is deleted by this page.** Readings are moved out of the database on a schedule, and this page lists what was moved. Looking at it changes nothing.

**These objects are the only copy.** Once a range has moved to cold storage, the database no longer holds those readings. If an object is removed from storage some other way, that plant history is gone.

**They are not in this cluster.** Objects are written to the S3 endpoint set in the destination dialog. The endpoint is meant to be somewhere that losing the site does not reach. The storage provider configures their durability, versioning and retention. Aber cannot check those settings, and Aber's backups do not include these objects.

## What this page is not

**It is not Archived Entities**, which sits two places below it in the sidebar, past Backups. That page holds archived **entities**: areas, cells, gateways and devices, with a Restore button and an auto-purge timer. This page holds **readings**, and has neither.

**There is no restore button, and that is deliberate.** Retrieving an archived range is something you do on purpose, outside the dashboard, not with a click.
