## What this page is for

The front page of Aber, on one card. The top names the enterprise and the site, and holds three lanes for equipment that belongs to no area. Below them, each area in service is drawn as its plan, with its cells pinned where they stand.

Open it to see whether the plant is up. When something is wrong, every lane, pin and chip takes you to the page that can fix it.

## What the controls do

- **The legend**, at the right-hand end of the toolbar, names the five states below. Hover an entry for its meaning.
- **Show archived areas** appears at the left of the toolbar while any area is archived, with the number archived. Archived areas, and the cells in them, are left off the map; hover the button to see how many cells and devices that is. Turned on, each archived area is drawn faded, with its plan and pins, because its cells are still in it and its topics still carry its name. An archived cell is never pinned.
- **Archived gateways and devices** are never on the map, whichever areas are shown. The lanes, the cards and the pins count only equipment in service. The Archived Entities page lists the rest.
- **The hierarchy line** names the enterprise and the site. The enterprise is the Sparkplug group chosen at install (the `sparkplug.group_id` setting). The site is set on the Settings page, under Site. The Unified Namespace publishes under the site's name, so the line says when it is not set.
- **The lanes** hold equipment that belongs to no area: **Site-Wide**, **Simulated**, and **Unassigned** (devices and gateways nobody has given a location). Each lane has its own colour: Site-Wide is blue, Simulated grey, and Unassigned amber. A lane is filled with its colour only while it holds something. An empty lane stays grey, and shows its colour when you point at it or open it. Click a lane to list its gateways and devices in the panel on the right, then click a chip to open that item on its own page. **Open Devices page** and **Open Gateways page** appear in the panel only while the lane holds something to file, and the first is the main action. On a narrow card a lane shrinks to its icon; hover it for its name and counts.
- **The area cards** draw each area as its plan. Its cells, gateways and devices are counted at the top right. Area-Wide equipment is included in those counts and also shown on its own, and a narrow card leaves the counts to the panel. A line under the plan says when some cells have no place on it.
- **Click an area card**, or press Enter on it, to open the area in the panel, with its cells, gateways and devices as chips. A cell chip opens that cell's panel; one marked NOT PLACED has no place on the plan yet. Equipment marked AREA-WIDE serves the whole area rather than one cell. **Open on Areas page** edits the area or uploads its plan. A card turns red while an alert nobody has acknowledged fires for a device in it.
- **The pins** are the cells, coloured by the state of their devices. Click one for its details. From the panel, **Open on Cells page** edits the cell or moves its pin.
- **Devices (1/3 online)** in a panel does not count a quarantined device as online, or one awaiting its first birth. Each kind is counted on its own after the online figure.
- **Expand**, the two arrows at the top right of an area card's plan, opens the plan to fill the window. It is there when the area has a plan, or pins on its outline. Scroll or pinch to zoom in where the pointer is, and drag to move the plan. The **+**, **−** and **Fit** buttons in the corner do the same as the keys +, − and 0, and the arrow keys move the plan. The pins keep their size as you zoom, so pins that overlap on the card move apart. Click a pin to close the view and open that cell's panel. Esc closes it.
- **Unfiled cells** are listed under the areas until they are filed on the Areas page. A cell in no area has no plan to be pinned on.

## What the states mean

- **Online** (green): at least one device here is online. Others may be offline; this says the place is talking to Aber.
- **Needs attention** (amber): a device here is quarantined, waiting to be approved. It outranks Online.
- **Nothing live** (grey): no device here is online, and none is waiting to be approved.
- **Alert firing** (a red pin with a pulsing ring; an amber or red badge in the panel): an alert is firing against a device here, and nobody has acknowledged it. The badge is red when the alert is critical and amber otherwise. The map shows the alert and judges nothing itself.
- **Alert acknowledged** (a red pin with a tick and no pulse; a hollow red badge with a tick in the panel): an alert against a device here has been acknowledged, and is still firing. A device chip says **ACKNOWLEDGED**. If another alert here is not acknowledged, the place shows **Alert firing** instead.

Every state is what Aber last read. If the dashboard cannot reach the server for about 10 seconds, a strip under the top bar says **Not updating since** and a time. While it shows, treat what you see as out of date. It goes away when the next refresh works. If your session has ended, the strip says so instead and offers **Sign In Again**.

The sidebar marks the pages that have work waiting, with the reason in the item's tooltip: Devices while a device is in quarantine, Gateways while a gateway that should be reporting is offline (one still being set up does not count), and Areas while a cell is in no area. When a page's tabs are open in the sidebar, the number moves to the tab the work is in, such as Quarantine under Devices.

Nothing on this page changes anything. Equipment is filed on the Devices, Gateways and Cells pages, an area's plan is uploaded on the Areas page, and a cell is placed on its plan from the Cells page. The plan in an area's or a cell's panel on those pages opens this map on that area.

## The alert counter

The alert counter is the shield or warning sign in the top bar, on every page. Its number is how many alerts are firing that nobody has acknowledged. The browser tab's title and its icon count the same. Select the counter to list every firing alert.

To acknowledge an alert:

1. Select the counter, then **Acknowledge** under the alert.
2. Choose a reason: **Investigating**, **Known cause**, **Planned work**, **Sensor or model fault**, **Threshold wrong** or **Other**.
3. Add a note if it helps. **Other** needs one. Everyone who can see the alert reads it.
4. Select **Acknowledge alert**.

The alert stays in the list, after the others, with a tick. It says who acknowledged it, when, and why. It leaves the number until it resolves. If it fires again before it resolves, it stays acknowledged. Once it resolves, the next time it fires it counts again.

Operators, Shopfloor Managers and Administrators can acknowledge an alert. If someone else acknowledged it first, the dialog says who and when. **Withdraw**, under an acknowledged alert, puts it back in the number. The person who acknowledged it can withdraw it, and so can a Shopfloor Manager or an Administrator. Each acknowledgement and withdrawal is recorded in the Audit Trail.
