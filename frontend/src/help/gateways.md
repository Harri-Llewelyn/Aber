## Summary

An edge gateway is what actually talks to machines and publishes their data to the broker. Every device in this stack arrives underneath one. This page is where gateways are created, enrolled, watched and taken out of service.

## What the controls do

- **Add a gateway** creates the platform record, and for an appliance the enrolment it then waits for. Nothing is installed from here.
- **The enrolment bundle** is what you carry to the machine. A remote gateway's broker credential is minted on the appliance itself and never travels through a browser -- which is why there is nothing to copy down here, and nothing that can be re-shown later.
- **Connected Devices** lists what has published underneath this gateway. It is the short route from "this gateway is quiet" to "and these six things went quiet with it".
- **Propose a flow** is where a `flows.json` exported from a remote appliance goes. It opens a pull request in that gateway's own repository, and **nothing is deployed until somebody approves it** -- so it is both the copy that survives a failed SD card and the request to change what the appliance runs. Operators may propose; approving is a separate authority. This replaced the flow-backup panel, which kept a copy and nothing else: no diff, no history, and nobody reviewing it.
- **A host-run gateway cannot be proposed for.** Its connector runs in this stack's own Node-RED, and one instance can carry several host gateways -- so a `flows.json` is that whole instance rather than one gateway's, and approving one would replace the others. Edit those in the Node-RED editor.
- **The Node-RED link** opens the flow editor on the gateway itself, in a new tab. It is a real link -- middle-click and copy-link work -- because the usual next step is sending it to whoever owns the appliance.

## What the states mean

- **PENDING_ENROLLMENT** -- created here; the bundle has not been applied on the appliance yet.
- **AWAITING_BIRTH** -- enrolled and connected, but it has not announced itself.
- **ONLINE** -- heartbeat current.
- **STALE** -- the stored status still says online, but the last heartbeat is older than 90 seconds. This is worked out when you look rather than written down, so it is true at the moment you read it.
- **OFFLINE** -- no heartbeat and not mid-enrolment. This one is a fault.
- **Archived** -- decommissioned on purpose, and left out of the attention signal for that reason.

**Type** says where the gateway runs and how far to trust its numbers. **Remote** runs on its own hardware out on the plant network. **Host** is a connector inside this stack, with nothing to install and no appliance to enrol. **Simulated** is host-run and its readings are generated rather than observed. **Shadow** belongs to playback and is not something you create.

A certificate within 30 days of expiry is called out in the gateway's drawer. That warning is the only notice before the appliance stops being able to connect.
