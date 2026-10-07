## What this page is for

The front page of Aber, on one card. The top names the enterprise and the site, and holds three lanes for equipment that belongs to no area. Below them, each area in service is drawn as its plan, with its cells pinned where they stand.

Open it to see whether the plant is up. When something is wrong, every lane, pin and chip takes you to the page that can fix it.

## What the controls do

- **The legend** in the card header names the four states below. Hover an entry for its meaning.
- **Show archived areas** appears beside the legend while any area is archived, with the number archived. Archived areas, and the cells in them, are left off the map; hover the button to see how many cells and devices that is. Turned on, each archived area is drawn faded, with its plan and pins, because its cells are still in it and its topics still carry its name. An archived cell is never pinned.
- **The hierarchy line** names the enterprise and the site. The enterprise is the Sparkplug group chosen at install (the `sparkplug.group_id` setting). The site is set on the Settings page, under Site. The Unified Namespace publishes under the site's name, so the line says when it is not set.
- **The lanes** hold equipment that belongs to no area: **Site-Wide**, **Simulated**, and **Unassigned** (devices and gateways nobody has given a location). Click a lane to list its gateways and devices in the panel on the right, then click a chip to open that item on its own page. **Open Devices page** and **Open Gateways page** appear in the panel only while the lane holds something to file, and the first is the main action. On a narrow card a lane shrinks to its icon; hover it for its name and counts.
- **The area cards** draw each area as its plan. Its cells, gateways and devices are counted at the top right. Area-Wide equipment is included in those counts and also shown on its own, and a narrow card leaves the counts to the panel. A line under the plan says when some cells have no place on it.
- **Click an area card**, or press Enter on it, to open the area in the panel, with its cells, gateways and devices as chips. A cell chip opens that cell's panel; one marked NOT PLACED has no place on the plan yet. Equipment marked AREA-WIDE serves the whole area rather than one cell. **Open on Areas page** edits the area or uploads its plan. A card turns red while an alert fires for a device in it.
- **The pins** are the cells, coloured by the state of their devices. Click one for its details. From the panel, **Open Dashboard** opens the cell's dashboard if it has one, and **Open on Cells page** edits the cell or moves its pin.
- **Unfiled cells** are listed under the areas until they are filed on the Areas page. A cell in no area has no plan to be pinned on.

## What the states mean

- **Online** (green): at least one device here is online. Others may be offline; this says the place is talking to Aber.
- **Needs attention** (amber): a device here is quarantined, waiting to be approved. It outranks Online.
- **Nothing live** (grey): no device here is online, and none is waiting to be approved.
- **Alert firing** (red on a pin; an amber or red badge in the panel): Grafana has an alert firing for a device here. The badge is red when the alert is critical and amber otherwise. The map shows Grafana's verdict and judges nothing itself.

The sidebar marks the pages that have work waiting, with the reason in the item's tooltip: Devices while a device is in quarantine, Gateways while a gateway that should be reporting is offline (one still being set up does not count), and Areas while a cell is in no area.

Nothing on this page changes anything. Equipment is filed on the Devices, Gateways and Cells pages, an area's plan is uploaded on the Areas page, and a cell is placed on its plan from the Cells page. The plan in an area's or a cell's panel on those pages opens this map on that area.
