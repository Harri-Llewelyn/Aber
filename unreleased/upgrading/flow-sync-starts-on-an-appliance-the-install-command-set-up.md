### From 1.9.0, flow sync starts on an appliance the install command set up

On a Remote gateway set up with the install command, the appliance's `flow-sync` service never
started. It restarted in a loop, logging *Cannot find module '/bundle/flow-sync.mjs'*. So a flow
approved in the forge never reached that appliance, its `appliance` branch got no reports, and the
drawer's convergence rows stayed empty. Telemetry was not affected.

The cause was the folder's permissions. `flow-sync` runs as user 1000, and it mounted the whole
`/opt/aber-gateway` folder, which the platform playbook makes root's with mode `0750`. It now mounts
only its own script. A bundle you copied by hand was usually not affected, because you own the
folder you copied. A gateway first set up on 1.9.0 is not affected.

Nothing needs doing before you upgrade. The fix reaches an appliance when it converges to the
platform at `v1.9.0`. An appliance converges to the tag in its gateway's `platform.yml`, and only a
pull request moves that tag. An affected appliance cannot fetch the pull request, because `flow-sync`
is what fetches it, so it stays on the tag it enrolled with. After the upgrade, do this once for each
such gateway:

1. In the forge, change `tag` in the gateway's `platform.yml` to `v1.9.0` by pull request, and merge
   it. Do this first: without it, the appliance goes back to its old tag at the next converge, and
   `flow-sync` stops again.
2. On the appliance, set the tag it converges to until `flow-sync` has fetched, and converge:

   ```bash
   R=/var/lib/aber-gateway/data/gitops/repository.json
   sudo jq '.platform_tag = "v1.9.0"' "$R" > /tmp/repository.json
   sudo cp /tmp/repository.json "$R"
   rm /tmp/repository.json
   sudo systemctl start aber-gateway-converge
   ```

The converge installs the new compose file and starts `flow-sync`. Within five minutes, `flow-sync`
fetches the gateway's repository, deploys any flow approved while it was down, and the gateway's
`appliance` branch gets its first report. From then on the appliance takes its tag from
`platform.yml`, as every other does. To check it is running:

```bash
sudo docker logs --tail 20 aber-gateway-flow-sync
```
