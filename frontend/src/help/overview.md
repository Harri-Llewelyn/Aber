The front page of the stack: how many cells, gateways and devices exist, how many of them are reporting right now, and anything Grafana is currently alerting on. It is the page to open when the question is "is the floor up", and the page to leave as soon as the answer is no -- every count and every card here is a way into the page that can actually do something about it.

## What the controls do

- **The counts** across the top are totals set against live figures: devices that have sent a birth, gateways whose heartbeat is current. A total much larger than its live figure is the thing worth clicking.
- **The cell cards** are the floor as it is modelled. Clicking one opens Cells filtered to it; clicking a gateway or device inside one opens that entity on its own page, carrying the filter.
- **The alert list** shows what Grafana is firing on now. Each entry navigates to the page the alert is scoped to -- a gateway rule goes to Gateways, not to Devices.

## What the states mean

- **Online** -- heard from within the staleness window.
- **Active** -- enrolled, in service, not archived.
- **STAGED** -- created here but not yet reporting. Normal for an appliance not installed yet.
- **QUAR** -- quarantined. The device published something the platform would not accept as it stood, and it is being held for a decision rather than trusted or dropped.
- **OFF** -- no current heartbeat or birth. On a gateway that is a fault; on a device it may simply be switched off.
- **ARCH** -- archived, which means decommissioned on purpose. Archived entities are left out of the attention counts deliberately.

Nothing on this page changes anything. It reads.
