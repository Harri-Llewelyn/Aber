## Summary

An area is the ISA-95 level between the site and the cells: the site is this campus, an area is one part of it (on this campus, one building), a cell is a work center inside an area, and a device is a work unit inside a cell. Areas exist so the Unified Namespace can name where a reading came from, and so the Site Map can draw the whole facility at once. A building with more than one floor is more than one area: a floor is not a level of the hierarchy, so the ground floor and the floor above it are two areas side by side on the map.

## What the controls do

- **New Area** creates an area. The name becomes a segment of every `uns/` topic beneath it, so it cannot contain `/`, `+` or `#`. The icon says what the area is for: offices, a production hall, a warehouse, a laboratory, a loading bay, a car park, an open yard or a plant room.
- **Cells** are filed into an area by dragging a cell chip onto the area's row, or from the cell's own Edit form on the Cells page, which also sets its place on the plan. A cell that is in no area is listed in the **unfiled cells** banner above the table; that banner is a queue, and it disappears once every cell is filed. To take a cell out of its area, drag it onto another area or clear the area on its Edit form.
- **Floor plan** is managed from an area's details panel: an area can carry one SVG plan, which the Site Map draws with the area's cells pinned on it, and without one it draws a plain outline. The SVG needs a viewBox (or a width and height) so places on it stay put. A cell takes its place on the plan from the Cells page.
- **Attached Links** hangs URLs off the area, from its details panel: a site plan, a fire strategy, the building's entry in an asset register, a folder of drawings. Nothing is uploaded — the platform stores no files, so each row is an address somewhere else, with a tag saying what it is. Cells, gateways and devices carry the same, from their own panels.
- **Delete** removes an area, un-files its cells and deletes its plan. It is refused while a device or gateway is marked Area-Wide in it, because that mark has nowhere else to point.

## What the states mean

A device is **Area-Wide** when it belongs to an area rather than to any one cell in it, such as a building management system. Set it from the device's Edit form on the Devices page. **Site-Wide** is the same statement about the whole campus.

A cell-scoped device's area is its cell's. Moving a cell to another area moves every device that resolves to it, and nothing is stored twice.

The site's own name is a setting, on the Settings page under Site. The bridge that republishes readings on `uns/` topics publishes nothing until it is set, and publishes a device only once its whole path is known: site, area and cell.
