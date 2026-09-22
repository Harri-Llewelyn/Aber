"""
The Directory's MQTT half: the same answers `fplus-directory` serves over HTTP, on a broker topic.

=================================================================================================
WHAT THIS IS, AND THE ONE THING IT DELIBERATELY IS NOT
=================================================================================================

`supabase/functions/fplus-directory/index.ts` answers the Factory+ Directory's read contract over
HTTP by PROJECTING the tables this platform already has. This publishes the same projection to a
well-known MQTT topic, for the consumer that has a broker connection and no HTTP client -- which is
the shape most Factory+ edge components actually have.

IT DOES NOT BUILD A REGISTRY OUT OF BIRTH CERTIFICATES, and that refusal is the substance of this
file rather than an omission from it. Issue #64's first implementation step was to have this daemon
write dynamic topic bindings as NBIRTH and DBIRTH arrive. That would move the Directory from
DERIVING addresses out of the enrolment record to ACCUMULATING them from what devices claim about
themselves -- and this stack's standing rule is that a self-declared marker is not evidence (see
"Schema Conformance" in ingestion/README.md, and `verify_gateway_binding()` in ingestion.py, which
exists because a device asserting its own identity is exactly what cannot be trusted).

The practical difference is not subtle. A device that has never been enrolled can publish a DBIRTH;
under the accumulating design it would appear in the Directory as a resolvable address, and every
downstream consumer would treat the platform as having vouched for it. Under this design it appears
in `devices` as a QUARANTINED row -- which the Directory does report, flagged, because it exists on
the wire -- and nothing about it is presented as an address the platform stands behind.

So the daemon is the right HOME for this (it holds the broker connection and a Supabase identity
already), and the birth stream it is sitting on is deliberately not the SOURCE.

=================================================================================================
THE PROPERTY THAT CANNOT SURVIVE THE MOVE TO MQTT, SAID OUT LOUD
=================================================================================================

`fplus-directory` reads as the CALLER, not as the service role, and has no
`SUPABASE_SERVICE_ROLE_KEY` in its registry entry -- because a Directory is a live read over the
whole address space, and the service key would hand every authenticated user a view their RLS
policies do not grant them.

A TOPIC HAS NO CALLER. Whatever is published is published once, and every subscriber the broker
admits reads the same bytes. The per-caller property is therefore not portable, and pretending
otherwise would be the quiet drop the roadmap entry warned against. Two things follow, and both are
load bearing:

  1. THIS IS OFF BY DEFAULT (`DIRECTORY_MQTT_ENABLED`). Publishing the whole address space to a
     topic is an exposure decision that belongs to a deployment, not to a default -- the same
     answer `ingress.routes.studio` gives for publishing the Studio console.

  2. THE BROKER ACL IS THE ONLY ACCESS CONTROL, and the broker's roles grant read on this subtree to
     the two principals that already hold `spBv1.0/#` -- ingestion and i3X -- and to no gateway.
     A gateway is confined to its own edge node's subtree precisely so it cannot enumerate the
     site; handing it the Directory would undo that in one line. A deployment that wants a headless
     Factory+ subscriber adds the account and the rule, deliberately.

WHAT IS READ IS ALSO BOUNDED, which is the third answer and the least visible. These queries run as
`Service_Ingestor` -- an Operator principal that cannot write a row directly -- so the documents
below can never contain more than that identity's own RLS grants. It is one principal instead of
every caller, but it is the narrowest one on the stack rather than the widest.

=================================================================================================
WHOLE DOCUMENTS, RETAINED, ON FOUR TOPICS
=================================================================================================

One retained document per COLLECTION -- not one topic per device. A per-entity topic tree is the
obvious shape and it is a trap: retained messages outlive the thing they describe, so deleting a
device would leave its address on the broker until something remembered to publish an empty payload
over it. Nothing here would remember, and the failure is silent and permanent. Four documents,
republished whole on a timer, cannot go stale in that direction: a device that disappears from the
database disappears from the next document.

RETAINED, so a subscriber connecting between passes gets the current answer immediately rather than
waiting up to `DIRECTORY_MQTT_INTERVAL_SECONDS` for one -- which is the same reason Sparkplug uses
STATE retained and the same reason this is not simply a change-notify stream.

AND THE QUALIFICATION TRAVELS ON ALL FOUR. `namespace: "local"` and the note say that these UUIDs
are this deployment's own `schemas.id` and `directory_services.id` values, not registered Factory+
identifiers. Over HTTP that note is attached by the schema and service routes; on a topic there is
no route, no status code and no documentation page next to the bytes -- a headless subscriber has
only the payload. So every document carries it, including the device one, whose `schemas` array is
made of exactly those locally minted identifiers.

`LOCAL_SCHEMA_NOTE` is MIRRORED from the TypeScript constant of the same name and checked by
`scripts/check-mirror-drift.mjs`. Two surfaces wording the same qualification differently is how it
stops being a qualification.
"""

