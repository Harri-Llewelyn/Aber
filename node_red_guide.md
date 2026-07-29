# Node-RED Gateway Simulator Guide

This guide explains how Node-RED flows integrate with the **Factory+ Asset Tracking Platform** to simulate Sparkplug B edge gateway telemetry, and walks through onboarding a new device end-to-end.

---

## Overview & Simulator Tab

The flow [`node_red_flow.json`](./node_red_flow.json) provides the **Gateway Simulator** tab (labeled "Gateway Simulator" in the Node-RED editor):

- Self-contained, zero-dependency simulator.
- Publishes the full Sparkplug B lifecycle -- `NBIRTH`, `DBIRTH`, periodic `DDATA` (5s), `DDEATH`, and a periodic `NDATA` gateway heartbeat (30s) -- plus interactive **bonus test controls** (overheat alarm at `95°C` / reset to `42°C`) for exercising system alerts and UI state transitions.
- Every node group has an on-canvas comment node explaining what it does and, for the two most common new-user questions ("how do I add my own device?" and "why doesn't my gateway show as online?"), exactly what to do about it. Read those first if you're skimming the flow in the editor.

---

## Step 1 — Automated Flow Provisioning & Manual Import

> [!NOTE]
> When launching the stack via `docker compose up -d`, the `node-red-init` container automatically copies [`node_red_flow.json`](./node_red_flow.json) into Node-RED and configures credentials on startup. Manual import is not required for default container launches.

If you need to manually inspect, reset, or re-import the flow:

1. Open your Node-RED editor (`http://localhost:1880`).
2. Click the **☰ hamburger menu → Import**.
3. Select or paste the contents of [`node_red_flow.json`](./node_red_flow.json).
4. Click **Import** and **Deploy**.
5. The **"Gateway Simulator"** tab will appear in your workspace.

---

## Step 2 — Configure the MQTT Broker Node

Double-click the **"IoT Mosquitto Broker"** config node and set:

| Field       | Value                             |
|-------------|-----------------------------------|
| Server      | `mosquitto` (Docker service name) or `localhost` |
| Port        | `1883`                            |
| Client ID   | `node-red-simulator`              |
| Protocol    | MQTT v3.1.1                       |

---

## Step 3 — Sparkplug B Topic Structure & Lifecycle

Every message follows the same topic shape:

```text
spBv1.0/{GroupID}/{MessageType}/{EdgeNodeID}[/{DeviceID}]
```

`{EdgeNodeID}` and `{DeviceID}` are **Sparkplug IDs**, not names: a 3-character type prefix
(`gwy` for gateways, `dev` for devices) followed by 21 hex characters, 24 in total. The platform
issues one to every gateway and device, derived from its database id, and shows it on that
asset's page — click it to copy. It never changes, so the asset can be renamed freely without
breaking anything downstream.

The two ids used below (`gwy100000000000400080000` and `dev200000000000400080000`) belong to the
pre-seeded `Virtual_Gateway_NodeRED` row and this simulator's device. They are pinned in
migration `0009` precisely so this flow can hardcode them.

The simulator publishes, in order:

| Order | Message Type | Topic Example | Purpose |
|-------|--------------|----------------|---------|
| 1 | `NBIRTH` | `spBv1.0/FactoryPlus/NBIRTH/gwy100000000000400080000` | The edge node's own birth certificate, published once at startup, before any device birth. Real Sparkplug B requires this ordering; this app's ingestion treats `NBIRTH`/`NDATA` the same for gateway status, but the simulator sends it anyway for spec accuracy. |
| 2 | `DBIRTH` | `spBv1.0/FactoryPlus/DBIRTH/gwy100000000000400080000/dev200000000000400080000` | A device's birth certificate -- the metric names/types/config it will report. Re-sent every 60s so late-starting consumers still see it. |
| 3 | `DDATA` | `spBv1.0/FactoryPlus/DDATA/gwy100000000000400080000/dev200000000000400080000` | Streaming telemetry, every 5s. |
| 4 | `DDEATH` | `spBv1.0/FactoryPlus/DDEATH/gwy100000000000400080000/dev200000000000400080000` | Manually triggered -- marks the device offline. |
| 5 | `NDATA` | `spBv1.0/FactoryPlus/NDATA/gwy100000000000400080000` | Gateway heartbeat, every 30s. |

The JSON payload simulates a Sparkplug B DDATA message. `Asset_ID` repeats the device's Sparkplug
ID as a **cross-check** — the topic is what identifies the device, and if the two disagree the
device is quarantined rather than one of them silently winning. `Asset_Name` is a friendly label
for display only; the platform never overwrites its own record's name from it.

