A cell is a zone of the shopfloor -- a line, a bay, a machining area -- and it exists so that
gateways and devices have somewhere to be. Cells are where this stack models physical location, and
most filters elsewhere in the dashboard are ultimately a question about one.

## What the controls do

- **Cell Name** and **Cell Icon** are what the rest of the dashboard draws. The icon comes from a
  closed set: a value the picker accepts and the renderer cannot draw would be a cell that appears
  blank everywhere.
- **Cell UUID** is the identifier to quote in a query or a ticket, and it is copyable from the detail
  drawer -- which is most of why the drawer exists.
- **A Grafana dashboard URL** can be attached to a cell. It is a link, not an embed: dashboards and
  thresholds live in Grafana and are not mirrored here.
- **Assigned Gateways** and **Assigned Devices** list what is currently located in the cell.
  Assignment itself is edited from the Gateways and Devices pages, where the entity is.

## What the states mean

A cell is flagged for attention when a gateway assigned to it needs attention -- which is not the
same as "is not online". A gateway created ten seconds ago and waiting for its bundle to be carried
to a machine is mid-enrolment, not in trouble, and treating it as a fault would turn the whole page
amber exactly while somebody is provisioning appliances.

**Empty is not broken.** A fresh install has no cells at all, and a cell with nothing in it says "No
devices located here" rather than showing a blank -- an empty list and a failed one look identical
otherwise, and only one of them is a problem.

Moving a device between cells does not change its Sparkplug address. Continuity across a relocation
is a property of how addresses are composed, not something anyone has to preserve by hand.
