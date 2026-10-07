## What this page is for

This page lists the areas, cells, gateways and devices taken out of service. Use it to bring one back, or to delete it for good. The **Retired** tab lists the ones already deleted.

Taking something out of service has two steps. Archiving is the step you can undo. The record, its history and its identifiers are all kept, but nothing that reads the live plant counts it any more. Deleting is the second step, and this page is the only place it happens.

## What the controls do

- **Restore** puts an entity back into service with the identifiers it already had. That is why Aber archives things rather than deleting them. A machine back from a rebuild returns as itself, and everything that ever pointed at it still works. A device's replay lanes come back with it.
- **Export Bundle…** is offered on a device. It opens the Devices page's export dialog with **Bundle** chosen. The bundle is the device's Asset Administration Shell, as an AASX file with the device's history inside. It holds the Audit Trail and the readings still in the live historian, at raw and hourly resolution. It also holds a manifest, which names the cold storage objects that hold older readings. The manifest says plainly what the bundle could not include.
- A role that may not read the Audit Trail sees the bundle disabled, because the bundle contains it. A copy of each bundle is kept beside the cold storage objects, so it can still be fetched from this page after the device is deleted. If the record and its readings should leave with the machine, take the bundle before **Permanent Delete**.
- **Permanent Delete** removes the row for good. It cannot be undone, so it asks you to type the name back. Deleting a cell leaves what was in it with no cell. Deleting an area takes its cells out of the area and deletes its plan. It is refused while an Area-Wide asset still names the area. Deleting a device deletes its replay lanes too.
- **Auto-purge** is the timer: the date the archived record will be removed for good. It is chosen when the entity is archived. Within a week of that date it turns red and shows a warning icon. An entity marked **Never auto-purged** is kept until someone deletes it.
- Archiving a gateway also disables its broker credential and archives its repository in the forge. Restore brings the repository back, but not the credential: issue a new one once the gateway is restored.
- **Entity ID** and **Archived At** are the two facts to quote when the question is whether something was taken out on purpose.
- Without the archive permission (Administrator or Shopfloor Manager), the buttons are disabled and say who can use them.

## Retired entities

The **Retired** tab lists what has passed through the **Archived** tab: archived, then deleted, by the timer or by hand. The row itself is gone. What you see is its tombstone: a record the database wrote as it deleted the row. Each one names what survives it:

- **Audit Trail** opens the entity's history in the Audit Trail, with deleted entities shown.
- **Forge repository** opens a gateway's repository in the forge. Archiving made it read-only, and nothing deleted it.
- **Bundle** downloads an export taken while the device was still in service, if one was taken.
- **Historian ID** is the key its readings are still stored under. They stay in the historian until retention or cold storage takes them. The Cold Storage page lists its objects by date range, not by device.

Archiving an area changes nothing beneath it. Its cells stay filed in it, and every topic under its name keeps that name. The Site Map leaves it off unless archived areas are shown there. Only deleting an area takes its cells out of it.

## What this page is not

**It is not Cold Storage**, which sits two places above it in the sidebar, past Backups. This page holds archived and retired **entities**, with a Restore button and a timer. Cold Storage holds archived **telemetry**: readings moved out to object storage, with no restore and no timer. The two share only the word "archive", and one bucket. A device's bundle is kept beside the cold storage objects, but is not listed in their catalogue.

**It is not a delete queue.** Nothing here is removed because you looked at it. "Nothing is archived." means exactly what it says.