import json
import os
import threading
import time

from logging_config import get_logger

# `get_logger`, not `logging.getLogger(__name__)` -- see the long note in capture_worker.py. A
# module logger made the standard-library way has no handler here and its INFO lines vanish, which
# would make a publisher that is quietly failing indistinguishable from one nobody switched on.
logger = get_logger("ingestion")

# -------------------------------------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------------------------------------
# OFF BY DEFAULT. See the header: this is an exposure decision, and a default that publishes the
# whole address space would be making it on the deployment's behalf.
DIRECTORY_MQTT_ENABLED = os.getenv("DIRECTORY_MQTT_ENABLED", "").strip().lower() in (
    "1", "true", "yes", "on",
)

# NOT UNDER `spBv1.0/`. That tree belongs to Sparkplug and the broker's roles confine every gateway
# inside it by pattern; a Directory document is not a Sparkplug message and must not arrive looking
# like one. A separate root also means the broker's default-deny covers this subtree until a rule
# is written for it, rather than the per-gateway pattern accidentally granting something.
#
# Derived from the site's group when the chart leaves the prefix empty, which is what makes the
# broker grant and this publisher one value: the reconcile grants `<prefix>/#` from the same
# rendered string.
DIRECTORY_MQTT_TOPIC_PREFIX = os.getenv(
    "DIRECTORY_MQTT_TOPIC_PREFIX",
    "%s/Directory/v1" % os.getenv("SPARKPLUG_GROUP", "Aber"),
).strip().rstrip("/")

DIRECTORY_MQTT_INTERVAL_SECONDS = int(os.getenv("DIRECTORY_MQTT_INTERVAL_SECONDS", "60"))

# The service identity the HTTP half reports from `/ping`, repeated here so a subscriber can tell
# what it is talking to without holding an HTTP client -- which is the whole reason this exists.
SERVICE_NAME = "fplus-directory"
SERVICE_VERSION = "1.0.0"
FACTORYPLUS_PAYLOAD_UUID = "11ad7b32-1d32-4c4a-b0c9-fa049208939a"

# MIRRORED. Keep in step with LOCAL_SCHEMA_NOTE in supabase/functions/fplus-directory/index.ts;
# scripts/check-mirror-drift.mjs compares the two.
LOCAL_SCHEMA_NOTE = "Locally minted schema identifiers, not registered Factory+ Schema_UUIDs."
LOCAL_SERVICE_NOTE = "Stack service endpoints, not registered Factory+ Service_UUIDs."

_DEVICE_COLUMNS = (
    "id,name,sparkplug_id,status,is_quarantined,gateway_id,"
    "gateways(sparkplug_id,sparkplug_group)"
)


