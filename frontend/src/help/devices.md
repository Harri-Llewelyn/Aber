## Summary

Devices are what the gateways publish. Most are not created here: they appear because something published a birth certificate underneath a gateway, and this page is where that arrival becomes a modelled asset -- named, located, classified against a schema, and documented. In ISA-95 terms a device is a work unit, the bottom of the hierarchy, inside the cell it is located in.

## What the controls do

- **Assign a schema** classifies the device. Until it has one, its metrics are names on a wire.
- **Location** places the device. It is one of three: in a cell, either its own or the one inherited from the gateway it reports through; Area-Wide, serving a whole area; or Site-Wide, serving the whole campus. Only one can be chosen, and a dropdown appears only where the choice leaves more than one answer, such as which cell or which area.
- **Device Name** is yours to set. **Reported Name** and **Published ID** are what the device says about itself, and they are kept separate deliberately -- a self-declared name is a claim, not evidence, and letting it overwrite yours would lose the distinction.
- **The notes field** holds what no column can: "spindle rebuilt 2026-03; runs warmer than its twin".
- **The filters** -- cell, gateway, schema, status, type -- all narrow the same list, and the search box takes a name, a UUID or a Sparkplug ID.
- **Export Telemetry** writes a CSV of the metrics ticked in the telemetry drawer. **Resolution** chooses what it exports: raw samples, or one-minute, five-minute or hourly buckets. Each is labelled with how far back it actually holds data, which is not the same for all four -- raw readings are kept for a fraction of the time the buckets are, so a range from last spring may exist only as hourly averages. Choose a range starting before the raw readings begin and the dialog says so, names the finest resolution that covers the whole range, and offers to switch. A bucket export carries its own columns (average, minimum, maximum and last per bucket) and names the resolution in the first line of the file, because the file is what gets forwarded to somebody else.
- **Export Bundle (with history)** downloads the device's AASX with its Digital Thread, the readings still in the live historian and a manifest, and keeps a copy beside the cold tier. It is offered only to a role that may read the Digital Thread, because the bundle carries it; **Export AAS JSON** and **Export AASX package** are open to every role.
- **The quarantine queue** is a card of its own below the roster, and appears only when something is in it. A gateway published a birth for a device the platform does not know, so the reading was held rather than recorded against a guess. **Approve & Assign** admits it as a new device; where it is one already registered under another name, the queue offers that match to accept instead. **Reject** discards the payload. Nothing in the queue counts as plant history until it is approved.

## What the states mean

- **Never sent a birth** -- the record exists and nothing has published. Usually a device created ahead of its installation.
- **Publishing unmodelled metrics** -- the device is sending metric names its assigned schema does not account for. This is derived when you look rather than stored, so editing a schema reclassifies its devices immediately instead of at their next birth, which may be weeks away.
- **Quarantined** -- a payload was judged non-conforming and is being held for a decision. The reason is kept as a row rather than a log line, so it is still there tomorrow.
- **Archived** -- decommissioned, and no longer counted anywhere.

**Sparkplug ID** is the address the device is reachable at on the broker. It is composed from the gateway's group and the device's own id at the moment it is read, which is why relocating a device does not break anything that was pointed at it.
