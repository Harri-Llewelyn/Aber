## What this page is for

A cell is a line or a bay on the shopfloor: the place gateways and devices are put. Cells are how Aber records where things are, and most filters elsewhere in the dashboard come down to a cell. Each cell is filed in an area and can be placed on that area's plan.

In ISA-95 terms a cell is a work center. It is not a "work cell", which the standard uses for one kind of work unit.

## What the controls do

- **The filters** are the lifecycle select (Active by default, or Archived, or All), which shows how many cells each option holds; a search on the cell's UUID or name; **Needs attention**; and **Empty**. **Clear filters** appears while any of them is changed.
- **New Cell** and **Edit Details** open the form. **Cell Name** and **Cell Icon** are what the rest of the dashboard shows. The icon comes from a fixed set, so every cell can be drawn. If you may not edit a cell, you see **Propose a Change** instead, and an approver decides.
- **Area** files the cell in an area, or leaves it unfiled. Once you choose an area, **Place on the plan** shows its plan: click to pin the cell where it stands. **Clear place** removes the pin and keeps the cell in the area. An area with no plan shows the default outline. The Site Map shows only cells that have a place.
- **Place on plan**, in a placed cell's details panel, draws its area's plan with this cell's pin ringed and the other cells small and dimmed. Click it, or press Enter on it, to open the Site Map on that area.
- **Description** is optional. When a cell has one, it shows in the cell's panel on the Site Map and under its name in the table here.
- **The table** opens a cell's details panel when you click its row, or press Enter on it.
- **Cell UUID** is the identifier to quote in a query or a ticket. Copy it from the details panel.
- **Dashboard / UI URL** links the cell to a dashboard, which **Open Dashboard** in the panel opens. When a cell has one, that is the panel's main action; otherwise **Edit Details** is (or **Restore Cell** for an archived cell). It is a link, not an embedded view: dashboards and thresholds live in Grafana.
- **Assigned Gateways** and **Devices** list what is in the cell now. To move them, edit the gateway or device on its own page.
- **Attached Links**, **View Audit Trail**, **Archive Cell** and **Restore Cell** are in the panel. Archiving takes a cell out of service and starts a retention timer on the Archived Entities page.

## What the states mean

- **Needs attention**: a gateway in the cell needs attention, or a device in it is quarantined. This is not the same as offline. A gateway created a moment ago and still being set up is not in trouble.
- **Empty**: the cell has no gateways, or its gateways serve no devices.
- **Unfiled** and **not placed** are jobs to do: a cell in no area, or in an area but with no place on its plan. The banner above the table lists devices that belong to no cell.
- **Empty is not broken.** A new install has no cells at all, and a cell with nothing in it says "No devices here" rather than showing a blank.
- Moving a device to another cell does not change its Sparkplug address, so everything pointed at it keeps working.
