## Summary

Record what the broker actually carried, and play it back later. A capture is the raw traffic -- birth
certificates and the data that followed -- kept so that a fault can be examined after the machine has been fixed, or so that a change can be tried against real plant behaviour rather than a guess.

## What the controls do

- **The Gateways and Devices tabs** choose what the list holds. Recording is per subject: a gateway (everything it publishes, every device beneath it included) or one device (plus its gateway's birth certificate). There is no whole-broker capture.
- **The Stored filter** narrows the list to subjects with or without a capture, **the search box** takes a name or a Sparkplug ID, and on the Devices tab **the gateway filter** narrows to one gateway's devices. The count beside the title reads `shown / total` while any of them is on.
- **The columns** are the subject, its Sparkplug ID, its Type (Remote, Host or Simulated), and the one stored capture with its messages, size and date. **UPLOADED** marks a file that was not recorded here, and **NO BIRTH** marks a capture with no birth certificate in it.
- **Selecting a row** opens the details panel: the recorded rate, the devices and metrics the capture holds, and the actions. **Record capture** (or **Record again**, which replaces the stored capture) asks for an optional note and a duration. **Download** saves the file. **Delete capture** removes it and its file.
- **The upload zones** store a capture file recorded elsewhere. The one in the details panel files it against the selected subject; the one on the Playback card stores it and goes straight on to playing it back. **File it against** in the dialog names the subject when the file does not.
- **Stop** finishes a running recording early and keeps what it has recorded, or stops a playback that is running.
- **Play back** publishes a stored capture through the real broker and the real ingestion path as the **Playback gateway**. The dialog asks for the gateway, a **Device mapping** that rewrites each captured device onto one of the Playback gateway's own **replay lane** devices, and a **Speed**. Nothing you can create is a replay lane, and nothing real is turned into one, so replayed traffic is visibly not live traffic.

## What the states mean

A recording is **Queued** until the ingestion daemon picks it up, then **Recording**, then stored; a recording can also end **failed** or **cancelled**, and either shows here for fifteen minutes until you dismiss it. A capture is only as complete as the window it ran for: it does not reach back before it was started, and it stops at whichever of the duration, 100,000 messages or 50 MiB comes first.

A capture with no birth certificate can still be played back. A metric sent by its full name plays back normally, though the devices are not announced and stay OFFLINE until they birth on their own. A metric sent by alias cannot be resolved without a birth certificate and is dropped, so the capture is marked **NO BIRTH** in warning colour when it uses aliases.

Playback needs a broker credential of its own for the Playback gateway, and the platform delivers it to the playback worker when the credential is issued, within about a minute. It is not minted by whoever presses the button, and it is not the credential of the gateway whose traffic is being played back -- so a playback cannot be mistaken, on the wire or in the historian, for the machine it is imitating. A playback that completes but loses readings whose timestamps were too old for the historian says so beside the card.

## Who can use it

Reading and downloading captures is open to the roles that can see plant history. Recording, playing back, uploading and deleting are narrower: Administrator and Shopfloor Manager. An Operator has no access to this page at all, which is why it is hidden from the rail rather than shown as an empty table.
