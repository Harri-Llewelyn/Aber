## What this page is for

Use this page to record what the broker actually carried, and play it back later. A capture is the raw traffic: birth certificates and the data that followed. Keep one so a fault can be examined after the machine has been fixed. Or use one to try a change against real plant behaviour rather than a guess.

## What the controls do

- **The Gateways and Devices tabs** choose what the list holds. You record one subject at a time. A gateway's capture holds everything it publishes, including every device beneath it. A device's capture holds that one device, plus its gateway's birth certificate. It records the device under its Sparkplug ID, its Published ID if it has one, and its UUID. There is no capture of the whole broker.
- **The search box** finds a name or a Sparkplug ID. **The Stored filter** beside it narrows the list to subjects with or without a capture. On the Devices tab, **the gateway filter** narrows the list to one gateway's devices.
- **The columns** are the subject, its Sparkplug ID and its Type (Remote, Third-party, Host or Simulated). The last column is the one stored capture, with its messages, size and date. **UPLOADED** marks a file that was not recorded here. **NO BIRTH** marks a capture with no birth certificate in it.
- **A column's heading sorts the table** by that column, on both tabs. Click it again to reverse the order, and a third time to go back to the usual order. A status sorts the most serious first, and an empty cell always sorts last. The page's address keeps the order, so a link or a reload shows the table the same way.
- **Selecting a row**, by clicking it or pressing Enter on it, opens the details panel. It shows how long the recording ran and why it stopped, the recorded rate, the devices and metrics the capture holds, and the actions.
- **Record capture** asks for an optional note and a duration. **Record again** does the same, and replaces the stored capture. **Download** saves the file. **Delete capture** removes the capture and its file. Deleting a gateway or device deletes its capture too.
- **The upload zone** in the details panel stores a capture file recorded elsewhere, filed against the selected subject. It is refused while that subject is being recorded. Upload again when the recording has finished.
- **Play a file…**, at the right-hand end of the toolbar on both tabs, stores a capture file and goes straight on to playing it back. Dropping the file anywhere on the card does the same. If the file does not name its subject, **File it against** in the dialog names it. Every device the file recorded must exist on this site. A file from another site is refused, and nothing is stored.
- **The strips above the list** show a recording or a playback that is queued or running, on either tab. They also show one that has just failed. **Stop** ends a running recording early and keeps what it has recorded, or stops a running playback. If the ingestion service has not reported on a recording for two minutes, Stop ends it and nothing from it is stored. Nothing shows there when nothing is in progress.
- **Play back…** is in the details panel of a subject with a stored capture. It publishes the capture as the **Playback gateway**, through the real broker and the real ingestion path. The capture's timestamps are shifted so it starts now.
- The playback dialog asks for the gateway, a **Device mapping** and a **Speed**. The Playback gateway is the only one a capture can be played back onto, and no one can mark another gateway as one. The mapping moves each captured device onto its own **replay lane** on that gateway. Playback refuses a real device, and it refuses the lane of a different device. So replayed traffic is always visibly not live traffic.

## What the states mean

A recording is **Queued** until the ingestion service picks it up. Then it is **Recording**, and then it is stored. A recording can also end **failed** or **cancelled**. Either shows here for fifteen minutes, or until you dismiss it. A device that sent nothing during its recording fails it, and its stored capture is kept. The failure names the IDs the recording listened for. Compare them with the ID the device publishes under.

A capture holds only the window it ran for. It does not reach back before it was started. It stops at the duration, 100,000 messages or 50 MiB, whichever comes first. If a cap stopped it before the duration was up, the details panel says it was cut short.

A capture with no birth certificate cannot be played back. A playback starts the way a gateway's own session does, with its birth certificate, so it refuses a capture without one. **NO BIRTH** marks such a capture in warning colour. Record it again to replace it: recording asks the gateway to send its birth certificate. A playback also leaves out anything recorded before that birth certificate, and a device's messages before its own.

Playback needs the playback worker, which every install runs. If the playback dialog says the worker is not deployed, set `playback.enabled: true` in the site's Helm values and upgrade the release. Until then a playback cannot start.

Playback also needs a broker credential of its own, for the Playback gateway. When that credential is issued, Aber delivers it to the playback worker within about a minute. It is not created by whoever presses the button. It is also not the credential of the gateway whose traffic is played back. So a playback cannot be mistaken for the machine it imitates, on the wire or in the historian. If delivery fails, the credential dialog says how to set the password in the Helm values instead. The worker then uses that password whenever the broker refuses the delivered one, and the playback dialog says which one it uses.

A playback waits for the ingestion service before it publishes anything. If ingestion stops while a playback runs, the playback stops too and says how far it got. Start it again once ingestion is back. If the broker connection drops, for example because the Playback gateway's credential was issued again, the playback fails the same way.

A playback you stop shows above the list as stopped, with how many messages went out. It is not a failure.

If a playback completes but loses readings whose timestamps were too old or too far in the future for the historian, it says so above the list. A slow playback speed can cause this. It stretches the gap between a reading's timestamp and its arrival. Try the playback again at 1x.

## Who can use it

Any role that can see plant history can read and download captures. Recording, replacing, playing back, uploading, stopping and deleting are for an Administrator or Shopfloor Manager only. Each of these acts, downloads included, is recorded in the Audit Trail with who did it. Other roles see those controls disabled, and each one says who can use it. An Operator has no access to this page at all, so it is hidden from the sidebar rather than shown as an empty table.
