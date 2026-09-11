## Summary

The front page of the stack: the site map, drawn from the ISA-95 hierarchy. The enterprise and the site are named at the top, the lanes beneath hold what belongs to no area, and below the area selector each area's cells are drawn with the gateways and devices that resolve to them. It is the page to open when the question is "is the floor up", and the page to leave as soon as the answer is no: every tile is a way into the page that can do something about it.

## What the controls do

- **The hierarchy line** names the enterprise, which is the Sparkplug group the gateways publish under, and the site, which is a setting on the Settings page under Site. The site's name is what the Unified Namespace publishes under, so the line says when it is not set.
- **The lanes** hold what belongs to no area: Site-Wide assets, simulated ones, and anything still waiting to be placed. They sit above the area selector because they are not part of any area.
- **The area selector** shows every area grouped, or one area by floor. Each area's Area-Wide tile leads its cells, holding the assets that serve the whole area rather than any one cell in it.
- **The cell tiles** are the floor as it is modelled. Clicking one opens Cells filtered to it; clicking a gateway or device inside one opens that entity on its own page, carrying the filter.
- **Rearrange** turns on drag and drop. Moves are staged and applied together as one transaction.

## What the states mean

- **Online** (green dot): every device on the tile has been heard from within the staleness window.
- **Needs attention** (amber dot): something on the tile is quarantined, offline or otherwise waiting for a decision.
- **Nothing live** (grey dot): the tile has nothing reporting.
- **Alert firing** (red chip): Grafana has an alert firing against that device.

The counts that used to sit across the top are now in the sidebar: a page's icon turns amber while it has work waiting, with the reason on its tooltip. Devices while a device is held in quarantine, Gateways while a gateway is offline, Areas while a cell is filed in no area.

Nothing on this page changes anything except a staged rearrangement that you apply. It reads.
