## Summary

An area is the ISA-95 level between the site and the cells: the site is this campus, an area is one part of it (on this campus, one building), a cell is a work center inside an area, and a device is a work unit inside a cell. Areas exist so the Unified Namespace can name where a reading came from, and so the Site Map can show one area at a time.

## What the controls do

- **New Area** creates an area. The name becomes a segment of every `uns/` topic beneath it, so it cannot contain `/`, `+` or `#`. The icon says what the area is for: offices, a production hall, a warehouse, a laboratory, a loading bay, a car park, an open yard or a plant room.
- **Cells** are filed into an area by dragging a cell chip onto the area's row, or from the cell's own Edit form on the Cells page, which also sets the floor. A cell that is in no area is listed in the **unfiled cells** banner above the table; that banner is a queue, and it disappears once every cell is filed. To take a cell out of its area, drag it onto another area or clear the area on its Edit form.
- **Floors** are managed from an area's details panel: every area has a ground floor (level 0), floors above it and basements below can be added, and each can carry an SVG plan the Site Map draws. A cell is filed onto a floor from the Cells page. Deleting a floor asks for its name; a floor holding cells, or an area's last floor, cannot be deleted.
- **Delete** removes an area and un-files its cells. It is refused while a device or gateway is marked Area-Wide in it, because that mark has nowhere else to point.

## What the states mean

A device is **Area-Wide** when it belongs to an area rather than to any one cell in it, such as a building management system. Set it from the device's Edit form on the Devices page. **Site-Wide** is the same statement about the whole campus.

A cell-scoped device's area is its cell's. Moving a cell to another area moves every device that resolves to it, and nothing is stored twice.

The site's own name is a setting, on the Settings page under Site. The bridge that republishes readings on `uns/` topics publishes nothing until it is set, and publishes a device only once its whole path is known: site, area and cell.