```json
{
  "timestamp": 1721399123456,
  "seq": 42,
  "metrics": [
    { "name": "Asset_ID",    "datatype": 12, "string_value": "dev200000000000400080000" },
    { "name": "Asset_Name",  "datatype": 12, "string_value": "Simulated_CNC_01" },
    { "name": "temperature", "datatype": 10, "double_value": 42.5 },
    { "name": "vibration",   "datatype": 10, "double_value": 1.35 },
    { "name": "status",      "datatype": 12, "string_value": "RUNNING" },
    { "name": "safety_ok",   "datatype": 11, "boolean_value": true }
  ]
}
```

> **Note:** This flow uses JSON-encoded payloads for simplicity. The ingestion engine (`ingestion/ingestion.py`) tries real Sparkplug B protobuf decoding first and falls back to this JSON encoding, so the simulator's messages are handled identically to a real device's once parsed. For **production Sparkplug B binary encoding**, install the `node-red-contrib-sparkplug-b` palette and replace the MQTT out node with a Sparkplug B encoder node.

---

## Step 4 — Onboard a New Device

To point this simulator at a device of your own, edit the **"Build DBIRTH Certificate"** and **"Build DDATA Telemetry"** function nodes (see the "ADD YOUR OWN DEVICE" comment node next to them on the canvas):

1. Register the device in the app's **Devices** tab and copy its issued **Sparkplug ID** (click the id to copy it).
2. Put that id in the topic's last path segment and in the `Asset_ID` metric of both the `DBIRTH` and `DDATA` nodes. The topic is authoritative; `Asset_ID` is a cross-check.
3. Set `Asset_Name` to whatever you want the device called. It is a label only.
4. Replace the metric list with your device's real telemetry (`name` / `datatype` / value field).
5. Deploy.

You can also skip step 1 and just invent a well-formed id — the device will land in the quarantine queue for approval, which is the zero-touch path below.

### If you mistype the ID

A device id that is the right shape but unknown is treated as a new discovery. One that is the
*wrong* shape — truncated, padded, or containing non-hex characters — is quarantined with a
message saying exactly what is wrong, e.g.:

> `MALFORMED_IDENTITY: device id 'devfffffffffffffffffff' is 23 characters; expected 24 ('dev' followed by 21 hex characters). The id is most likely truncated or padded in the gateway configuration — copy it again from the device's page in the dashboard.`

That distinction is the reason the format is fixed-width: a misconfigured gateway is diagnosable
rather than anonymous. Either way the device appears in the queue — it is never silently dropped.

## Step 5 — Complete the Loop: Approve the Quarantined Device

The first time a `DBIRTH` arrives for a Sparkplug ID Supabase doesn't recognize, the ingestion engine auto-inserts it into the `devices` table with `is_quarantined = true` -- and its `DDATA` telemetry is silently dropped until it's approved. This is intentional: it's the platform's zero-touch onboarding flow.

1. Open the app UI and go to the **Devices** tab.
2. Look for the **"Zero-Touch Onboarding Quarantine Queue"** section -- your new device will be listed there, showing the id it published under and why it was held.
3. As an **Administrator** or **Shopfloor_Manager**, click **Approve** (assigning it to a cell/gateway) or **Reject**.
4. Once approved, subsequent `DDATA` messages start flowing into the `TelemetryTab` / TimescaleDB.

The device keeps publishing under the id it announced; the platform records that on the row rather than demanding the device be reconfigured.

## Step 6 — Register the Gateway (for heartbeat tracking)

Unlike devices, **gateways are never auto-created**. Create a gateway via the **Gateways** tab, copy its issued Sparkplug ID, and publish `NBIRTH`/`NDATA` under that as the `{EdgeNodeID}`. Otherwise the heartbeats are logged as "unregistered edge node" and dropped -- the gateway will never show as `ONLINE` in the UI. This doesn't block device telemetry (devices auto-register independently), but it does mean gateway status/last-heartbeat tracking needs this one manual step.

The pre-seeded `Virtual_Gateway_NodeRED` row already exists with the pinned id `gwy100000000000400080000`, so the shipped flow works with no setup.

---

## Production Checklist

| Item | Recommendation |
|------|---------------|
| Binary Sparkplug B encoding | Install `node-red-contrib-sparkplug-b` |
| API Key security | Rotate the `API_KEY` env var in `docker-compose.yml` |
| MQTT Authentication | Enable username/password in `mosquitto.conf` |
| Poll interval | Adjust the Inject node repeat interval to match your scan rate |
| Real OPC-UA / Modbus devices | Use `node-red-contrib-opcua` or `node-red-contrib-modbus` in place of the simulator's Function nodes to talk to real field equipment |
