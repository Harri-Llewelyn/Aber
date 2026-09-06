Record what the broker actually carried, and play it back later. A capture is the raw traffic -- birth
certificates and the data that followed -- kept so that a fault can be examined after the machine has
been fixed, or so that a change can be tried against real plant behaviour rather than a guess.

## What the controls do

- **Start a recording** and, optionally, restrict it to one gateway. Left on **All gateways** it
  records the whole broker.
- **NBIRTH** and **DBIRTH** counts show what the capture caught announcing itself. A capture with no
  births in it can still be replayed, but nothing in it will be identifiable as a device.
- **Playback** replays a capture back onto the broker. It arrives under **shadow** devices -- an
  entity kind that exists so replayed traffic is visibly not live traffic. Nothing you can create is
  a shadow, and nothing real is turned into one.
- **The search box** takes a name or a Sparkplug ID, for finding one capture among many.

## What the states mean

A recording is either in progress, finished, or failed. A capture is only as complete as the window
it ran for: it does not reach back before it was started.

Playback needs a broker credential of its own, and that credential is delivered to it by the
platform. It is not minted by whoever presses the button, and it is not the credential of the gateway
whose traffic is being replayed -- so a playback cannot be mistaken, on the wire or in the historian,
for the machine it is imitating.

## Who can use it

Reading captures is open to the roles that can see plant history. Recording and deleting are
narrower. An Operator has no access to this page at all, which is why it is hidden from the rail
rather than shown as an empty table.
