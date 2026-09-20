# ACS-Cymru Remote gateway — `__GATEWAY_NAME__`

This folder turns a machine on your shopfloor into a gateway for the ACS-Cymru platform. It runs
Node-RED in Docker, enrols itself on first boot, and publishes Sparkplug B over MQTTS.

## Before you start

- Docker and the Compose plugin on the appliance.
- A network route from the appliance to the platform (HTTPS) **and** to the broker on **8883**.
- **The enrolment token in `.env` expires 30 minutes after the bundle was generated, and is
  single-use.** If it lapses, generate a new bundle from the gateway's page in the dashboard —
  nothing here needs deleting first.

## Run it

```bash
docker compose up -d
docker compose logs bootstrap
```

The second command prints the **Node-RED editor password**. It is shown **once** and is not stored
anywhere in plaintext. Write it down before you close the terminal.

Then open `http://<this-appliance>:1880` and sign in as `admin`.

## What just happened

`bootstrap` ran once and did the following, in order:

1. exchanged the token for a **broker account of this gateway's own** — the platform generated the
   password, and it is not recoverable from either side afterwards;
2. wrote the broker's **CA certificate** to `/data/certs/ca.crt`, so this appliance *verifies* the
   broker rather than trusting whatever answers on port 8883;
3. wrote the sample flow with this gateway's Sparkplug identity substituted in;
4. wrote the broker password into `flows_cred.json`, **encrypted** with the secret in `.env`;
5. generated the editor password and wrote its bcrypt hash into `settings.js`;
6. generated this appliance's **own SSH keypair** and registered the public half against this
   gateway's repository in the forge. The key can pull `main`, which is what was approved, and push
   `appliance`, which is what is running; `main` and every other branch refuse it, so the appliance
   can report and can never author what it will be asked to deploy;
7. wrote the **forge's SSH host key** to `/data/gitops/known_hosts`, which arrived in the enrolment
   response. That is what lets `flow-sync` *verify* the forge rather than trusting whatever answers
   on the SSH port — the same decision as the broker CA in step 2, one credential plane along.

`node-red` then started against that configuration, and `flow-sync` began watching for approved
flows. Within about a minute the gateway shows **ONLINE** in the dashboard.

## What this appliance reports to the forge

Every five minutes `flow-sync` also pushes what is running to the `appliance` branch of this
gateway's repository: `flows.json` exactly as Node-RED is running it, and `deployed.json`, the
record of what was last deployed and from which commit. Nothing else is ever committed, and
`flows_cred.json` never will be. The branch is append-only and only this appliance's key can write
it, so it is the record that survives a decommission; the forge's compare view between `main` and
`appliance` is the diff between what was approved and what is running, and the dashboard links it
from the gateway's drawer. An edit made in this appliance's editor shows there as **edited on the
appliance** until the next approved deploy overwrites it.

## The sample flow

Two things, both meant to be replaced by your own work:

- **a heartbeat every 30 seconds**, which is what keeps this gateway reported ONLINE. Leave it, or
  replace it with something that beats at least as often — the dashboard calls a gateway `STALE`
  after 90 seconds of silence.
- **`▶ ADD YOUR OWN DEVICE`**, an inject node that publishes a birth certificate for a device the
  platform has never heard of.

That second one is worth understanding, because it is the whole onboarding model:

> You do not pre-register devices. A device announces itself with a `DBIRTH`, the platform puts it
> in a **quarantine queue** and drops its data, and an operator approves it in the dashboard. Only
> then is its telemetry stored.

Click the inject node, then look at **Devices → quarantine** in the dashboard. Edit `DEVICE_ID` in
the function node to name your actual machine.

## What this appliance reports about itself

Every 30s the heartbeat carries a handful of facts about the appliance, so "what is that gateway
actually doing" is answerable from the dashboard instead of by getting a shell on it:

| Reported | From |
| :--- | :--- |
| uptime | the Node-RED runtime's own start |
| 1-minute load, available memory, free disk on `/` | `node_exporter`, polled locally |
| bundle version | recorded by `bootstrap` at enrolment |
| flow hash | `/data/gitops/deployed.json`, written by `flow-sync` after every deploy and by `bootstrap` for the enrolment flow |
| broker root expiry | `/data/certs/ca.json`, written by `bootstrap` for the root enrolment installed and by `acs-gateway-converge` for every bundle the platform publishes afterwards |

