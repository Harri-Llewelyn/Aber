## What this page is for

A cell is a line or a bay on the shopfloor: the place gateways and devices are put. Cells are how Aber records where things are, and most filters elsewhere in the dashboard come down to a cell. Each cell is filed in an area and can be placed on that area's plan.

In ISA-95 terms a cell is a work center. It is not a "work cell", which the standard uses for one kind of work unit.

## What the controls do

- **The filters** are a search on the cell's UUID or name; the lifecycle select (Active by default, or Archived, or All), which shows how many cells each option holds; **Needs attention**; and **Empty**. **Clear filters** appears while any of them is changed.
- **New Cell** and **Edit Details** open the form. **Cell Name** and **Cell Icon** are what the rest of the dashboard shows. The icon is a picture from a fixed set. It helps tell cells apart on the Site Map and in lists, and does not say what a cell does. If you may not edit a cell, you see **Propose a Change** instead, and an approver decides.
- **Area** files the cell in an area, or leaves it unfiled. Once you choose an area, **Place on the plan** shows its plan: click to pin the cell where it stands. **Clear place** removes the pin and keeps the cell in the area. An area with no plan shows the default outline. The Site Map shows only cells that have a place.
- **Place on plan**, in a placed cell's details panel, draws its area's plan with this cell's pin ringed and the other cells small and dimmed. Click it, or press Enter on it, to open the Site Map on that area. **Expand**, the two arrows in the top-right corner of the plan's card, opens the plan to fill the window, this cell still ringed. Scroll to zoom and drag to move it; Esc closes it.
- **Description** is optional. When a cell has one, it shows in the cell's panel on the Site Map and under its name in the table here.
- **The table** opens a cell's details panel when you click its row, or press Enter on it.
- **A column's heading sorts the table** by that column. Click it again to reverse the order, and a third time to go back to the usual order. A status sorts the most serious first, and an empty cell always sorts last. The page's address keeps the order, so a link or a reload shows the table the same way.
- **Cell UUID** is the identifier to quote in a query or a ticket. Copy it from the details panel.
- **Assigned Gateways** and **Devices** list what is in the cell now. To move one, open it from its chip and use **Edit Details** on its own page. **Show Its Devices** opens the Devices page on this cell's devices, archived ones included. In **Devices (1/3 online)**, a quarantined device is not counted as online, and neither is one awaiting its first birth. Each kind is counted on its own after the online figure.
- **Edit Details** is the panel's main action, or **Restore Cell** for an archived cell. **Attached Links**, **View Audit Trail** and **Archive Cell** are in the panel too. Archiving takes a cell out of service and starts a retention timer on the Archived Entities page.
- **Attached Links** holds the cell's links, such as its Grafana dashboard. A dashboard address set on the cell before 1.7 is there, as a link named **Dashboard**.
- **Archive Cell** is greyed out while any device or gateway is in the cell, archived and quarantined ones included. Hover it to see how many. Move each one to another cell, or delete it, then archive the cell.
- **To move an archived device or gateway**, restore it, move it, then archive it again. Archiving it again starts its retention timer again. Or delete it with **Permanent Delete** on the Archived Entities page.
- **A quarantined device** is in the Quarantine table on the Devices page, not in its list. Approve it into another place, or reject it, which deletes it.

## What the states mean

- **Needs attention**: a gateway in the cell needs attention, or a device in it is quarantined. This is not the same as offline. A gateway created a moment ago and still being set up is not in trouble.
- **Empty**: the cell has no gateway and no device in service. Archived ones do not count. A cell with a gateway and no devices is not empty. The **Empty** filter and the **Empty** badge in the table use the same test.
- **Unfiled** and **not placed** are jobs to do: a cell in no area, or in an area but with no place on its plan. The banner above the table lists devices that belong to no cell.
- **Empty is not broken.** A new install has no cells at all, and a cell with nothing in it says "No devices here" rather than showing a blank.
- Moving a device to another cell does not change its Sparkplug address, so everything pointed at it keeps working.
