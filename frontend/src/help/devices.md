## Summary

Devices are what the gateways publish. Most are not created here: they appear because something published a birth certificate underneath a gateway, and this page is where that arrival becomes a modelled asset -- named, located, classified against a schema, and documented.

## What the controls do

- **Assign a schema** classifies the device. Until it has one, its metrics are names on a wire.
- **Location** places the device. It is one of three: in a cell, either its own or the one inherited from the gateway it reports through; Area-Wide, serving a whole area; or Site-Wide, serving the whole campus. Only one can be chosen, and a dropdown appears only where the choice leaves more than one answer, such as which cell or which area.
- **Device Name** is yours to set. **Reported Name** and **Published ID** are what the device says about itself, and they are kept separate deliberately -- a self-declared name is a claim, not evidence, and letting it overwrite yours would lose the distinction.
- **The notes field** holds what no column can: "spindle rebuilt 2026-03; runs warmer than its twin".
- **The filters** -- cell, gateway, schema, status, type -- all narrow the same list, and the search box takes a name, a UUID or a Sparkplug ID.

## What the states mean

- **Never sent a birth** -- the record exists and nothing has published. Usually a device created ahead of its installation.
- **Publishing unmodelled metrics** -- the device is sending metric names its assigned schema does not account for. This is derived when you look rather than stored, so editing a schema reclassifies its devices immediately instead of at their next birth, which may be weeks away.
- **Quarantined** -- a payload was judged non-conforming and is being held for a decision. The reason is kept as a row rather than a log line, so it is still there tomorrow.
- **Archived** -- decommissioned, and no longer counted anywhere.

**Sparkplug ID** is the address the device is reachable at on the broker. It is composed from the gateway's group and the device's own id at the moment it is read, which is why relocating a device does not break anything that was pointed at it.