def _device_entry(row):
    """
    Project one `devices` row onto a Directory entry.

    MIRRORS `deviceEntry()` in the edge function, field for field, including the two decisions that
    look like bugs and are not: an unbound device reports EMPTY STRINGS rather than omitting its
    address, so a subscriber destructuring the object never has to special-case the shape; and a
    QUARANTINED device is present, flagged, because it exists on the wire and a consumer meeting its
    traffic needs to be able to look it up. The flag is what says why its telemetry is not stored.
    """
    gateway = row.get("gateways") or {}
    return {
        "uuid": row.get("id"),
        "name": row.get("name") or "",
        "address": {
            "group_id": gateway.get("sparkplug_group") or "",
            "node_id": gateway.get("sparkplug_id") or "",
            "device_id": row.get("sparkplug_id") or "",
        },
        "online": row.get("status") == "ONLINE",
        "quarantined": bool(row.get("is_quarantined")),
        "schemas": [],
    }


def _attach_schemas(supabase, entries):
    """
    Fill in each entry's `schemas` from the `device_schemas` VIEW.

    THE VIEW, NOT `device_submodels`. The view unions the join table with the legacy 1:1
    `devices.schema_id`, and reading the join table alone would report "no schema" for every device
    provisioned the old way -- which is exactly the population an unfinished migration leaves
    behind. The edge function reads the view for the same reason, and the two answers have to agree
    or the same device describes itself differently depending on which surface asked.

    ONE query for the whole fleet, not one per device.
    """
    if not entries:
        return entries

    rows = (
        supabase.table("device_schemas")
        .select("device_id,schema_id")
        .in_("device_id", [e["uuid"] for e in entries])
        .execute()
    ).data or []

    by_device = {}
    for row in rows:
        by_device.setdefault(str(row.get("device_id")), []).append(str(row.get("schema_id")))
    for entry in entries:
        entry["schemas"] = by_device.get(str(entry["uuid"]), [])
    return entries


def directory_documents(supabase):
    """
    Build the four documents, keyed by topic suffix.

    RAISES rather than returning a partial set. A Directory that publishes three of its four
    documents leaves a subscriber holding a retained answer from the last successful pass beside
    three fresh ones, with nothing in the payloads to say which is which. Failing the whole pass
    keeps every retained document from the same moment, and the next pass replaces all four.
    """
    devices = (
        supabase.table("devices")
        .select(_DEVICE_COLUMNS)
        .eq("is_archived", False)
        .execute()
    ).data or []
    entries = _attach_schemas(supabase, [_device_entry(row) for row in devices])

    # `active` ONLY, matching `/v1/schema`, which lists what is IN USE. The reverse lookup
    # `/v1/schema/{uuid}` deliberately does not filter -- an identifier a caller already holds
    # resolves to whatever it names -- but that is a lookup, and a topic carries no lookup. What a
    # collection means here is "the versions in force", and an archived version is not one.
    schemas = (
        supabase.table("schemas")
        .select("id,schema_name,version,status")
        .eq("status", "active")
        .execute()
    ).data or []

    # `status` IS AN OBSERVATION AND CAN BE "UNKNOWN" -- nine of the fifteen services have browser
    # addresses no probe inside the stack could answer honestly. Passed through as `online` exactly
    # as the HTTP half does, rather than flattened to true, because a consumer deciding whether to
    # route to a service should be able to tell "up" from "nobody is looking".
    services = (
        supabase.table("directory_services")
        .select("id,service_name,service_type,endpoint_url,status")
        .execute()
    ).data or []

    qualification = {"namespace": "local", "note": LOCAL_SCHEMA_NOTE}

    return {
        "ping": {
            "service": SERVICE_NAME,
            "status": "ok",
            "version": SERVICE_VERSION,
            "factoryplus_payload_uuid": FACTORYPLUS_PAYLOAD_UUID,
            # Named on the topic as well as in the function's registry entry, so a subscriber that
            # finds this tree can tell which surface it mirrors without being told.
            "transport": "mqtt",
            "http_equivalent": "/fplus-directory",
        },
        # FULL ENTRIES, WHERE `/v1/device` RETURNS A UUID LIST. The HTTP collection is a list
        # because a client then fetches the ones it cares about; a subscriber cannot fetch. It has
        # the document or it has nothing, so the document has to be the answer -- which is the same
        # shape `/v1/address/{group}/{node}` already returns for the same reason.
        "device": dict(qualification, devices=entries),
        "schema": dict(qualification, schemas=[
            {"uuid": s.get("id"), "name": s.get("schema_name"), "version": s.get("version")}
            for s in schemas
        ]),
        "service": {
            "namespace": "local",
            "note": LOCAL_SERVICE_NOTE,
            "services": [
                {
                    "uuid": s.get("id"),
                    "name": s.get("service_name"),
                    "type": s.get("service_type"),
                    "url": s.get("endpoint_url"),
                    "online": s.get("status") == "ACTIVE",
                }
                for s in services
            ],
        },
    }