**`node_exporter` runs here and is never scraped from the centre.** It has no published port. The
platform's Prometheus does not reach into plants: this appliance dials out to the broker and
nothing assumes traffic the other way, gateways enrol dynamically so a static scrape config could
not know them, and an inbound path per gateway is the thing an outbound-only design exists to
avoid. The flow polls it over the appliance's own Docker network and republishes three series on
the MQTT connection it already holds.

**A collector that is down costs three metrics, never the heartbeat.** The poll runs on its own
timer and writes to a cache that the heartbeat reads. Wiring it into the heartbeat would let a slow
disk read stop the gateway reporting ONLINE — which is a worse failure than any it measures.
Readings go stale after five minutes and are then omitted rather than repeated, so a number on the
dashboard is always one this appliance really took.

**The root's expiry is the one that earns its place.** Re-issuing the broker's root does not fail
loudly — it succeeds, and every appliance still holding the old one drops off at once with no
signal but absence. Reporting the date *this* appliance holds turns the worst fleet-wide failure
into a dated warning, and after a re-issue it is also how the platform says which appliances have
been given the new root and which have not.

**The root follows the bundle, not the enrolment.** `acs-gateway-converge` reads
`trust/ca-bundle.pem` from `main` of the platform repository on every pass, tries each root in it
against the broker this appliance actually dials, and installs the bundle only if one of them
verifies. Then it writes `/data/certs/ca.json` and restarts Node-RED, which is what makes the
reported date move. A bundle that verifies nothing is refused and recorded; this appliance keeps
the root it has.

## What this gateway is allowed to publish

The broker confines this appliance to `spBv1.0/+/+/<its own Sparkplug id>/#`.

A message published under any *other* edge node is **dropped by the broker without an error** —
`mosquitto_pub` exits 0, and nothing arrives. That is deliberate: it is what stops one gateway
forging another's telemetry, and it is enforced independently of anything in this flow. If a
message seems to vanish, check the edge-node segment of your topic first.

## Changing this appliance's flow

Export `flows.json` from the Node-RED editor (**menu → Export → all flows**) and drop it on the
gateway's page in the dashboard, under **Propose a flow**. That opens a pull request in this
gateway's own repository. **Nothing reaches this appliance until somebody approves it** — and once
they do, `flow-sync` pulls it within five minutes and reloads Node-RED. The commit is also the copy
that survives a failed SD card, so there is no separate backup step.

**Export from *this* appliance, and never re-import a flow into an editor that already holds it.**
Node-RED keys credentials by node id. The editor's **Import copy** option re-ids every node, and a
flow whose broker node has a new id would authenticate with an empty username — the broker refuses
it and the editor reports only *"Connection failed to broker"*. `flow-sync` refuses to deploy such
a commit for exactly that reason, and names the offending node in its log:

```
docker compose logs flow-sync
```

**`flows_cred.json` is deliberately never committed.** It is encrypted with the secret in this
`.env`; stored anywhere else it would be either useless (without the secret) or dangerous (with it).
A rebuilt appliance gets its credentials from a fresh enrolment, not from the repository.

**If `flow-sync` says it is refusing to sync**, read the reason. `known_hosts does not exist` means
the forge had not published its host key when this appliance enrolled — restart the forge and
re-enrol. There is deliberately no option to skip that check.

## Troubleshooting

**`bootstrap` exits with "the enrolment token was refused"** — the token is expired or already
used. Tokens are single-use: if you have run this bundle before, even unsuccessfully at a later
step, it is spent. Generate a new bundle.

**`bootstrap` retries and then gives up** — the appliance cannot reach the platform. The token was
*not* consumed; fix the route and `docker compose up` again with this same bundle.

**Node-RED starts but the broker node stays disconnected** — almost always one of three things:

- the appliance cannot reach `<broker>:8883` (check a firewall between the shopfloor and the
  platform);
- the platform's broker certificate does not name the address you are dialling. It must carry that
  hostname or IP in its SAN, which is set by `MQTT_PUBLIC_HOST` on the platform;
- the credential was issued but the broker had not reloaded yet. It retries on its own; give it a
  couple of minutes before assuming otherwise.

**You lost the editor password**

```bash
docker compose run --rm bootstrap node /bundle/bootstrap.mjs --reset-admin-password
docker compose restart node-red
```

This keeps the enrolment, the flow and the broker credential — it only rewrites `settings.js`.

## Starting over

```bash
docker compose down -v      # destroys /data, and with it this appliance's enrolment
```

The token in `.env` is already spent, so a fresh start needs a **new bundle** from the dashboard.
