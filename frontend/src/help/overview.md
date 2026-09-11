## Summary

The front page of the stack, one card. The top names the enterprise and the site and holds the three lanes for what belongs to no area. Below them every area is drawn as one of its floors, and opening one shows that floor's plan with the cells pinned where they stand. It is the page to open when the question is "is the floor up", and the page to leave as soon as the answer is no: every lane, pin and chip is a way into the page that can do something about it.

## What the controls do

- **The hierarchy line** names the enterprise, which is the Sparkplug group the gateways publish under, the site, which is a setting on the Settings page under Site, and the area the map is showing. The site's name is what the Unified Namespace publishes under, so the line says when it is not set.
- **The lanes** hold what belongs to no area: Site-Wide assets, simulated ones, and anything still waiting to be placed. Click one to list its gateways and devices in the panel on the right; click a chip there to open that asset on its own page.
- **The area thumbnails** draw each area as one of its floors, with its cells, gateways and devices counted at the top right. The selector under the plan steps through the area's floors without opening it; click the card to open the area on the floor shown. A card goes red while an alert fires against a device in it.
- **All areas and the zoom** sit at the top of the side column when an area is open. Beneath them the floor rail walks the floors, top-down, with a small image glyph on each floor that carries an uploaded plan, and beneath that sit the cells on this floor with no place on the plan yet, the cells on no floor, and the area's Area-Wide assets, which serve the whole area rather than any one cell in it. The area's name is on the hierarchy line.
- **The pins** are the cells, coloured by the state of the devices that resolve to them. Click one for its details; from there, Open on Cells page edits it or moves its pin.
- **Zoom** magnifies the plan; Fit brings it back to the size that fits the page. All areas returns to the thumbnails.

## What the states mean

- **Online** (green): every device here has been heard from within the staleness window.
- **Needs attention** (amber): something here is quarantined, offline or otherwise waiting for a decision.
- **Nothing live** (grey): nothing here is reporting.
- **Alert firing** (red): Grafana has an alert firing against a device here.

The counts that used to sit across the top are now in the sidebar: a page's icon turns amber while it has work waiting, with the reason on its tooltip. Devices while a device is held in quarantine, Gateways while a gateway is offline, Areas while a cell is filed in no area.

Nothing on this page changes anything. Assets are filed on the Devices, Gateways and Cells pages; floors and their plans are managed on the Areas page; a cell is placed on its plan from the Cells page.
