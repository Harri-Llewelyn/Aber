## Summary

The front page of the stack, one card. The top names the enterprise and the site and holds the three lanes for what belongs to no area. Below them every area is drawn as its plan, with its cells pinned where they stand. It is the page to open when the question is "is the plant up", and the page to leave as soon as the answer is no: every lane, pin and chip is a way into the page that can do something about it.

## What the controls do

- **The legend** in the card header names the four states below. Hover an entry for what it means.
- **The hierarchy line** names the enterprise, which is the Sparkplug group named when the stack was installed (the `sparkplug.group_id` setting), and the site, which is a setting on the Settings page under Site. The site's name is what the Unified Namespace publishes under, so the line says when it is not set.
- **The lanes** hold what belongs to no area: **Site-Wide** assets, **Simulated** ones, and **Unassigned**, the devices and gateways nobody has said a location for. Click one to list its gateways and devices in the panel on the right; click a chip there to open that asset on its own page. **Open Devices page** and **Open Gateways page** in the panel are offered only while the lane holds something to file. On a narrow card a lane drops its counts, then its name, down to its icon; hover it for its name and tally.
- **The area cards** draw each area as its plan, with its cells, gateways and devices counted at the top right (Area-Wide assets are counted in those and broken out again at the end; a narrow card leaves the counts to its panel), and a line under the plan while some of its cells have no place on it. Click a card for the area in the panel on the right: its cells, gateways and devices, whether it has a plan, the cells not yet placed, and its Area-Wide assets, which serve the whole area rather than any one cell in it. **Open on Areas page** edits the area or uploads its plan. A card goes red while an alert fires against a device in it.
- **The pins** are the cells, coloured by the state of the devices that resolve to them. Click one for its details; from there **Open on Cells page** edits it or moves its pin, and **Open Dashboard** opens its dashboard when it has one. An archived cell keeps its pin, muted; an archived area keeps its card the same way, drawn muted with its plan and its pins, because its cells are still filed in it and its topics still carry its name.
- **Unfiled cells** sit under the areas until they are filed into one on the Areas page; a cell in no area has no plan to be pinned on.

## What the states mean

- **Online** (green): at least one device here is online. The other devices may be offline; this says the place is talking to the platform.
- **Needs attention** (amber): a device here is quarantined, waiting to be admitted. It outranks Online.
- **Nothing live** (grey): no device here is online and none is waiting to be admitted.
- **Alert firing** (red on a pin, an amber or red badge in the panel): Grafana has an alert firing against a device here. The panel badge is red when the alert is critical and amber otherwise. The map relays Grafana's verdict and evaluates nothing of its own.

The sidebar flags the pages that have work waiting, with the reason on the item's tooltip: Devices while a device is held in quarantine, Gateways while a gateway that should be reporting is offline (one still waiting for its bundle is not), and Areas while a cell is filed in no area.

Nothing on this page changes anything. Assets are filed on the Devices, Gateways and Cells pages; an area's plan is uploaded on the Areas page; a cell is placed on its plan from the Cells page.
