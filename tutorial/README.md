# Build your first machine

In about twenty minutes you connect one machine to Aber and watch its readings arrive. You create a
[cell](../docs/glossary.md#cell), a [gateway](../docs/glossary.md#gateway), a
[schema](../docs/glossary.md#schema) and a [device](../docs/glossary.md#device), then build a small
[Node-RED](../docs/glossary.md#node-red) flow that sends the device's readings. Every step is one you
would repeat for real hardware.

**You need** Aber running ([`docs/install.md`](../docs/install.md)) and an account that is an
`Administrator` or a `Shopfloor_Manager`. On a laptop, use the demo account `admin@aber.local` with
the password `aber123`. On a site, use the first administrator that `npm run setup` created.

**A new install is empty.** It has no cells, gateways, devices or schemas, Node-RED opens on an empty
editor, and Grafana's dashboards describe the platform rather than a shopfloor. The one gateway
listed is the **Playback gateway**, which replays recorded data. You can ignore it until you record
something.

| You will use | On a laptop | On a site |
| :--- | :--- | :--- |
| The dashboard | http://app.localhost | `https://app.<domain>` |
| The Node-RED editor | http://nodered.localhost | `https://nodered.<domain>` |
| Grafana | http://grafana.localhost | `https://grafana.<domain>` |

---

## The steps

### 1. Sign in to the dashboard

Sign in to the dashboard **before** you open Node-RED or Grafana. Both use your dashboard sign-in, so
they need it to exist first. Open all three at the addresses in the table above, not at
`npm run dev:forward`'s ports: each sign-in returns to the address it was set up for.

Creating things needs `Administrator` or `Shopfloor_Manager`. `Operator` and `Auditor` see read-only
pages, so a missing button means your role, not a fault.

### 2. Create a cell

Open **Cells** and choose **New Cell**. A cell is a place on your shopfloor, such as a line or a
bay, and it is how the dashboard groups and filters equipment. Name it after somewhere real.

You can skip this step. A device that has no single place, such as a building sensor or an AGV, can
be site-wide instead (`location_scope = 'site_wide'`). That is a deliberate choice, not missing data.

### 3. Create a gateway

Open **Gateways** and choose **New Gateway**. Set **Type** to **Host**: this gateway runs in Aber's
own Node-RED rather than on a computer of its own.

**Copy the Sparkplug ID it shows.** You don't choose it: it is `gwy` followed by 21 characters made
from the gateway's database id, and the broker accepts this gateway's messages only under that exact
id. Everything downstream keys on it.

**Aber never creates gateways by itself.** A message from a gateway it does not know is dropped, with
an *"unregistered edge node"* line in the ingestion log and nothing on screen. If nothing shows up
later, check this first.

### 4. Issue the gateway's broker password

Open the gateway's drawer by clicking its row, then choose **Generate Broker Credential**. Type the
gateway's name and choose **Issue Credential**. Copy the username and password it shows: you enter
them in Node-RED in step 7. If you lose them, an `Administrator` can show them again from the same
drawer (**Show Broker Credential**).

The order of steps 3 and 4 matters. The broker account's username is the gateway's Sparkplug ID, so
the gateway has to exist before its password can be issued.

**A Remote gateway works differently.** It runs on its own computer beside the machines. Its drawer
offers an install command to paste on a fresh Ubuntu machine, or a bundle for one that already has
Docker. That computer then sets itself up and gets its own password, which never passes through a
browser. [`docs/remote-gateways.md`](../docs/remote-gateways.md) covers it.

### 5. Create a schema

Open **Schemas** and choose **Build Schema from Catalog**. A schema says what a kind of device
sends: which [metrics](../docs/glossary.md#metric), of which type, meaning what. Each metric comes
from the catalog, which gives it a datatype, a unit and a standard identifier.

Create the schema before the device. Without one:

- Aber cannot tell you when the device sends something its model does not include.
- An [AAS](../docs/glossary.md#asset-administration-shell-aas) export of the device carries its
  nameplate and nothing else.
- The device's **Configuration Parameters** panel has nothing to show.

Pick metric names from the catalog rather than inventing them. A name the catalog does not have is
shown as plain text and exported without a standard identifier.

### 6. Create the device

Open **Devices** and choose **New Device**. Choose the gateway from step 3, the cell from step 2 and
the schema from step 5. **Copy the Sparkplug ID it shows**: `dev` followed by 21 characters, made the
same way as the gateway's.

You can skip this step too. Send messages under any well-formed `dev` id you make up, and the device
waits in [quarantine](../docs/glossary.md#quarantine) for you to approve it. See
[*Let a device arrive on its own*](#let-a-device-arrive-on-its-own), below.

### 7. Build the flow in Node-RED

Open the Node-RED editor. It starts empty. You need one connection to the broker, and enough
[Sparkplug B](../docs/glossary.md#sparkplug-b) messages for Aber to recognise the gateway and device:

1. Add an **mqtt-broker** node with Server `mosquitto` and Port `1883`.
2. On its **Security** tab, enter the username and password from step 4. Choose **Update**, then
   **Deploy**. Node-RED stores them encrypted, and they survive restarts.
3. Send an **NBIRTH** on `spBv1.0/<group>/NBIRTH/<gateway's Sparkplug ID>`.
4. Send a **DBIRTH** on `spBv1.0/<group>/DBIRTH/<gateway>/<device>`, carrying the metrics your schema
   lists.
5. Send a **DDATA** on that topic when a value changes, and an **NDATA** heartbeat every 30 seconds.

[*Messages and topics*](#messages-and-topics), below, shows each message.

If your site runs the broker with TLS, Node-RED moves the broker node onto TLS by itself the next time
it starts, so leave the server and port as they are. The broker accepts a gateway's messages only on
its own Sparkplug ID ([`mosquitto/README.md`](../mosquitto/README.md#broker-topic-authorisation)
says why).

### 8. Check that it worked

- On **Gateways**, the gateway turns `ONLINE` within one heartbeat.
- On **Devices**, the device appears with its readings arriving.
- The **Audit Trail** lists every step you just took. On a new install, that log is your own work
  and nothing else.

---

## Add more devices

A second device on a flow that already works is steps 6 and 7 again:

1. Create the device on **Devices**, and copy its **Sparkplug ID**.
2. Put that id at the end of the device's topics **and** in the `Asset_ID` metric of its `DBIRTH`
   and `DDATA`. The two must match, and the topic is what the broker checks.
3. Set `Asset_Name` to whatever you want the device called. It is a label, and nothing keys on it.
4. Give it the metrics its schema lists (`name`, `datatype` and the value field).
5. Deploy.

Or skip step 1 and make up a well-formed id: the device waits in the quarantine queue for approval.

### If you mistype the ID

An id of the right *shape* that Aber does not know is treated as a new device. An id of the wrong
shape (cut short, padded, or containing characters that are not hexadecimal) is quarantined with a
message saying exactly what is wrong:

> `MALFORMED_IDENTITY: device id 'devfffffffffffffffffff' is 23 characters; expected 24 ('dev'
> followed by 21 hex characters). The id is most likely truncated or padded in the gateway
> configuration — copy it again from the device's page in the dashboard.`

That is why the id has a fixed length: a mistyped one can be diagnosed. Either way, the device
appears in the queue. It is never dropped silently.

---

## Let a device arrive on its own

The first time a `DBIRTH` arrives for a Sparkplug ID Aber does not know, Aber adds the device as
quarantined and drops its `DDATA` until someone approves it. This is how a new device announces
itself, not an error.

1. Open **Devices**.
2. Find the **Quarantine queue**, the first card on the page. The device is listed with the id it
   used and why it was held.
3. As an `Administrator` or a `Shopfloor_Manager`, choose **Approve & Onboard** and pick its
   gateway, and optionally its cell. Or reject it.
4. Its next `DDATA` is stored.

The device keeps using the id it announced: Aber records that id rather than asking for the device
to be changed. Approval is a single database transaction (`public.approve_quarantined_device()`), so
it cannot half-complete, and the Audit Trail records who approved it.

---

## Messages and topics

Every message goes to a topic of this shape:

```text
spBv1.0/{GroupID}/{MessageType}/{EdgeNodeID}[/{DeviceID}]
```

`{EdgeNodeID}` and `{DeviceID}` are **Sparkplug IDs, not names**: `gwy` for a gateway or `dev` for a
device, followed by 21 hex characters, 24 in all. Aber issues one to every gateway and device and
shows it on that item's page, where you can click it to copy it. It never changes, so you can rename
anything without breaking it.

Nothing on a new install has an id yet, so the pair you send under is the pair the dashboard issued
in steps 3 and 6. That is why those steps come first.

The examples use `gwy120000000000400080000` and `dev220000000000400080000` in place of your two ids.
Use your own throughout.

| Order | Type | Topic | What it is for |
| :-- | :--- | :--- | :--- |
| 1 | `NBIRTH` | `spBv1.0/Aber/NBIRTH/gwy1200…` | The gateway announcing itself, once at startup and before any device does |
| 2 | `DBIRTH` | `spBv1.0/Aber/DBIRTH/gwy1200…/dev2200…` | The metric names, types and settings the device will report, before its first `DDATA` |
| 3 | `DDATA` | `spBv1.0/Aber/DDATA/gwy1200…/dev2200…` | Readings, sent **by exception**: only the metrics that changed |
| 4 | `DDEATH` | `spBv1.0/Aber/DDEATH/gwy1200…/dev2200…` | Marks the device offline |
| 5 | `NDATA` | `spBv1.0/Aber/NDATA/gwy1200…` | The gateway's heartbeat, at least every 30 s. A gateway silent for 90 s shows as STALE |

`Aber` is the [Sparkplug group](../docs/glossary.md#sparkplug-group) the development stack is
installed with (`values-dev.yaml`). A site chooses its own at install, as `ingestion.sparkplugGroup`,
and every topic above then carries that word instead.

### Send only what changed

**`DDATA` means "these metrics changed".** A flow reads its machine as often as it needs to, and
*sends* only what moved. Sending every metric on a timer, whether it moved or not, is not `DDATA`: it
writes a row per metric per tick for readings nobody took.

A metric counts as changed when it is analogue and has moved by at least its **deadband**, when it is
discrete and changed at all, or when it has no previous value yet (the first reading after a birth).
A `DBIRTH` that carries the device's *live* readings sets those previous values, so the birth
certificate is the starting point rather than placeholders the first `DDATA` has to correct.

**Set a deadband above the instrument's noise.** Noise bigger than the deadband counts as change on
its own, and nothing is held back.

**Still re-send every metric now and then.** A value that never changes looks the same as a device
that died quietly, and Aber marks a device OFFLINE after 300 s with no data
(`DEVICE_OFFLINE_TIMEOUT_SECONDS`). So re-send every metric at its last value well inside that. The
appliance's sample flow is the pattern to copy: its `publish by exception` node does all of the
above and re-sends every 120 s
([`appliance/README.md`](../forge/gateway-platform/appliance/README.md#the-sample-flow)).

Because an unchanged metric sends nothing, **a gap in a chart means *unchanged*, not *unknown*.**
Read these series through `telemetry_gapfill()` (see
[`../timescaledb/aggregates.sql`](../timescaledb/aggregates.sql)), which carries the last value
forward. Charting a rollup directly shows steady running as a hole.

### What a message carries

A `DDATA` payload carries **only the metrics that changed**, often just one. `seq` goes up by one per
message and wraps from 255 to 0. It is how Aber notices a lost message: a metric that stopped
arriving otherwise looks exactly like one that stopped changing.

**`seq` belongs to the gateway, not to the device.** Every publisher under one gateway shares it:
each of its devices, and the gateway's own heartbeat. An `NBIRTH` starts it again at zero. A
`DBIRTH` does not, and uses up a number like any other message.

> **Keep one counter per gateway, where every publisher can reach it.** In Node-RED, `context` belongs
> to one node, and inside a subflow `flow` belongs to that instance. So a subflow per device sends
> separate counters into one gateway's stream, which Aber reads as lost messages, asking for a rebirth
> several hundred times an hour. Keep the counter in `flow` when every publisher is on one tab, as the
> appliance's sample flow does, or in `global` under `seq_<edge node>` (the gateway's Sparkplug ID) when subflows publish.

`Asset_ID` and `Asset_Name` are **not** sent in `DDATA`. They are fixed, declared in `DBIRTH`, and
dropped before the readings are stored: the topic is what identifies the device. `DBIRTH` still
carries `Asset_ID` as a cross-check. If it disagrees with the topic, the device is quarantined rather
than one of them silently winning. (A real gateway's `DDATA` that uses metric aliases carries no
`Asset_ID` either, which is why the topic has to be the authority.)

```json
{
  "timestamp": 1721399123456,
  "seq": 42,
  "metrics": [
    { "name": "Systems/TEMPERATURE", "datatype": 10, "double_value": 47.5 }
  ]
}
```

> These examples use JSON payloads to keep them readable. Aber decodes real Sparkplug B (protobuf)
> first and falls back to JSON, so a JSON message is handled the same once read. For **production**,
> install the `node-red-contrib-sparkplug-b` palette and replace the MQTT out node with its Sparkplug
> B encoder.

---

## When it doesn't work

**The gateway never turns `ONLINE`.** Check that the gateway exists on **Gateways** and that the
flow sends under its Sparkplug ID. Messages from an unknown gateway are dropped, with only an
*"unregistered edge node"* line in the ingestion log. A registered device is also refused when its
messages arrive through a different gateway from the one it belongs to.

**Node-RED cannot connect to the broker.** These are the broker node's settings:

| Field | Value |
| :--- | :--- |
| Server | `mosquitto` (its name inside the cluster), or `localhost` from your own machine with `npm run dev:forward` |
| Port | `1883` (TCP) or `9001` (WebSocket); `8883` with TLS, which Node-RED switches to by itself when the broker uses TLS |
| Client ID | blank, so Node-RED makes one up, or a different one for each broker node: two connections with one id disconnect each other |
| Protocol | MQTT 5, which Node-RED is set to when it starts |
| Security | the username and password from step 4; the broker refuses anonymous connections |

Node-RED logs only a general `Connection failed to broker: <clientId>@<url>`, which names the
*client id*, not the username. Mosquitto's own log is not a reliable witness either: a connection
refused for a bad password has been seen with no matching line. So test from inside Node-RED's
container:

```bash
kubectl -n aber exec deploy/node-red -c node-red -- node -e "
  const mqtt=require('/usr/src/node-red/node_modules/mqtt');
  const c=mqtt.connect('mqtt://mosquitto:1883',{reconnectPeriod:0});
  c.on('connect',()=>{console.log('CONNECTED');c.end()});
  c.on('error',e=>{console.log('ERROR code='+e.code,e.message);c.end()});"
```

`code=5 Not authorized` means the username or password is wrong or missing: check the broker node's
Security tab, or issue a new password in step 4. If the Security tab is right and the broker still
refuses it, Node-RED may not be able to decrypt what it stored: check `settings.js`,
`_credentialSecret` and `flows_cred.json` on its data volume, in that order. A failure with no code
at all is a network or DNS problem instead.

**The editor signs in, then nothing works, or Deploy shows a padlock.** See
[`node-red/README.md`](../node-red/README.md#authentication), which explains how Node-RED's sign-in
is put together and what each part needs.

---

## Going to production

| Item | What to do |
| :--- | :--- |
| Binary Sparkplug B encoding | Install `node-red-contrib-sparkplug-b` |
| Broker passwords for gateways | Issued by the dashboard for a Host gateway (step 4), and by enrolment for a Remote one. `node scripts/mosquitto-provision-gateway.mjs <sparkplug_id>` only to reissue one by hand, for example when the credential service is down ([`mosquitto/README.md`](../mosquitto/README.md#broker-topic-authorisation)) |
| Remote gateways' operating systems | They follow the platform playbook at the tag each gateway's `platform.yml` names. Move the tag by pull request in the gateway's repository, one gateway first |
| Node-RED sign-in | Set up by default, through the dashboard's sign-in. Set `global.publicBaseDomain`, or `publicUrls.nodered`, to the address browsers actually use, or `/oauth/authorize` answers `invalid redirect_uri` |
| Platform broker passwords | Rotate the `secrets.mqtt*Password` values. Ingestion refuses to start without `secrets.mqttIngestionPassword` |
| Real OPC UA or Modbus devices | Use `node-red-contrib-opcua` or `node-red-contrib-modbus` in place of Function nodes |

---

## Related

- [`../docs/glossary.md`](../docs/glossary.md): the terms used here
- [`../docs/remote-gateways.md`](../docs/remote-gateways.md): gateways on their own hardware (the install command, the bundle, the forge, the playbook)
- [`../node-red/README.md`](../node-red/README.md): how Node-RED's editor and APIs are protected; [`../node-red/node-red-init.mjs`](../node-red/node-red-init.mjs) prepares it at every start
- [`../mosquitto/README.md`](../mosquitto/README.md): the broker's policy, its configuration ([`mosquitto.conf`](../mosquitto/mosquitto.conf)) and roles ([`dynsec-roles.json`](../mosquitto/dynsec-roles.json)), and which topics each gateway may use
- [`../ingestion/README.md`](../ingestion/README.md): how these messages are read and checked
- [`../supabase/README.md`](../supabase/README.md): quarantine approval and the Audit Trail
