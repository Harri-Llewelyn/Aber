# Node-RED Gateway Simulator Guide

This guide explains how Node-RED flows integrate with the **Factory+ Asset Tracking Platform** to simulate Sparkplug B edge gateway telemetry.

---

## Overview & Simulator Tab

The flow [`node_red_flow.json`](./node_red_flow.json) provides the **Gateway & OPC-UA Simulator Tab (Quick-Start Simulator)**:
- Self-contained, zero-dependency simulator.
- Publishes `DBIRTH`, periodic `DDATA` (5s), `DDEATH`, OPC-UA subflow streams, and interactive **overheat alert anomaly controls** (`95°C` alarm / `42°C` reset) for testing system alerts and UI state transitions.

---

## Step 1 — Automated Flow Provisioning & Manual Import

> [!NOTE]
> When launching the stack via `docker compose up -d`, the `node-red-init` container automatically copies [`node_red_flow.json`](./node_red_flow.json) into Node-RED and configures credentials on startup. Manual import is not required for default container launches.

If you need to manually inspect, reset, or re-import the flow:
1. Open your Node-RED editor (`http://localhost:1880`).
2. Click the **☰ hamburger menu → Import**.
3. Select or paste the contents of [`node_red_flow.json`](./node_red_flow.json).
4. Click **Import** and **Deploy**.
5. The **"Gateway & OPC-UA Simulator"** tab will appear in your workspace.

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

## Step 3 — Sparkplug B Topic Structure

The simulator flow publishes to:

```
spBv1.0/{GroupID}/DDATA/{GatewayID}/{AssetID}
```

**Example:** `spBv1.0/FactoryPlus/DDATA/Virtual_Gateway_NodeRED/Simulated_CNC_01`

The JSON payload simulates a Sparkplug B DDATA message with the required `Asset_ID` metric embedded:

```json
{
  "timestamp": 1721399123456,
  "seq": 42,
  "metrics": [
    { "name": "Asset_ID",    "datatype": 12, "string_value": "Simulated_CNC_01" },
    { "name": "temperature", "datatype": 10, "double_value": 42.5 },
    { "name": "vibration",   "datatype": 10, "double_value": 1.35 },
    { "name": "status",      "datatype": 12, "string_value": "RUNNING" },
    { "name": "safety_ok",   "datatype": 11, "boolean_value": true }
  ]
}
```

> **Note:** This flow uses JSON-encoded payloads for simplicity. For **production Sparkplug B binary encoding**, install the `node-red-contrib-sparkplug-b` palette and replace the MQTT out node with a Sparkplug B encoder node.

---

## Production Checklist

| Item | Recommendation |
|------|---------------|
| Binary Sparkplug B encoding | Install `node-red-contrib-sparkplug-b` |
| API Key security | Rotate the `API_KEY` env var in `docker-compose.yml` |
| MQTT Authentication | Enable username/password in `mosquitto.conf` |
| Poll interval | Adjust the Inject node repeat interval to match your scan rate |
| Real OPC-UA / Modbus | Replace the Function node with `node-red-contrib-opcua` or `node-red-contrib-modbus` |

