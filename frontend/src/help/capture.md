## What this page is for

Use this page to record what the broker actually carried, and play it back later. A capture is the raw traffic: birth certificates and the data that followed. Keep one so a fault can be examined after the machine has been fixed. Or use one to try a change against real plant behaviour rather than a guess.

## What the controls do

- **The Gateways and Devices tabs** choose what the list holds. You record one subject at a time. A gateway's capture holds everything it publishes, including every device beneath it. A device's capture holds that one device, plus its gateway's birth certificate. There is no capture of the whole broker.
- **The Stored filter** narrows the list to subjects with or without a capture. Use **the search box** to find a name or a Sparkplug ID. On the Devices tab, **the gateway filter** narrows the list to one gateway's devices.
- **The columns** are the subject, its Sparkplug ID and its Type (Remote, Host or Simulated). The last column is the one stored capture, with its messages, size and date. **UPLOADED** marks a file that was not recorded here. **NO BIRTH** marks a capture with no birth certificate in it.
- **Selecting a row**, by clicking it or pressing Enter on it, opens the details panel. It shows the recorded rate, the devices and metrics the capture holds, and the actions.
- **Record capture** asks for an optional note and a duration. **Record again** does the same, and replaces the stored capture. **Download** saves the file. **Delete capture** removes the capture and its file.
- **The upload zone** in the details panel stores a capture file recorded elsewhere, filed against the selected subject.
- **Play a file…**, at the top of the card, stores a capture file and goes straight on to playing it back. Dropping the file anywhere on the card does the same. If the file does not name its subject, **File it against** in the dialog names it.
- **The strips above the list** show a recording or a playback that is queued or running, on either tab. They also show one that has just failed. **Stop** ends a running recording early and keeps what it has recorded, or stops a running playback. Nothing shows there when nothing is in progress.
- **Play back…** is in the details panel of a subject with a stored capture. It publishes the capture as the **Playback gateway**, through the real broker and the real ingestion path. The capture's timestamps are shifted so it starts now.
- The playback dialog asks for the gateway, a **Device mapping** and a **Speed**. The mapping moves each captured device onto one of the Playback gateway's own **replay lane** devices. Nothing you can create is a replay lane, and nothing real is turned into one. So replayed traffic is always visibly not live traffic.

## What the states mean

A recording is **Queued** until the ingestion service picks it up. Then it is **Recording**, and then it is stored. A recording can also end **failed** or **cancelled**. Either shows here for fifteen minutes, or until you dismiss it.

A capture holds only the window it ran for. It does not reach back before it was started. It stops at the duration, 100,000 messages or 50 MiB, whichever comes first.

A capture with no birth certificate can still be played back. A metric sent by its full name plays back normally. But the devices are not announced, so they stay OFFLINE until they send a birth of their own. A metric sent by alias cannot be resolved without a birth certificate, so it is dropped. That is why **NO BIRTH** shows in warning colour on a capture that uses aliases.

Playback needs a broker credential of its own, for the Playback gateway. When that credential is issued, Aber delivers it to the playback worker within about a minute. It is not created by whoever presses the button. It is also not the credential of the gateway whose traffic is played back. So a playback cannot be mistaken for the machine it imitates, on the wire or in the historian.

If a playback completes but loses readings whose timestamps were too old for the historian, it says so above the list.

## Who can use it

Any role that can see plant history can read and download captures. Recording, replacing, playing back, uploading, stopping and deleting are for an Administrator or Shopfloor Manager only. Other roles see those controls disabled, and each one says who can use it. An Operator has no access to this page at all, so it is hidden from the sidebar rather than shown as an empty table.
