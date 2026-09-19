## Summary

Entities taken out of commission -- areas, cells, gateways and devices that were archived rather than deleted -- and, below them, the ones that have since been deleted. Archiving is the reversible half of decommissioning: the record, its history and its identifiers all survive, and nothing that reads the live floor counts it any more. Deleting is the other half, and this page is the only place it happens.

## What the controls do

- **Restore** puts an entity back into service with the identifiers it already had. That is the reason archiving exists rather than deletion -- a machine that comes back from a rebuild comes back as itself, and everything that ever referenced it still resolves. A device's replay lanes come back with it.
- **Export Bundle** is offered on a device. It downloads the device's Asset Administration Shell as an AASX with its history inside: the digital thread, the readings still in the live historian at raw and hourly resolution, and a manifest that names the cold-storage objects holding older readings and says plainly what the bundle could not include. A copy is kept beside the cold tier, so the bundle can still be fetched from this page after the device is deleted. Take it before **Permanent Delete** if the record and its readings are to leave with the machine.
- **Permanent Delete** removes the row for good. It asks for the name to be typed back because it cannot be undone. A deleted cell un-files what was in it; a deleted area un-files its cells and loses its plan, and is refused while an Area-Wide asset still names it; a deleted device takes its replay lanes with it.
- **The auto-purge timer** is how long the archived record is kept before it is removed for good. An entity marked **Permanent (No Auto-Purge)** is kept indefinitely.
- **Entity ID** and **Archived At** are the two facts worth quoting when the question is whether something was taken out deliberately.

## Retired entities

The second card lists what has been through the first: archived, then deleted, by the timer or by hand. The row is gone; what is shown is the tombstone the database wrote as it went. Each names what survives it:

- **Digital Thread** opens the entity's audit trace, with deleted entities shown.
- **Forge repository** opens a gateway's repository in the forge, which archiving made read-only and nothing deleted.
- **Bundle** downloads an export taken while the device was alive, if one was.
- **Historian ID** is the key its readings are still stored under. They stay in the historian until retention or cold storage takes them, and the Cold Storage page lists the objects by date range rather than by device.

An area's archive changes nothing beneath it: its cells stay filed in it, the Site Map keeps drawing its plan, and every topic under its name keeps that name. Only deleting an area un-files its cells.

## What this page is not

**It is not Cold Storage**, which sits directly above it in the rail. The two are named apart because they can no longer be told apart by distance. This page holds archived and retired **entities**, with a Restore button and a timer. Cold Storage holds archived **telemetry**: readings tiered to object storage, with no restore and no timer. The two share only the English word, and one bucket: a device's bundle is kept beside the cold objects, not in their catalogue.

**It is not a delete queue.** Nothing here is removed by looking at it, and "No decommissioned entities currently in archives" means exactly what it says.
