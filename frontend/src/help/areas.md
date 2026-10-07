## What this page is for

An area is one part of your site, such as a hall, a yard or a plant room. Areas hold cells, and cells hold devices: site, area, cell and device are the levels of the ISA-95 standard. Areas let the Unified Namespace say where a reading came from, and let the Site Map draw the whole site at once.

A floor is not a level of its own. If part of the site has several floors and you want a plan for each, make each floor an area.

## What the controls do

- **The filters** are the lifecycle select (Active by default, or Archived, or All), which shows how many areas each option holds, and a search on the area's name or ID. **Clear filters** appears while either is changed.
- **New Area** creates an area. Its name becomes part of every `uns/` topic beneath it, so it cannot contain `/`, `+` or `#`. Its icon says what the area is: offices, a production hall, a warehouse, a laboratory, a loading bay, a car park, an open yard or a plant room.
- **The table** lists each area with its plan, the cells in it and how many devices belong to it, with its Area-Wide equipment counted separately. Click a row, or press Enter on it, to open its details panel on the right.
- **Cells** are filed into an area by dragging a cell's chip onto the area's row, or by choosing the area on the cell's Edit form on the Cells page, which also sets where it sits on the plan. Cells in no area are listed in the **unfiled cells** banner above the table, which disappears once every cell is filed. To take a cell out of an area, drag it onto another area, drop it on the banner, or clear the area on its Edit form.
- **Area plan** is in the details panel, above the actions. An area can have one SVG plan, which the Site Map draws with the area's cells pinned on it. Without one, the Site Map draws the **Default outline**. Click the plan, or press Enter on it, to open the Site Map on this area. **Replace plan** and **Remove plan** sit beside it, and an area with no plan shows a drop zone instead. The SVG needs a viewBox (or a width and height) so places on it stay put. A cell's place on the plan is set on the Cells page.
- **Edit Details** renames or describes the area, and is the panel's main action. If you may not edit it, you see **Propose a Change** instead, and an approver decides.
- **Attached Links** adds web addresses to the area, from its details panel: a site plan, a fire strategy, its entry in an asset register, a folder of drawings. Nothing is uploaded: each link points somewhere else, with a tag saying what it is. Cells, gateways and devices have the same, from their own panels. (The files Aber does store are area plans, uploaded here, and 3D models, uploaded on the Devices page.)
- **Archive Area** takes the area out of service, as for a cell, gateway or device. It leaves the default view (the lifecycle filter shows it again), disappears from the Site Map unless archived areas are shown there, and starts a retention timer on the Archived Entities page. Nothing moves: its cells stay in it, and every `uns/` topic beneath it keeps its name. **Restore Area** brings it back, and is the main action on an archived area's panel.
- **Deleting an area** is done from Archived Entities. It takes the area's cells out of it and deletes its plan. It is refused while any device or gateway is Area-Wide in the area, because that setting would have nothing left to point at.

## What the states mean

- **Area-Wide**: a device or gateway that belongs to the whole area rather than one cell in it, such as a building management system. Set it on the device's Edit form (Devices page) or the gateway's (Gateways page). **Site-Wide** means the same for the whole site.
- A device in a cell belongs to that cell's area. Moving a cell to another area moves every device in it, and nothing is stored twice.
- The site's own name is set on the Settings page, under Site. The bridge that republishes readings on `uns/` topics publishes nothing until it is set, and publishes a device only once its whole path is known: site, area and cell.
