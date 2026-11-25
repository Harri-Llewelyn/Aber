## What this page is for

This page lists every entity this site has. An entity is anything Aber keeps under an ID of its own, such as a device, a schema or a backup. Use it for three things:

- To find out what an ID names. Paste it into the search.
- To see what is in service, of every kind, in one list.
- To bring back something archived, or to delete it for good.

It has three tabs. **Active** lists what is in service. **Archived** lists what was taken out of service and can come back. **Retired** lists what was deleted.

## Find what an ID names

1. Open **Entities** in the sidebar.
2. Paste the ID into **Search by any ID or name…**.

If the whole of the ID names one entity, that entity opens. For an entity in service, its panel opens. For an archived or a retired one, its tab opens, with that one row in it.

- **Any ID works.** Use a UUID, a Sparkplug ID, the ID a device publishes under, a semantic ID, an automation's ID, a backup's stamp, or the path of a capture's file.
- **The start of an ID works too,** from its first 8 characters. Logs and lists often cut an ID to that. Every entity it could be is listed.
- **Any part of a name works.** Capitals make no difference.
- **The search covers all three tabs.** When it finds something on a tab you are not on, a line under the search says how many, as links. The search stays when you change tab.
- **A search lists 200 matches at most,** and says when there are more. Type more of the ID or the name.
- **Kind** narrows the list to some kinds, such as devices. Each kind shows how many it has.
- **The address keeps the search,** so you can send a link to what you found.

**The search bar finds entities from any page.** Press **Ctrl+K** (**Cmd+K** on a Mac) and type two or more characters of a name, or paste an ID. Entities come after pages and help, 10 of a kind at most, so type more to narrow them. Select one to open it on its own page. If your role can't open that page, or the entity was deleted, it opens on this page. An ID adds two rows below. **View in Entities** searches this page for it. **Find This ID in the Audit Trail** opens its history, for a role that may read it. Both are there even when nothing is found, because the Audit Trail records more kinds than this page lists.

## Active entities

The **Active** tab lists what is in service:

- **Name** is what the entity is called. A capture is named for what it recorded, and a backup by its stamp.
- **Kind** says what it is. A metric that Aber computes is marked **Derived**, and a schema version that a newer one replaced is marked **Archived version**.
- **UUID** is the entity's own ID. Select it to copy it. Nothing changes it, and a deleted entity's is not used again.
- **Second IDs** are the other IDs it goes by. An ID too long for its column slides into view when you point at it.

A replay lane is not listed. It is a recording of a device, rather than a device. A quarantined device is listed, and marked **Quarantined**.

**What you see depends on your role.** You see what you could already see on the other pages:

| Kind | Who sees it |
| :--- | :--- |
| Areas, cells, gateways, devices, schemas, metrics and automations | Everyone |
| Captures | Administrators, Shopfloor Managers and Auditors |
| Machine identities and people | Administrators and Auditors |
| Backups | Administrators |

Select a row to open its panel. It starts with the UUID and the description. Then come the kind, the name, the second IDs, and where the entity is. Its actions are:

- **View in** and the name of a page, such as **View in Devices**. It opens the entity on that page, which has the rest of what Aber knows about it.
- **View in Audit Trail** opens the entity's history, for a role that may read it.
- **View in Automations**, for a device. It opens the automations that apply to it, and says how many there are.

## Archived entities

The **Archived** tab lists the areas, cells, gateways and devices taken out of service.

Taking something out of service has two steps. Archiving is the step you can undo. The record, its history and its identifiers are all kept, but nothing that reads the live plant counts it any more. Deleting is the second step, and this page is the only place it happens.

- **Restore** puts an entity back into service with the identifiers it already had. That is why Aber archives things rather than deleting them. A machine back from a rebuild returns as itself, and everything that ever pointed at it still works. A device's replay lanes come back with it.
- **Export Bundle…** is offered on a device. It opens the Devices page's export dialog with **Bundle** chosen. The bundle is the device's Asset Administration Shell, as an AASX file with the device's history inside. It holds the Audit Trail and the readings still in the live historian, at raw and hourly resolution. It also holds a manifest, which names the cold storage objects that hold older readings. The manifest says plainly what the bundle could not include.
- A role that may not read the Audit Trail sees the bundle disabled, because the bundle contains it. A copy of each bundle is kept beside the cold storage objects, so it can still be fetched from this page after the device is deleted. If the record and its readings should leave with the machine, take the bundle before **Permanent Delete**, or before its **Auto-purge** date.
- **Permanent Delete** removes the row for good. It cannot be undone, so it asks you to type the name back. An archived cell holds nothing, so deleting one moves nothing. Deleting an area takes its cells out of the area and deletes its plan. Deleting a device deletes its replay lanes too.
- **Auto-purge** is the timer: the date the archived record will be removed for good. It is chosen when the entity is archived. Within a week of that date it turns red and shows a warning icon. An entity marked **Never auto-purged** is kept until someone deletes it. When the timer deletes an area, its plan is removed within the hour after.
- **Held** takes the place of the date on a gateway that a playback was published as. The record of each playback is kept, and it names that gateway. So neither the timer nor **Permanent Delete** removes the gateway. Restore it, or leave it archived.
- Archiving a gateway also disables its broker credential and archives its repository in the forge. Restore brings the repository back, but not the credential: issue a new one once the gateway is restored.
- **UUID** and **Archived At** are the two facts to quote when the question is whether something was taken out on purpose.
- **A column's heading sorts the table** by that column, on every tab. Click it again to reverse the order, and a third time to go back to the usual order. A status sorts the most serious first, and an empty cell always sorts last. The page's address keeps the order, so a link or a reload shows the table the same way.
- Without the archive permission (Administrator or Shopfloor Manager), the buttons are disabled and say who can use them.

Archiving an area changes nothing beneath it. Its cells stay filed in it, and every topic under its name keeps that name. The Site Map leaves it off unless archived areas are shown there. Only deleting an area takes its cells out of it.

## Retired entities

The **Retired** tab lists what has passed through the **Archived** tab: archived, then deleted, by the timer or by hand. The row itself is gone. What you see is its tombstone: a record the database wrote as it deleted the row. Administrators, Shopfloor Managers and Auditors see it. Each one names what survives it:

- **Audit Trail** opens the entity's history in the Audit Trail, with deleted entities shown.
- **Forge repository** opens a gateway's repository in the forge. Archiving made it read-only, and nothing deleted it.
- **Bundle** downloads an export taken while the device was still in service, if one was taken.
- **Historian ID** is the key its readings are still stored under. They stay in the historian until retention or cold storage takes them. The Cold Storage page lists its objects by date range, not by device.

## What this page is not

**It is not Cold Storage**, which sits two places above it in the sidebar, past Backups. This page holds **entities**, with a Restore button and a timer on the archived ones. Cold Storage holds archived **telemetry**: readings moved out to object storage, with no restore and no timer. The two share only the word "archive", and one bucket. A device's bundle is kept beside the cold storage objects, but is not listed in their catalogue.

**It is not a delete queue.** Nothing here is removed because you looked at it. "Nothing is archived." means exactly what it says.

**It does not list everything that has an ID.** A proposal, an alert, a recording and a playback are read on their own pages. A vocabulary entry is on the Vocabulary page.
