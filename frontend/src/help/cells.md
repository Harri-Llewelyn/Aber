## Summary

A cell is a line or a bay on the shopfloor, and it exists so that gateways and devices have somewhere to be. Cells are where this stack models physical location, and most filters elsewhere in the dashboard are ultimately a question about one. A cell is filed in an area (the ISA-95 level above it) and can be placed on that area's plan. In ISA-95 terms a cell is a work center: the standard also calls one kind of work unit a work cell, and this page does not mean that.

## What the controls do

- **The filters** are the lifecycle select (Active by default, or Archived, or All), whose options say how many cells each holds, a search on the cell's UUID or name, **Needs attention** and **Empty**. **Clear filters** appears while any of them is off its default.
- **New Cell** and **Edit Details** open the form. **Cell Name** and **Cell Icon** are what the rest of the dashboard draws. The icon comes from a closed set: a value the picker accepts and the renderer cannot draw would be a cell that appears blank everywhere. Someone who may not edit a cell sees **Propose a Change** instead, and an approver decides.
- **Area** files the cell in an area, or leaves it unfiled. Once an area is chosen, **Place on the plan** shows that area's plan: click it to pin the cell where it stands, and **Clear place** takes the pin off while the cell stays in the area. An area with no plan shows the default outline. The Site Map draws only the cells that have a place.
- **Place on plan**, in a placed cell's details panel, draws its area's plan with this cell's pin ringed and the area's other cells small and dimmed. Click it, or press Enter on it, to open the Site Map on that area.
- **Description** is optional free text. When a cell has one, it shows in the cell's details panel on the Site Map and sits under its name in the table here.
- **Cell UUID** is the identifier to quote in a query or a ticket, and it is copyable from the detail drawer -- which is most of why the drawer exists.
- **Dashboard / UI URL** can be attached to a cell, and the drawer's **Open Dashboard** opens it; it is the drawer's main action when there is one, and otherwise **Edit Details** is (or **Restore Cell** for an archived cell). It is a link, not an embed: dashboards and thresholds live in Grafana and are not mirrored here.
- **Assigned Gateways** and **Devices** list what is currently located in the cell. Assignment itself is edited from the Gateways and Devices pages, where the entity is.
- **Attached Links**, **View Audit Trail**, **Archive Cell** and **Restore Cell** are on the drawer. Archiving takes a cell out of service and starts a retention timer on the Archived Entities page.

## What the states mean

**Needs attention** lists a cell when a gateway assigned to it needs attention or a device in it is quarantined. Needing attention is not the same as "is not online": a gateway created ten seconds ago and waiting for its bundle to be carried to a machine is mid-enrolment, not in trouble, and treating it as a fault would turn the whole page amber exactly while somebody is provisioning appliances.

**Empty** lists a cell with no gateways, or with gateways serving no devices.

**Unfiled** and **not placed** are jobs: a cell in no area, or in an area but without a place on its plan. The banner above the table lists devices that resolve to no cell.

**Empty is not broken.** A fresh install has no cells at all, and a cell with nothing in it says "No devices here" rather than showing a blank -- an empty list and a failed one look identical otherwise, and only one of them is a problem.

Moving a device between cells does not change its Sparkplug address. Continuity across a relocation is a property of how addresses are composed, not something anyone has to preserve by hand.
