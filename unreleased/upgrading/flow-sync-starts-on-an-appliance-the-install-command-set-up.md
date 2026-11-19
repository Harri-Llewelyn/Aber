### From 1.9.0, flow sync starts on an appliance the install command set up

On a Remote gateway set up with the install command, the appliance's `flow-sync` service never
started. It restarted in a loop, logging *Cannot find module '/bundle/flow-sync.mjs'*. So a flow
approved in the forge never reached that appliance, its `appliance` branch got no reports, and the
drawer's convergence rows stayed empty. Telemetry was not affected.

The cause was the folder's permissions. `flow-sync` runs as user 1000, and it mounted the whole
`/opt/aber-gateway` folder, which the platform playbook makes root's with mode `0750`. It now mounts
only its own script. A bundle you copied by hand was usually not affected, because you own the
folder you copied.

Nothing needs doing before you upgrade. After the upgrade, each appliance fixes itself the next time
it converges to the new platform tag. That happens within about an hour, by its timer. To do it
straight away, run this on the appliance:

```bash
sudo systemctl start aber-gateway-converge
```

Within five minutes, `flow-sync` deploys any flow approved while it was down, and the gateway's
`appliance` branch gets its first report. To check it is running:

```bash
sudo docker logs --tail 20 aber-gateway-flow-sync
```