def publish_once(client, supabase, prefix=None):
    """
    Build and publish one full pass. Returns the number of topics written.

    QoS 0 AND RETAIN TRUE. QoS 0 because the next pass is the retry -- a Directory document is a
    snapshot of current state, so a lost one is superseded rather than missing, and the whole stack
    publishes at QoS 0 already (see mosquitto/README.md, which records why a denied publish is silent
    here). Retain because a subscriber connecting between passes must not have to wait for one.
    """
    prefix = prefix or DIRECTORY_MQTT_TOPIC_PREFIX
    documents = directory_documents(supabase)
    published = 0
    for suffix, document in documents.items():
        client.publish(
            f"{prefix}/{suffix}",
            json.dumps(document, default=str),
            qos=0,
            retain=True,
        )
        published += 1
    return published


def start(client, supabase):
    """
    Run the publisher on a daemon thread. Returns True if it was started.

    NO-OP AND SAYS SO WHEN DISABLED. A publisher that is off and silent is indistinguishable from
    one that is on and failing, and the second is the state worth finding in a log.

    A DAEMON THREAD, so it can never hold the process open on shutdown, and every pass is wrapped:
    a Directory that cannot reach the database must not take ingestion down with it. The daemon's
    job is telemetry; this is an adapter beside it.
    """
    if not DIRECTORY_MQTT_ENABLED:
        logger.info(
            "Directory MQTT publishing is off (DIRECTORY_MQTT_ENABLED unset). The HTTP half of the "
            "Directory is unaffected -- fplus-directory serves it per caller, under that caller's "
            "RLS policies. Setting this publishes the whole address space to %s/#, where the broker "
            "ACL is the only thing deciding who reads it.",
            DIRECTORY_MQTT_TOPIC_PREFIX,
        )
        return False

    if supabase is None:
        logger.error(
            "Directory MQTT publishing was enabled but there is no Supabase client, so there is "
            "nothing to derive the Directory FROM. Refusing to start the publisher."
        )
        return False

    def loop():
        while True:
            try:
                # WAITS FOR THE BROKER RATHER THAN PUBLISHING INTO A CLOSED SOCKET. paho buffers a
                # publish made while disconnected and drops it on reconnect with clean_start=True,
                # so a pass made here would be silently lost AND would report success.
                if client.is_connected():
                    count = publish_once(client, supabase)
                    logger.debug("Directory published: %s retained document(s).", count)
            except Exception as exc:  # noqa: BLE001 - an adapter must never stop ingestion
                logger.warning("Could not publish the Directory: %s", exc)
            time.sleep(DIRECTORY_MQTT_INTERVAL_SECONDS)

    threading.Thread(target=loop, name="directory-publisher", daemon=True).start()
    logger.info(
        "Directory MQTT publishing every %ss to %s/{ping,device,schema,service}, retained. Derived "
        "from the enrolment records, NOT accumulated from birth certificates -- a device that has "
        "not been enrolled does not become an address by publishing one.",
        DIRECTORY_MQTT_INTERVAL_SECONDS, DIRECTORY_MQTT_TOPIC_PREFIX,
    )
    return True
