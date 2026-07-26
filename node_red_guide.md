# Node-RED Gateway Simulator Guide

This guide explains how Node-RED flows integrate with the **IoT Asset Management API** to simulate Sparkplug B edge gateway telemetry using both static quick-start and dynamic pull-based discovery patterns.

---

## Overview & Simulator Tabs

The imported flow [`node_red_flow.json`](./node_red_flow.json) provides **two distinct tabs** designed for different testing scenarios:

1. **Gateway & OPC-UA Simulator Tab (Quick-Start Simulator)**:
   - Self-contained, zero-dependency simulator.
   - Publishes `DBIRTH`, periodic `DDATA` (5s), `DDEATH`, OPC-UA subflow streams, and interactive **overheat alert anomaly controls** (`95°C` alarm / `42°C` reset) for testing system alerts and UI state transitions.
2. **Dynamic Gateway Discovery Sim Tab (Pull-Based Discovery Simulator)**:
   - Polls `GET http://backend:8000/api/v1/gateways/Virtual_Gateway_NodeRED/config` every 15s.
   - Dynamically discovers assigned assets, splits them, and streams Sparkplug B `DDATA` telemetry.

```
[Inject / Timer] → [HTTP GET /config] → [Function: Extract Assets] → [Split] → [Build DDATA Payload] → [MQTT Out]
```

---

## Step 1 — Import the Flow

1. Open your Node-RED editor (`http://localhost:1880`).
2. Click the **☰ hamburger menu → Import**.
3. Paste the contents of [`node_red_flow.json`](./node_red_flow.json).
4. Click **Import** and deploy.
5. Both **"Gateway & OPC-UA Simulator"** and **"Dynamic Gateway Discovery Sim"** tabs will appear in your workspace.

---

## Step 2 — Configure the MQTT Broker Node

Double-click the **"IoT Mosquitto Broker"** config node shared across both tabs and set:

| Field       | Value                             |
|-------------|-----------------------------------|
| Server      | `broker` (Docker service name) or `localhost` |
| Port        | `1883`                            |
| Client ID   | `node-red-simulator`              |
| Protocol    | MQTT v3.1.1                       |

---

## Step 3 — How the Gateway Config Endpoint Works

In the **Dynamic Gateway Discovery Sim** tab, the **HTTP GET** node calls:

```http
GET http://backend:8000/api/v1/gateways/Virtual_Gateway_NodeRED/config
```

The response looks like:

```json
{
  "gateway": {
    "gateway_id": "Virtual_Gateway_NodeRED",
    "gateway_name": "Node-RED Virtual Edge Gateway",
    "ip_address": "127.0.0.1",
    "status": "ONLINE"
  },
  "assigned_assets": [
    {
      "asset_id": "Simulated_CNC_01",
      "asset_name": "CNC Precision Milling Machine 01",
      "asset_type": "CNC",
      "connection_method": "OPC-UA",
      "cell_name": "Assembly Line 1"
    }
  ]
}
```

This tells Node-RED **exactly which assets to simulate** dynamically without hardcoding asset IDs into the edge flow.

---

## Step 4 — Sparkplug B Topic Structure

For each asset in `assigned_assets`, the dynamic flow publishes to:

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

## Step 5 — Simulating an Asset Moving Gateways

1. In the **IoT Dashboard** (`http://localhost:3001`), navigate to the **Devices** tab.
2. Edit `Simulated_CNC_01` and change its **Active Edge Gateway** from `Virtual_Gateway_NodeRED` to another gateway (or set it to Unassigned).
3. On the next 15-second poll cycle, `/api/v1/gateways/Virtual_Gateway_NodeRED/config` will no longer include `Simulated_CNC_01` in `assigned_assets` — Node-RED automatically halts telemetry publication for that device.
4. Re-assigning `Simulated_CNC_01` back to `Virtual_Gateway_NodeRED` immediately resumes telemetry publishing on the next poll cycle.

This demonstrates the **asset-centric digital thread**: the asset's telemetry identity (`Simulated_CNC_01`) persists continuously in TimescaleDB regardless of which edge gateway currently routes its traffic.

---

## Step 6 — Posting Telemetry via HTTP (Alternative to MQTT)

If you prefer to skip MQTT and push telemetry directly via HTTP, use the `POST /api/v1/telemetry` endpoint. Requires the `X-API-Key` header:

```http
POST http://backend:8000/api/v1/telemetry
X-API-Key: iot-secret-key-change-me
Content-Type: application/json

[
  { "asset_id": "Simulated_CNC_01", "metric_name": "temperature", "val_double": 38.5 },
  { "asset_id": "Simulated_CNC_01", "metric_name": "status",      "val_string": "RUNNING" },
  { "asset_id": "Simulated_CNC_01", "metric_name": "safety_ok",   "val_bool": true }
]
```

In Node-RED, use an **HTTP Request** node with:
- **Method**: POST
- **URL**: `http://backend:8000/api/v1/telemetry`
- **Headers**: `X-API-Key: iot-secret-key-change-me`
- **Payload**: JSON array of telemetry entries

---

## Production Checklist

| Item | Recommendation |
|------|---------------|
| Binary Sparkplug B encoding | Install `node-red-contrib-sparkplug-b` |
| API Key security | Rotate the `API_KEY` env var in `docker-compose.yml` |
| MQTT Authentication | Enable username/password in `mosquitto.conf` |
| Poll interval | Adjust the Inject node repeat interval to match your scan rate |
| Real OPC-UA / Modbus | Replace the Function node with `node-red-contrib-opcua` or `node-red-contrib-modbus` |
