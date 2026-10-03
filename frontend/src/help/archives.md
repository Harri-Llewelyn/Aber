## Summary

Entities taken out of commission -- areas, cells, gateways and devices that were archived rather than deleted -- and, on the **Retired** tab, the ones that have since been deleted. Archiving is the reversible half of decommissioning: the record, its history and its identifiers all survive, and nothing that reads the live floor counts it any more. Deleting is the other half, and this page is the only place it happens.

## What the controls do

- **Restore** puts an entity back into service with the identifiers it already had. That is the reason archiving exists rather than deletion -- a machine that comes back from a rebuild comes back as itself, and everything that ever referenced it still resolves. A device's replay lanes come back with it.
- **Export Bundle…** is offered on a device. It opens the Devices page's export dialog with **Bundle** chosen, which downloads the device's Asset Administration Shell as an AASX with its history inside: the audit trail, the readings still in the live historian at raw and hourly resolution, and a manifest that names the cold-storage objects holding older readings and says plainly what the bundle could not include. A role that may not read the Audit Trail sees the bundle disabled, because the bundle carries it. A copy is kept beside the cold tier, so the bundle can still be fetched from this page after the device is deleted. Take it before **Permanent Delete** if the record and its readings are to leave with the machine.
- **Permanent Delete** removes the row for good. It asks for the name to be typed back because it cannot be undone. A deleted cell un-files what was in it; a deleted area un-files its cells and loses its plan, and is refused while an Area-Wide asset still names it; a deleted device takes its replay lanes with it.
- **Auto-purge** is the timer: the date the archived record is removed for good, chosen when the entity is archived. Within a week of that date it turns red and carries a warning icon. An entity marked **Never auto-purged** is kept until someone deletes it. Archiving a gateway also revokes its broker credential and archives its forge repository, and neither comes back with Restore.
- **Entity ID** and **Archived At** are the two facts worth quoting when the question is whether something was taken out deliberately. Without the archive permission (Administrator or Shopfloor Manager) the buttons are disabled and say who can use them.

## Retired entities

The **Retired** tab lists what has been through the **Archived** tab: archived, then deleted, by the timer or by hand. The row is gone; what is shown is the tombstone the database wrote as it went. Each names what survives it:

- **Audit Trail** opens the entity's audit trace, with deleted entities shown.
- **Forge repository** opens a gateway's repository in the forge, which archiving made read-only and nothing deleted.
- **Bundle** downloads an export taken while the device was alive, if one was.
- **Historian ID** is the key its readings are still stored under. They stay in the historian until retention or cold storage takes them, and the Cold Storage page lists the objects by date range rather than by device.

An area's archive changes nothing beneath it: its cells stay filed in it, the Site Map keeps drawing its plan, and every topic under its name keeps that name. Only deleting an area un-files its cells.

## What this page is not

**It is not Cold Storage**, which sits two places above it in the rail, past Backups. The two are named apart because they can no longer be told apart by distance. This page holds archived and retired **entities**, with a Restore button and a timer. Cold Storage holds archived **telemetry**: readings tiered to object storage, with no restore and no timer. The two share only the English word, and one bucket: a device's bundle is kept beside the cold objects, not in their catalogue.

**It is not a delete queue.** Nothing here is removed by looking at it, and "Nothing is archived." means exactly what it says.
