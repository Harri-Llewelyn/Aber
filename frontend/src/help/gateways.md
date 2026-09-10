## Summary

An edge gateway is what actually talks to machines and publishes their data to the broker. Every device in this stack arrives underneath one. This page is where gateways are created, enrolled, watched and taken out of service.

## What the controls do

- **Add a gateway** creates the platform record, and for an appliance the enrolment it then waits for. Nothing is installed from here.
- **The enrolment bundle** is what you carry to the machine. A remote gateway's broker credential is minted on the appliance itself and never travels through a browser -- which is why there is nothing to copy down here, and nothing that can be re-shown later.
- **Connected Devices** lists what has published underneath this gateway. It is the short route from "this gateway is quiet" to "and these six things went quiet with it".
- **Repository** opens this gateway's own repository in the forge, where its flow lives and where a change to it is proposed: commit the `flows.json` exported from the appliance's Node-RED editor on a branch and open a pull request. **Nothing is deployed until an administrator approves it** and it is merged to `main`, which the appliance then pulls. Administrators and Shopfloor Managers sign into the forge with their dashboard identity; nobody else holds a login there, so nobody else sees the link. Both may create further repositories in the `gateways` organisation, for a playbook a class of gateway is provisioned from -- those are not protected the way a gateway's own repository is until a gateway enrols under that name. Each gateway repository also has a **wiki**, for what a person needs to know and the appliance never reads: where it is, what it is wired to, who to call, what changed. It is edited directly and not reviewed, so nothing the appliance deploys belongs there. Its **issues** are the gateway's incident log: every repository starts with an **Incident** template that asks what happened, when, what the appliance was running, and what should change. The drawer's **Committed** row is where `main` is, reported by the forge on every push -- so a merge shows here at once, and the appliance deploys it on its next tick.
- **A host-run gateway has no repository.** Its connector runs in this stack's own Node-RED, and one instance can carry several host gateways -- so a `flows.json` is that whole instance rather than one gateway's. Edit those in the Node-RED editor.
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
