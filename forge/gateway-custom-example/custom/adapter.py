"""An example adapter: read a machine, hand the readings to Node-RED, hold no credential.

Replace `read_machine()` with whatever the machine actually speaks -- serial, Modbus, OPC-DA, a
vendor SDK. Everything else here is the shape the platform expects and is worth keeping.

WHY THIS PUBLISHES TO NODE-RED AND NOT TO THE BROKER. The appliance holds exactly one Sparkplug
credential, and it is confined to this gateway's edge node. An adapter with its own broker
connection would be a second credential to issue at enrolment and revoke on archive, and the
platform has three revocation handles rather than four by design. So this posts locally over the
appliance's own compose network and Node-RED republishes on the connection it already holds:
schema conformance, quarantine and per-gateway confinement all keep meaning what they say.

A workload that genuinely needs its own identity is a second gateway, and should enrol as one.
"""
import json
import os
import random
import time
import urllib.error
import urllib.request

NODE_RED_URL = os.environ.get("NODE_RED_URL", "http://node-red:1880/custom/readings")
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "5"))

# The device this adapter speaks for. It arrives in Node-RED as a name and reaches the dashboard's
# quarantine queue on its first DBIRTH; nothing is pre-registered.
DEVICE_ID = os.environ.get("DEVICE_ID", "legacy-press-01")


def read_machine():
    """One reading from the machine. Replace this; everything else can stay.

    A real implementation opens the port once and keeps it, rather than per poll: an adapter that
    reconnects every few seconds is indistinguishable at the machine from one that is failing.
    """
    return {"Temperature": round(20 + random.random() * 5, 2), "CycleCount": int(time.time()) % 10000}


def publish(metrics):
    """Hand one reading to Node-RED. A failure here is logged and never fatal."""
    body = json.dumps({"device_id": DEVICE_ID, "timestamp": int(time.time() * 1000), "metrics": metrics})
    request = urllib.request.Request(
        NODE_RED_URL, data=body.encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status


def main():
    print(f"adapter: reading {DEVICE_ID} every {POLL_SECONDS}s, posting to {NODE_RED_URL}", flush=True)
    while True:
        try:
            publish(read_machine())
        except (urllib.error.URLError, OSError) as err:
            # NOT FATAL, AND THE CONTAINER MUST NOT EXIT. Node-RED restarts on its own convergence
            # and is briefly absent when it does; an adapter that died for that would need a visit,
            # and `restart: unless-stopped` would hide the real fault behind a restart loop.
            print(f"adapter: could not reach Node-RED ({err}); retrying next poll", flush=True)
        except Exception as err:  # noqa: BLE001 -- the machine is the unpredictable half
            print(f"adapter: could not read {DEVICE_ID} ({err}); retrying next poll", flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
