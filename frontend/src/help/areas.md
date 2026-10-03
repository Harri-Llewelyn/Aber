## Summary

An area is the ISA-95 level between the site and the cells: the site is this campus, an area is one part of it (a hall, a yard, a plant room), a cell is a line or bay inside an area, and a device is a work unit inside a cell. Areas exist so the Unified Namespace can name where a reading came from, and so the Site Map can draw the whole campus at once. A part of the campus with more than one floor is more than one area if you want more than one plan: a floor is not a level of the hierarchy.

## What the controls do

- **The filters** are the lifecycle select (Active by default, or Archived, or All), whose options say how many areas each holds, and a search on the area's name or ID. **Clear filters** appears while either is off its default.
- **New Area** creates an area. The name becomes a segment of every `uns/` topic beneath it, so it cannot contain `/`, `+` or `#`. The icon says what the area is for: offices, a production hall, a warehouse, a laboratory, a loading bay, a car park, an open yard or a plant room.
- **The table** lists each area with its plan state, the cells filed in it and the number of devices that resolve to it, with its Area-Wide assets counted separately. Click a row, which ends in a chevron, for the details panel on the right.
- **Cells** are filed into an area by dragging a cell chip onto the area's row, or from the cell's own Edit form on the Cells page, which also sets its place on the plan. A cell that is in no area is listed in the **unfiled cells** banner above the table; that banner is a queue, and it disappears once every cell is filed. To take a cell out of its area, drag it onto another area, drop it on the banner, or clear the area on its Edit form.
- **Area plan** is managed from an area's details panel, above its actions: an area can carry one SVG plan, which the Site Map draws with the area's cells pinned on it, and without one it draws the **Default outline**. The panel draws the plan with every cell on it; click it, or press Enter on it, to open the Site Map on the area. **Replace plan** and **Remove plan** sit beside it. An area with no plan shows a drop zone for one instead. The SVG needs a viewBox (or a width and height) so places on it stay put. A cell takes its place on the plan from the Cells page.
- **Edit Details** renames or describes the area, and is the panel's main action. Someone who may not edit it sees **Propose a Change** instead, and an approver decides.
- **Attached Links** hangs URLs off the area, from its details panel: a site plan, a fire strategy, the area's entry in an asset register, a folder of drawings. Nothing is uploaded, so each row is an address somewhere else, with a tag saying what it is. Cells, gateways and devices carry the same, from their own panels. (Area plans and 3D models are the files the platform does store; they are uploaded on the Areas and Devices pages.)
- **Archive Area** takes an area out of service the way a cell, a gateway or a device is: it leaves the default view (the lifecycle filter shows it again), is hidden from the Site Map unless archived areas are shown there, and runs a retention timer on the Archived Entities page. It moves nothing: its cells stay filed in it and every `uns/` topic beneath it keeps its name. **Restore Area** returns it, and is the main action of an archived area's panel. Deleting an area is done from Archived Entities, un-files its cells and deletes its plan, and is refused while a device or gateway is marked Area-Wide in it, because that mark has nowhere else to point.

## What the states mean

A device is **Area-Wide** when it belongs to an area rather than to any one cell in it, such as a building management system. Set it from the device's Edit form on the Devices page, or a gateway's on the Gateways page. **Site-Wide** is the same statement about the whole campus.

A cell-scoped device's area is its cell's. Moving a cell to another area moves every device that resolves to it, and nothing is stored twice.

The site's own name is a setting, on the Settings page under Site. The bridge that republishes readings on `uns/` topics publishes nothing until it is set, and publishes a device only once its whole path is known: site, area and cell.
