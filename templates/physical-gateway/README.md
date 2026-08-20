# ACS-Cymru physical gateway — `__GATEWAY_NAME__`

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
5. generated the editor password and wrote its bcrypt hash into `settings.js`.

`node-red` then started against that configuration. Within about a minute the gateway shows
**ONLINE** in the dashboard.

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

## What this gateway is allowed to publish

The broker confines this appliance to `spBv1.0/+/+/<its own Sparkplug id>/#`.

A message published under any *other* edge node is **dropped by the broker without an error** —
`mosquitto_pub` exits 0, and nothing arrives. That is deliberate: it is what stops one gateway
forging another's telemetry, and it is enforced independently of anything in this flow. If a
message seems to vanish, check the edge-node segment of your topic first.

## Backing up your flow

Export `flows.json` from the Node-RED editor (**menu → Export → all flows**) and upload it on the
gateway's page in the dashboard.

**`flows_cred.json` is deliberately not part of a backup.** It is encrypted with the secret in this
`.env`; stored on the platform it would be either useless (without the secret) or dangerous (with
it). A restored appliance gets its credentials from a fresh enrolment, not from a backup.

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
