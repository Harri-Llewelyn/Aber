"""
i3X 1.0 server for Aber, the shopfloor data platform.

A read-side adapter owning no data: metadata comes from PostgREST, current values from the MQTT
broker. It is a long-lived service rather than an edge function because i3X requires the server to
accumulate value changes between client polls, and those values can only come from a held
subscription to `spBv1.0/#`.

THE SECURITY MODEL IS THE MOST IMPORTANT THING IN THIS FILE.

  NO SERVICE-ROLE KEY. `main()` refuses to start if one is in its environment, and `ingestion.py`
  is deliberately not imported because it constructs a service-role client at import time whenever
  the key is set. Every metadata read carries the CALLER's bearer token, so RLS decides what the
  address space contains.

  EVERY REQUEST BUT `GET /info` IS AUTHENTICATED BEFORE DISPATCH by one PostgREST call made as the
  caller (`_authenticate`), so revocation and expiry reach the subscription endpoints too, and each
  subscription belongs to the token's `sub`.

  THE MQTT VALUE CACHE HAS NO RLS, and that is the trap this file closes. It is a dict keyed by
  sparkplug_id, so serving from it directly would hand any authenticated caller live values for
  every device on the site. A value request therefore resolves its elementIds through PostgREST AS
  THE CALLER first and serves only the ids that came back; anything else reports as not found.

  `GET /info` is unauthenticated because the spec says it MUST be, and it doubles as the health
  check. It reports capabilities and nothing about the address space.

WRITES ARE NOT IMPLEMENTED. `PUT /objects/value` and `PUT /objects/history` answer 405 and `GET
/info` declares `update.current: false` / `update.history: false`. Update is a MAY, so this is
fully conformant, and a server that does not implement the verb cannot be talked into it by a
client-side flag.

Related: README.md -> "Why this is an adapter, not a feature", "Why it is a separate long-lived
         service" (including why Supabase Realtime cannot carry the values), "Security" and
         "Writes are refused".
"""
from __future__ import annotations

import base64
import gzip
import io
import json
import logging
import os
import re
import select
import hashlib
import socket
import sys
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Optional

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import address_space as A  # noqa: E402
from subscriptions import SubscriptionError, SubscriptionRegistry  # noqa: E402

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] i3x: %(message)s",
)
logger = logging.getLogger("i3x")

SPEC_VERSION = "1.0"
SERVER_NAME = os.getenv("I3X_SERVER_NAME", "aber-i3x")
# The chart sets it from its appVersion. `dev` marks a process started without the chart.
SERVER_VERSION = os.getenv("I3X_SERVER_VERSION", "dev")

LISTEN_HOST = os.getenv("I3X_HOST", "0.0.0.0")
LISTEN_PORT = int(os.getenv("I3X_PORT", "8090"))

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://supabase-kong:8000").rstrip("/")
# The publishable key does no work here beyond getting past the gate: `_headers()` sends it as
# `apikey` and puts the CALLER'S OWN token in Authorization, so RLS decides what the address
# space contains.
SUPABASE_GATEWAY_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")

MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
# A READ-ONLY broker principal, matching what this service refuses to do in code: the i3x role
# grants `factoryplus_i3x` reads of `spBv1.0/#` and nothing else. The Directory is read over
# PostgREST (`_headers()` below), not from the broker. Deliberately not the ingestion account,
# which can publish NCMD -- a server whose durable control is that it cannot be talked into
# writing should not hold a credential that could.
MQTT_USER = os.getenv("MQTT_USER", "factoryplus_i3x")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
MQTT_TLS_ENABLED = os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
MQTT_TLS_CA_FILE = os.getenv("MQTT_TLS_CA_FILE", "").strip()

SUBSCRIPTION_TTL_SECONDS = int(os.getenv("I3X_SUBSCRIPTION_TTL_SECONDS", "300"))
SUBSCRIPTION_QUEUE_LIMIT = int(os.getenv("I3X_SUBSCRIPTION_QUEUE_LIMIT", "10000"))
MAX_SUBSCRIPTIONS_PER_PRINCIPAL = int(os.getenv("I3X_MAX_SUBSCRIPTIONS_PER_PRINCIPAL", "20"))
MAX_SUBSCRIPTIONS = int(os.getenv("I3X_MAX_SUBSCRIPTIONS", "500"))
MAX_STREAMS = int(os.getenv("I3X_MAX_STREAMS", "50"))
REAPER_INTERVAL_SECONDS = int(os.getenv("I3X_REAPER_INTERVAL_SECONDS", "30"))
# Comfortably inside the TTL, so an idle-but-connected client keeps its subscription alive.
SSE_KEEPALIVE_SECONDS = float(os.getenv("I3X_SSE_KEEPALIVE_SECONDS", "15"))
# A stream write that cannot finish in this long ends the stream: its client has stopped reading.
SSE_SEND_TIMEOUT_SECONDS = 10.0

# MIRRORED FROM ingestion.py. Keep in step -- `test_i3x_service.py` asserts both files agree, the
# same discipline `sparkplugToXsd.ts` has against `sparkplugDatatype.js`. ingestion.py is not
# imported here on purpose; see the security note in the module docstring.
MAX_ALIASES_PER_NODE = int(os.getenv("MAX_ALIASES_PER_NODE", "5000"))

# How many elementIds one bulk request may name.
#
# THE DEPTH WAS BOUNDED AND THE BREADTH WAS NOT. `maxDepth` has always been budgeted on the value
# path, but `elementIds` was read straight off the body -- so a single POST could name a hundred
# thousand ids and this server would resolve every one against the whole address space, on the
# request thread, for a caller holding nothing but a valid bearer token.
#
# A LIMIT, NOT A TRUNCATION. Silently answering the first N would return a bulk array shorter than
# the request, and i3X bulk results are paired POSITIONALLY -- a client would mis-attribute every
# value after the cut. 400 says what happened; a short array does not.
#
# 1000 is far above any real client: the conformance suite's largest batch is a few dozen, and a
# whole demonstrator address space is under a hundred elements.
MAX_BULK_ELEMENT_IDS = int(os.getenv("I3X_MAX_BULK_ELEMENT_IDS", "1000"))
# The site's Sparkplug group, for keying the address space when a topic carries none. Read as
# SPARKPLUG_GROUP since 0131, which is the one name the chart, the daemon and the database share;
# the chart never set the older DEFAULT_SPARKPLUG_GROUP, so nothing was relying on it.
DEFAULT_SPARKPLUG_GROUP = os.getenv("SPARKPLUG_GROUP", "")
IDENTITY_METRICS = ("Asset_ID", "Asset_Name", "Instance_UUID", "Schema_UUID")

_values: Dict[str, Dict[str, dict]] = {}
_values_lock = threading.RLock()
_alias_map: Dict[tuple, Dict[int, str]] = {}
_alias_lock = threading.RLock()
# The datatypes the same births declare, under the same lock: (group, node) -> {alias: datatype},
# and -> {device_id or "": {name: datatype}}. A signed integer cannot be read without one.
_alias_datatypes: Dict[tuple, Dict[int, int]] = {}
_name_datatypes: Dict[tuple, Dict[str, Dict[str, int]]] = {}

registry = SubscriptionRegistry(
    queue_limit=SUBSCRIPTION_QUEUE_LIMIT,
    ttl_seconds=SUBSCRIPTION_TTL_SECONDS,
    max_per_principal=MAX_SUBSCRIPTIONS_PER_PRINCIPAL,
    max_subscriptions=MAX_SUBSCRIPTIONS,
    max_streams=MAX_STREAMS,
)


# =================================================================================================
# PostgREST, as the caller
# =================================================================================================
class PostgrestClient:
    """
    A PostgREST client bound to ONE caller's bearer token.

    Constructed per request. `apikey` is the publishable key -- the gateway needs a registered key
    and this is the public one -- while `Authorization` is the caller's own JWT, which is what
    PostgREST resolves the role and RLS context from. The two headers do different jobs and it is the
    second that carries identity.
    """

    def __init__(self, bearer: str, timeout: float = 10.0):
        self.bearer = bearer
        self.timeout = timeout
        self.base = f"{SUPABASE_URL}/rest/v1"

    def _headers(self) -> dict:
        headers = {"Accept": "application/json", "Authorization": self.bearer}
        if SUPABASE_GATEWAY_KEY:
            headers["apikey"] = SUPABASE_GATEWAY_KEY
        return headers

    def get(self, path: str, params: Optional[dict] = None) -> List[dict]:
        resp = requests.get(
            f"{self.base}/{path}", params=params or {}, headers=self._headers(), timeout=self.timeout
        )
        if resp.status_code == 401 or resp.status_code == 403:
            raise SubscriptionError(
                resp.status_code,
                "Unauthorized" if resp.status_code == 401 else "Forbidden",
                "The supplied credentials were rejected by the data layer.",
            )
        if not resp.ok:
            raise SubscriptionError(
                502, "Bad Gateway", f"Upstream read failed ({resp.status_code}): {resp.text[:200]}"
            )
        data = resp.json()
        return data if isinstance(data, list) else [data]


# =================================================================================================
# Address space assembly
# =================================================================================================
"""
Short-TTL address-space cache, KEYED BY THE CALLER'S TOKEN.

The address space was reassembled from scratch on every request -- five PostgREST reads, and
several endpoints load it two or three times in one call (`/types/{id}` builds types and then
objects; the bulk value reads rebuild it per request), so a single conformance client polling in a
loop was costing 12-18 queries a tick. Fine for a demonstrator, wrong for anything watching.

THE KEY IS THE TOKEN AND THAT IS NOT NEGOTIABLE. The space is deliberately assembled from reads
made AS THE CALLER, so RLS decides what it contains -- a cache shared across identities would hand
one user another's view of the plant, which is exactly the hole the MQTT value cache is guarded
against. The key is a SHA-256 of the Authorization header rather than the header itself: this dict
outlives the request, and a process dump or a stray log of it should not be a wallet of live
bearer tokens.

BOUNDED, because it is keyed on something a client controls. An unbounded dict keyed by bearer is
a memory-exhaustion vector -- anyone who can reach the port can mint distinct keys by varying the
header -- so entries are capped and evicted least-recently-used. That bound is the reason this is
an OrderedDict rather than a plain one.

THE CACHED DICT IS SHARED, NOT COPIED, and that is safe for a specific reason worth stating.
`_build_objects()` decorates the space in place: `_gateways_by_sid` / `_devices_by_sid` on the
space, and `_gateway_sparkplug_id` / `_is_extended` on each device row. Every one of those is a
deterministic function of the space itself and is written with the same value each time, so two
threads racing on a hit recompute identical results and one harmlessly overwrites the other. They
are also all underscore-prefixed derived fields -- nothing here mutates source data, and nothing
mutating it would be correct. A deep copy per request would defeat most of the point; if a future
change writes REQUEST-SPECIFIC state into the space, this becomes cross-request corruption and the
copy becomes mandatory.

A HIT CAN OUTLIVE A REVOKED GRANT by up to the TTL, which is why the TTL is seconds rather than
minutes. Setting it to 0 disables the cache outright, which is the escape hatch if that window is
ever unacceptable.
"""
ADDRESS_SPACE_TTL_SECONDS = float(os.getenv("I3X_ADDRESS_SPACE_TTL_SECONDS", "2"))
ADDRESS_SPACE_CACHE_MAX = int(os.getenv("I3X_ADDRESS_SPACE_CACHE_MAX", "64"))

_space_cache: "OrderedDict[str, tuple]" = OrderedDict()
_space_lock = threading.RLock()


def _space_cache_key(bearer: str) -> str:
    return hashlib.sha256(bearer.encode("utf-8")).hexdigest()


def _space_cache_clear() -> None:
    """Drop every entry. For tests, and for anything that needs a cold read."""
    with _space_lock:
        _space_cache.clear()


def _load_address_space(pg: PostgrestClient) -> dict:
    """
    The caller-facing loader: a cached read of the address space for THIS bearer.

    `monotonic()` rather than `time()` so a clock adjustment cannot strand an entry as
    permanently-fresh or permanently-stale.
    """
    if ADDRESS_SPACE_TTL_SECONDS <= 0:
        return _read_address_space(pg)

    key = _space_cache_key(pg.bearer)
    now = time.monotonic()

    with _space_lock:
        entry = _space_cache.get(key)
        if entry is not None:
            expires_at, space = entry
            if expires_at > now:
                _space_cache.move_to_end(key)
                return space
            # Expired. Dropped here rather than left for the LRU bound, so a stale view cannot be
            # returned by a later branch that forgot to check the clock.
            del _space_cache[key]

    # DELIBERATELY OUTSIDE THE LOCK. The read is five network round trips; holding the lock across
    # it would serialise every caller in the process behind the slowest PostgREST response, which
    # is a worse property than the duplicate read that two simultaneous misses can now cause. A
    # duplicate read is wasteful; a global stall is an outage.
    space = _read_address_space(pg)

    with _space_lock:
        _space_cache[key] = (time.monotonic() + ADDRESS_SPACE_TTL_SECONDS, space)
        _space_cache.move_to_end(key)
        while len(_space_cache) > ADDRESS_SPACE_CACHE_MAX:
            _space_cache.popitem(last=False)

    return space


def _read_address_space(pg: PostgrestClient) -> dict:
    """
    Read the whole visible address space, one query per relation rather than one per object.

    The object graph needs cross-references (a cell's children, a gateway's devices, a device's
    schemas) that no single embed expresses, so everything is joined in memory here.

    UNCACHED. Every caller should go through `_load_address_space()`; this is the cold read behind
    it, separated so the cache has something to call and so a test can measure the difference.

    A failed read raises; it never becomes "no rows". Only a 401/403 on the location view reads as
    empty, because a caller denied that view is still shown every asset it may see, under
    Unassigned.
    """
    # ARCHIVED ROWS ARE EXCLUDED EVERYWHERE. A soft-deleted asset is not part of the live address
    # space -- it is restorable history, and the Archives tab is where it lives. Including it would
    # publish elementIds that resolve to nothing a client can subscribe to, and an archived device
    # publishes no values, so every one of them would read as GoodNoData forever.
    live = "eq.false"
    cells = _read_relation(
        pg, "cells", {"select": "id,name,description", "is_archived": live, "order": "name"}
    )
    gateways = _read_relation(
        pg,
        "gateways",
        {
            "select": "id,sparkplug_id,name,cell_id,location_scope,sparkplug_group,status,"
            "last_heartbeat",
            "is_archived": live,
        },
    )
    devices = _read_relation(
        pg,
        "devices",
        {
            "select": "id,sparkplug_id,name,gateway_id,is_quarantined,last_birth_metrics,"
            "schema_id,status,cell_id,location_scope",
            "is_archived": live,
        },
    )
    # The resolved cell and area per device, keyed by `device_id`. A view because that resolution
    # must not be re-implemented per consumer; `effective_area_id` is carried for the Area level.
    locations = _read_relation(
        pg,
        "device_locations",
        {"select": "device_id,effective_cell_id,effective_area_id"},
        denied_is_empty=True,
    )
    schemas = _read_relation(
        pg,
        "schemas",
        {"select": "id,schema_name,description,schema_definition,semantic_id,version,status,"
                   "change_description"},
    )
    # Every schema attached to a device, as the dashboard, the AAS exporter and ingestion read it:
    # device_submodels rows, else the legacy devices.schema_id.
    attached = _read_relation(pg, "device_schemas", {"select": "device_id,schema_id"})
    # A metric's catalog row is its type on every device that carries it.
    catalog = _read_relation(
        pg,
        "metric_catalog",
        {"select": "name,datatype,description,units,standard,semantic_id,deprecated",
         "order": "name"},
    )
    schemas_by_device: Dict[str, List[str]] = {}
    for row in attached:
        schemas_by_device.setdefault(row["device_id"], []).append(row["schema_id"])
    return {
        "cells": cells,
        "gateways": gateways,
        "devices": devices,
        "locations": {row["device_id"]: row for row in locations},
        "schemas": schemas,
        "device_schemas": schemas_by_device,
        "metric_catalog": catalog,
    }


def _read_relation(pg: PostgrestClient, relation: str, params: dict,
                   denied_is_empty: bool = False) -> List[dict]:
    """
    One address-space read. A 401/403 raises unless `denied_is_empty`; any other failure is a 502
    naming the relation and carrying PostgREST's message, so a bad column cannot pass as no rows.
    """
    try:
        return pg.get(relation, params)
    except SubscriptionError as exc:
        if exc.status in (401, 403):
            if denied_is_empty:
                return []
            raise
        raise SubscriptionError(502, "Bad Gateway", f"Reading {relation}: {exc.detail}") from exc


def _modelled_metrics(schema_definition) -> set:
    """
    Union of `properties` keys and `required`.

    `schema_definition` is free-form JSONB and hand-written schemas carry either, which is why
    `modelledMetrics()` in deviceTags.js reads both.

    ONE OF FOUR IMPLEMENTATIONS, all held to `test-harness/fixtures/modelled-metrics.json` -- with
    deviceTags.js, `modelled_metrics()` in ingestion/validate.py, and `modelledMetrics()` in
    supabase/functions/aas-export/index.ts. This one is asserted by
    `ModelledMetricsContractTest` in test_i3x_service.py.

    `!isinstance(props, dict)` IS LOAD-BEARING: an array `properties` must contribute nothing, and
    `isinstance` closes that by construction rather than by remembering to check.
    (docs/incidents.md -- "Array `properties` read as metric names")

    RETURNS AN EMPTY SET, NOT None, where the mirrors distinguish "declares neither, cannot be
    evaluated" from "models nothing". i3X has no caller that asks -- `_build_objects` iterates the
    result to decide what to project -- so the NAMES agree exactly with the other three and only
    that distinction is dropped. The contract test asserts the collapse rather than leaving it
    implied.
    """
    if not isinstance(schema_definition, dict):
        return set()
    props = schema_definition.get("properties")
    names = set(props.keys()) if isinstance(props, dict) else set()
    required = schema_definition.get("required")
    if isinstance(required, list):
        names.update(r for r in required if isinstance(r, str))
    return names


def _attached_schemas(space: dict) -> Dict[str, tuple]:
    """Each live device's attached schema ids that this caller can read: sorted, no repeats."""
    readable = {s["id"] for s in space["schemas"]}
    attached = space.get("device_schemas") or {}
    out = {}
    for device in space.get("devices", []):
        ids = tuple(sorted({i for i in attached.get(device["id"], ()) if i in readable}))
        if ids:
            out[device["id"]] = ids
    return out


def _device_type(schemas: List[dict]) -> tuple:
    """(typeElementId, the one schema, the sourceTypeId of a type synthesized for several)."""
    if len(schemas) > 1:
        type_id = A.schema_set_type_id(s["id"] for s in schemas)
        return type_id, None, type_id
    if schemas:
        return schemas[0]["id"], schemas[0], None
    return None, None, None


def _birth_datatypes() -> Dict[str, Dict[str, int]]:
    """Each device's metric datatypes as its DBIRTH declared them, since this process started."""
    by_device: Dict[str, Dict[str, int]] = {}
    with _alias_lock:
        for names in _name_datatypes.values():
            for device_id, typed in names.items():
                if device_id:
                    by_device.setdefault(device_id, {}).update(typed)
    return by_device


def _component_names(names) -> list:
    """The metric names that are components, sorted: no identity metric, no unaddressable name."""
    return sorted(n for n in names if n not in IDENTITY_METRICS and A.metric_name_is_addressable(n))


def _device_metrics(device: dict, declared: list, modelled: set, modelled_names: list,
                    catalog: dict, catalog_types: dict, births: dict) -> tuple:
    """
    A device's metric objects, and the inferred fragment of each metric it declares beyond its
    schemas. The components are every modelled metric, published or not, and every metric its last
    DBIRTH declared (`declared`, identity metrics already out); `modelled_names` is the first set,
    sorted. A metric the catalog lacks is typed by its DBIRTH datatype, known only for births seen
    here.
    """
    sid = device["sparkplug_id"]
    beyond = {n for n in declared if n not in modelled}
    names = _component_names(beyond.union(modelled_names)) if beyond else modelled_names
    datatypes = births.get(sid) or {}
    metrics = [
        A.metric_object(
            sid, name, catalog_types.get(name) or A.fallback_metric_type(datatypes.get(name))
        )
        for name in names
    ]
    extensions = {
        name: A.scalar_schema(datatypes.get(name) or (catalog.get(name) or {}).get("datatype"))
        for name in sorted(beyond)
    }
    return metrics, extensions


def _build_objects(space: dict) -> Dict[str, dict]:
    """Assemble every Object, keyed by elementId."""
    schemas_by_id = {s["id"]: s for s in space["schemas"]}
    gateways_by_id = {g["id"]: g for g in space["gateways"]}
    attached = _attached_schemas(space)
    catalog = {row["name"]: row for row in space.get("metric_catalog", [])}
    catalog_types = {name: A.metric_type_from_catalog(row) for name, row in catalog.items()}
    births = _birth_datatypes()
    # Per distinct set of schemas: the metrics they model, and those that are components, sorted.
    modelled_by_set: Dict[tuple, tuple] = {}

    devices_by_gateway: Dict[str, List[str]] = {}
    children_by_cell: Dict[str, List[str]] = {}
    unassigned: List[str] = []
    objects: Dict[str, dict] = {}

    for device in space["devices"]:
        gateway = gateways_by_id.get(device.get("gateway_id"))
        device["_gateway_sparkplug_id"] = gateway["sparkplug_id"] if gateway else None
        schema_ids = attached.get(device["id"], ())
        if schema_ids not in modelled_by_set:
            modelled = set().union(
                *(_modelled_metrics(schemas_by_id[i].get("schema_definition")) for i in schema_ids)
            )
            modelled_by_set[schema_ids] = (modelled, _component_names(modelled))
        modelled, modelled_names = modelled_by_set[schema_ids]
        declared = [n for n in device.get("last_birth_metrics") or () if n not in IDENTITY_METRICS]
        device["_is_extended"] = A.is_extended(declared, modelled)
        metrics, extensions = _device_metrics(
            device, declared, modelled, modelled_names, catalog, catalog_types, births
        )
        type_id, schema, source_type_id = _device_type([schemas_by_id[i] for i in schema_ids])
        cell_id = (space["locations"].get(device["id"]) or {}).get("effective_cell_id")
        obj = A.device_object(device, cell_id, type_id, schema, source_type_id=source_type_id,
                              metric_ids=[m["elementId"] for m in metrics], extensions=extensions)
        objects[obj["elementId"]] = obj
        if cell_id:
            children_by_cell.setdefault(cell_id, []).append(obj["elementId"])
        else:
            unassigned.append(obj["elementId"])
        if gateway:
            devices_by_gateway.setdefault(gateway["sparkplug_id"], []).append(obj["elementId"])
        for metric in metrics:
            objects[metric["elementId"]] = metric

    for gateway in space["gateways"]:
        obj = A.gateway_object(gateway, devices_by_gateway.get(gateway["sparkplug_id"], []))
        objects[obj["elementId"]] = obj
        if obj["parentId"] == A.UNASSIGNED_ELEMENT_ID:
            unassigned.append(obj["elementId"])
        elif obj["parentId"] != A.SITE_ELEMENT_ID:
            children_by_cell.setdefault(obj["parentId"], []).append(obj["elementId"])

    cell_ids = []
    for cell in space["cells"]:
        obj = A.cell_object(cell, children_by_cell.get(cell["id"], []))
        objects[obj["elementId"]] = obj
        cell_ids.append(obj["elementId"])

    site_children = list(cell_ids) + [A.UNASSIGNED_ELEMENT_ID]
    site_children += [
        g["sparkplug_id"] for g in space["gateways"] if g.get("location_scope") == "site_wide"
    ]
    objects[A.UNASSIGNED_ELEMENT_ID] = A.unassigned_object(unassigned)
    objects[A.SITE_ELEMENT_ID] = A.site_object(site_children)

    # ---------------------------------------------------------------------------------------------
    # THE VALUE-PATH INDEXES, BUILT ONCE HERE RATHER THAN PER LOOKUP.
    #
    # `_current_value()` asks "is this elementId a gateway, a device, or a container?" once per
    # requested elementId and again per composition child, so deriving the answer from `space` on
    # each call is quadratic in the fleet on the one path a client is expected to poll.
    #
    # Cached on `space` rather than returned separately because the two must describe the SAME
    # read: an index built from a later fetch than the objects would resolve an elementId the
    # caller was never shown.
    # ---------------------------------------------------------------------------------------------
    space["_gateways_by_sid"] = {g["sparkplug_id"]: g for g in space["gateways"]}
    space["_devices_by_sid"] = {d["sparkplug_id"]: d for d in space["devices"]}
    return objects


def _build_types(space: dict) -> List[dict]:
    """
    Every type an object can name: the synthetic ones, one per schema and per catalog metric, the
    metric fallbacks, and one per distinct set of schemas some device carries.
    """
    types = list(A.SYNTHETIC_TYPES) + list(A.METRIC_FALLBACK_TYPES)
    schemas_by_id = {}
    for schema in space["schemas"]:
        types.append(A.object_type_from_schema(schema))
        schemas_by_id[schema["id"]] = schema
    types.extend(A.metric_type_from_catalog(row) for row in space.get("metric_catalog", []))
    for ids in sorted({ids for ids in _attached_schemas(space).values() if len(ids) > 1}):
        types.append(A.schema_set_type([schemas_by_id[i] for i in ids]))
    return types


# =================================================================================================
# Values, from MQTT
# =================================================================================================
def record_value(sparkplug_id: str, metric_name: str, value, timestamp: Optional[str]) -> None:
    with _values_lock:
        _values.setdefault(sparkplug_id, {})[metric_name] = {
            "value": value,
            "timestamp": timestamp or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }


def metrics_for(sparkplug_id: str) -> Dict[str, dict]:
    with _values_lock:
        return dict(_values.get(sparkplug_id, {}))


def alias_key(group_id, edge_node_id):
    """Aliases are scoped to (group, edge node). MIRRORED FROM ingestion.py -- keep in step."""
    return (group_id or DEFAULT_SPARKPLUG_GROUP, edge_node_id or "")


def register_birth_aliases(group_id, edge_node_id, metrics, reset=False, device_id=None) -> None:
    """
    Record alias -> name from a BIRTH, and the datatypes it declares by alias and by name.

    NBIRTH resets the node's tables; DBIRTH merges aliases and replaces the datatypes it declares by
    name for `device_id`. A DDATA metric carries only its alias, so without this the value cannot be
    named at all -- and the failure is silent data loss, not an error. The cap exists because the
    table is keyed by data the broker accepts from anyone.
    """
    key = alias_key(group_id, edge_node_id)
    with _alias_lock:
        table = {} if reset else _alias_map.get(key, {})
        alias_types = {} if reset else _alias_datatypes.get(key, {})
        for metric in metrics:
            alias = metric.get("alias")
            name = metric.get("name")
            if alias is None or not name:
                continue
            if len(table) >= MAX_ALIASES_PER_NODE and alias not in table:
                logger.warning(
                    "alias table for %s is at its %d-entry cap; ignoring further aliases",
                    key,
                    MAX_ALIASES_PER_NODE,
                )
                break
            table[int(alias)] = name
            if metric.get("datatype"):
                alias_types[int(alias)] = metric["datatype"]
            else:
                alias_types.pop(int(alias), None)
        _alias_map[key] = table
        _alias_datatypes[key] = alias_types

        # Capped like the alias table, across the node's devices: the device segment of a topic is
        # publisher-chosen.
        names = {} if reset else _name_datatypes.get(key, {})
        device = device_id or ""
        typed = {m["name"]: m["datatype"] for m in metrics if m.get("name") and m.get("datatype")}
        room = MAX_ALIASES_PER_NODE - sum(len(t) for d, t in names.items() if d != device)
        if len(typed) > room:
            logger.warning("datatype table for %s is at its %d-entry cap", key, MAX_ALIASES_PER_NODE)
            typed = dict(list(typed.items())[: max(room, 0)])
        if typed:
            names[device] = typed
        else:
            names.pop(device, None)
        _name_datatypes[key] = names


def resolve_metric_name(group_id, edge_node_id, metric) -> Optional[str]:
    if metric.get("name"):
        return metric["name"]
    alias = metric.get("alias")
    if alias is None:
        return None
    with _alias_lock:
        return _alias_map.get(alias_key(group_id, edge_node_id), {}).get(int(alias))


def resolve_metric_datatype(group_id, edge_node_id, metric, device_id=None, name=None):
    """Its own datatype, else a birth's for its alias, else for `name` on the device, then the node."""
    if metric.get("datatype"):
        return metric["datatype"]
    key = alias_key(group_id, edge_node_id)
    with _alias_lock:
        alias = metric.get("alias")
        if alias is not None and _alias_datatypes.get(key, {}).get(int(alias)):
            return _alias_datatypes[key][int(alias)]
        if not name:
            return None
        names = _name_datatypes.get(key, {})
        return names.get(device_id or "", {}).get(name) or names.get("", {}).get(name)


# MIRRORED FROM ingestion.py -- `test_i3x_service.py` asserts both copies agree. The signed
# datatypes (Int8, Int16, Int32, Int64) and their width in bits.
SPARKPLUG_SIGNED_INT_BITS = {1: 8, 2: 16, 3: 32, 4: 64}


def sparkplug_integer_value(datatype, raw):
    """
    An `int_value` or `long_value` read as `datatype`: a signed type is sign-extended from its own
    width and anything else is returned unchanged. Masking to the width first accepts both
    encodings of a narrow type (0xFB and 0xFFFFFFFB are an Int8 of -5) and an already-signed value.
    """
    bits = SPARKPLUG_SIGNED_INT_BITS.get(datatype)
    if bits is None:
        return raw
    raw &= (1 << bits) - 1
    return raw - (1 << bits) if raw >> (bits - 1) else raw


# Value fields this server cannot serve as a JSON value; the historian drops them too.
UNSERVED_VALUE_FIELDS = ("bytes_value", "dataset_value", "template_value", "extension_value")
UNDECLARED_INTEGER_WARN_INTERVAL_SECONDS = 300
_undeclared_integer_warned_at = 0.0


def metric_value(group_id, edge_node_id, device_id, name, metric):
    """
    The value to serve: an integer read through its declared datatype. One whose datatype no birth
    since startup declared is served as it arrived, unsigned, as ingestion stores it.
    """
    global _undeclared_integer_warned_at
    value = metric["value"]
    if metric.get("field") not in ("int_value", "long_value"):
        return value
    if not isinstance(value, int) or isinstance(value, bool):
        return value
    datatype = resolve_metric_datatype(group_id, edge_node_id, metric, device_id, name)
    now = time.time()
    if datatype is None and now - _undeclared_integer_warned_at > UNDECLARED_INTEGER_WARN_INTERVAL_SECONDS:
        _undeclared_integer_warned_at = now
        logger.warning(
            "integer metric %r on %s/%s has no declared datatype; serving it unsigned until the "
            "node births again (further cases are not logged for %ds)",
            name, edge_node_id, device_id, UNDECLARED_INTEGER_WARN_INTERVAL_SECONDS,
        )
    return sparkplug_integer_value(datatype, value)


def _stage_and_push(sparkplug_id: str, metrics: Dict[str, dict]) -> None:
    """
    Queue a value change for every subscription watching this element, then wake their streams.

    Runs on the MQTT network thread, so it never writes to a client socket: each stream's own
    handler thread drains its queue and writes (see `_serve_stream`).
    """
    device_stub = {"sparkplug_id": sparkplug_id, "is_quarantined": False}
    envelope = A.device_value(device_stub, metrics)
    streaming = registry.stage({sparkplug_id: envelope})
    for sub in streaming:
        _wake_stream(sub)


# =================================================================================================
# SSE
# =================================================================================================
_streams: Dict[str, "SseChannel"] = {}
_streams_lock = threading.RLock()


class SseChannel:
    """
    One open SSE response, writing HTTP/1.1 chunked frames.

    The chunked framing is done here rather than by the handler because the body is unbounded and so
    has no Content-Length -- and under HTTP/1.1 a response with neither leaves the client waiting for
    a close that never comes.

    ONLY THE STREAM'S OWN HANDLER THREAD WRITES (`send`, `keepalive`, `finish`). Every other thread
    -- the MQTT thread, a displacing stream, a delete -- calls `wake()` or `close()`, which only
    signal. A client that stops reading then stalls its own thread until the send timeout, and
    nothing else.
    """

    def __init__(self, handler: BaseHTTPRequestHandler):
        self.handler = handler
        # Set once the response has ended, cleanly or not; nothing is written after it.
        self.closed = threading.Event()
        # True only when the terminating chunk went out, so the connection can serve a next request.
        self.ended_cleanly = False
        self.close_requested = threading.Event()
        # The wake signal is a socket pair so the handler's `select` can wait on the client and on
        # wakes at once. `_wake_lock` stops a late wake writing to a descriptor `release()` freed.
        self._wake_r, self._wake_w = socket.socketpair()
        self._wake_r.setblocking(False)
        self._wake_w.setblocking(False)
        self._wake_lock = threading.Lock()
        self._released = False

    # -- any thread ------------------------------------------------------------------------------
    def wake(self) -> None:
        """Ask the handler thread to drain the queue. Never blocks: a full pair means one is due."""
        with self._wake_lock:
            if self._released:
                return
            try:
                self._wake_w.send(b"\0")
            except OSError:
                pass

    def close(self) -> None:
        """Ask the handler thread to end the response cleanly."""
        self.close_requested.set()
        self.wake()

    # -- the stream's handler thread only --------------------------------------------------------
    @property
    def wake_socket(self) -> socket.socket:
        return self._wake_r

    def consume_wakes(self) -> None:
        try:
            while self._wake_r.recv(4096):
                pass
        except OSError:
            # BlockingIOError: every pending wake has been read.
            pass

    def _write(self, text: str) -> bool:
        if self.closed.is_set():
            return False
        data = text.encode("utf-8")
        try:
            self.handler.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
            self.handler.wfile.flush()
            return True
        except (OSError, ValueError):
            # OSError includes a reset, a broken pipe and the send timeout (TimeoutError).
            self.closed.set()
            return False

    def send(self, payload) -> bool:
        return self._write(f"data: {json.dumps(payload, default=str)}\n\n")

    def keepalive(self) -> bool:
        # An SSE comment. Keeps intermediaries from timing the connection out without being
        # delivered to the client as an event.
        return self._write(": keep-alive\n\n")

    def finish(self) -> None:
        """
        End the chunked response cleanly, then mark it closed.

        THE TERMINATING ZERO-LENGTH CHUNK IS THE POINT. When a second stream displaces this one the
        spec says "the previously connected client will receive an SSE stream close with NO ERROR" --
        so simply dropping the socket is wrong: the client sees a truncated chunked body and reports
        a network fault for what was an orderly, expected handover.
        """
        if self.closed.is_set():
            return
        try:
            self.handler.wfile.write(b"0\r\n\r\n")
            self.handler.wfile.flush()
            self.ended_cleanly = True
        except (OSError, ValueError):
            pass
        self.closed.set()

    def release(self) -> None:
        with self._wake_lock:
            self._released = True
            self._wake_r.close()
            self._wake_w.close()


def _wake_stream(sub) -> None:
    """Tell this subscription's open stream, if any, that its queue has something to send."""
    with _streams_lock:
        channel = _streams.get(sub.subscription_id)
    if channel is not None:
        channel.wake()


def _detach_stream(sub, only_if=None) -> None:
    """
    Close this subscription's stream and mark it closed in the registry.

    `only_if` GUARDS AGAINST A DISPLACED STREAM CLOSING ITS OWN REPLACEMENT. When a second stream
    opens, the first is closed here and its handler thread is still parked in the wait loop; when
    that thread finally unwinds it runs this in a `finally`. Without the identity check it would pop
    whatever is registered under the subscription id -- by then the SECOND channel -- and close a
    perfectly healthy stream that had just displaced it. The client would see a stream that opened,
    worked, and died a keepalive interval later for no reason it could observe.
    """
    with _streams_lock:
        current = _streams.get(sub.subscription_id)
        if only_if is not None and current is not only_if:
            # Already displaced. The replacement owns the subscription now; leave it alone.
            return
        channel = _streams.pop(sub.subscription_id, None)
    if channel:
        channel.close()
    registry.close_stream(sub)


def _on_registry_stream_close(sub) -> None:
    _detach_stream(sub)


registry.on_stream_close = _on_registry_stream_close


def _serve_stream(req, sub, backlog: List[dict], bearer: str, caller: "Caller") -> None:
    """
    Answer `/subscriptions/stream` on this handler thread, which is the only one that writes to it.

    It ends when the client disconnects, when another stream or a delete displaces it, when a write
    cannot finish inside SSE_SEND_TIMEOUT_SECONDS, at the token's `exp`, or when the token fails
    the re-check made on every keepalive tick. All but the first and third end cleanly, with the
    terminating chunk, and only a clean end leaves the connection open for a next request.

    It sends the QUEUE, never the live value, because the queue is the one source of ordering.
    Delivered means discarded: SSE is at-most-once, so a later `/sync` must not re-deliver it.
    """
    conn = req.connection
    try:
        channel = SseChannel(req)
    except OSError:
        # No stream was opened, so `/sync` must work again rather than answer 409 forever.
        registry.close_stream(sub)
        raise
    with _streams_lock:
        existing = _streams.get(sub.subscription_id)
        if existing:
            existing.close()
        _streams[sub.subscription_id] = channel

    try:
        conn.settimeout(SSE_SEND_TIMEOUT_SECONDS)
        req.send_response(200)
        req.send_header("Content-Type", "text/event-stream")
        req.send_header("Cache-Control", "no-cache")
        req.send_header("Connection", "keep-alive")
        # Chunked rather than a Content-Length: the body is unbounded. HTTP/1.1 without either
        # would make the client wait for a close that never comes.
        req.send_header("Transfer-Encoding", "chunked")
        req.end_headers()

        # Plus anything staged before the channel was registered, whose wake found no channel.
        batches = backlog + registry.drain(sub)
        next_tick = time.monotonic() + SSE_KEEPALIVE_SECONDS
        expires = _monotonic_deadline(caller.expires_at)
        while True:
            for batch in batches:
                if not channel.send(batch["updates"]):
                    return
            # WAIT ON THE SOCKET, NOT ON THE CLOCK, so an abandoned stream frees this thread at
            # once rather than at the next keepalive (README.md -> "Subscriptions", rule 4). A
            # readable stream socket means EOF: the request body was consumed at dispatch.
            try:
                ready, _, _ = select.select(
                    [conn, channel.wake_socket], [], [],
                    max(0.0, min(next_tick, expires) - time.monotonic()),
                )
            except (OSError, ValueError):
                return
            if conn in ready:
                return
            if channel.close_requested.is_set() or time.monotonic() >= expires:
                channel.finish()
                return
            batches = []
            if channel.wake_socket in ready:
                # Consumed before the drain, so a wake landing after the drain is not lost.
                channel.consume_wakes()
                batches = registry.drain(sub)
            if time.monotonic() >= next_tick:
                # Bypasses the cache, so a revoked token loses its stream within one tick.
                try:
                    expires = _monotonic_deadline(_authenticate(bearer, fresh=True).expires_at)
                except (Problem, requests.RequestException):
                    channel.finish()
                    return
                # The reaper treats an open stream as activity. The comment frame still goes out
                # when idle: intermediaries time out a silent connection.
                registry.touch(sub)
                if not channel.keepalive():
                    return
                next_tick = time.monotonic() + SSE_KEEPALIVE_SECONDS
    except OSError:
        # The headers could not be written: the client left before the stream began.
        pass
    finally:
        _detach_stream(sub, channel)
        channel.release()
        if channel.ended_cleanly:
            conn.settimeout(req.timeout)
        else:
            # A partial chunk, or a client already gone: the connection cannot take another request.
            req.close_connection = True


# =================================================================================================
# Authentication (README.md -> "Security")
# =================================================================================================
# Every route but these is authenticated in `_dispatch` before its handler runs.
UNAUTHENTICATED_ROUTES = frozenset({"GET /info"})
# An IMMUTABLE constant granted to `authenticated` and `service_role`, not `anon`. Calling it as the
# caller costs no table read and succeeds only when PostgREST accepts the token's signature and
# `exp` and the pre-request hook `auth_pre_request()` finds neither its jti nor its sub revoked.
AUTH_PROBE_PATH = "rpc/service_token_max_days"
# A success is reused for at most this long, and never past the token's `exp`. A refusal is never
# stored, and a fresh refusal evicts the stored success.
AUTH_CACHE_SECONDS = 15.0
# Keyed on a client-controlled header, so bounded and evicted least-recently-used.
AUTH_CACHE_MAX = 1024


class Caller:
    """An accepted token: the principal its subscriptions belong to, and its `exp` if any."""

    __slots__ = ("principal", "expires_at")

    def __init__(self, principal: str, expires_at: Optional[float]):
        self.principal = principal
        self.expires_at = expires_at


_auth_cache: "OrderedDict[str, tuple]" = OrderedDict()
_auth_lock = threading.Lock()


def _credential_key(bearer: str) -> str:
    # A digest, so the cache and the principal of a token with no `sub` never hold the token itself.
    return hashlib.sha256(bearer.encode("utf-8")).hexdigest()


def _unverified_claims(bearer: str) -> dict:
    """
    The JWT payload, decoded WITHOUT verifying the signature: `{}` for anything that is not a JWT.
    Trusted only once `_probe` has accepted the token, or to refuse one whose `exp` has passed.
    """
    scheme, _, rest = bearer.strip().partition(" ")
    token = rest.strip() if scheme.lower() == "bearer" else bearer.strip()
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    try:
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except ValueError:
        return {}
    return claims if isinstance(claims, dict) else {}


def _principal(bearer: str, claims: dict) -> str:
    """The token's `sub`. A credential with none (an `sb_` key) is its own principal."""
    sub = claims.get("sub")
    if isinstance(sub, str) and sub:
        return sub
    return "credential:" + _credential_key(bearer)


def _expiry(claims: dict) -> Optional[float]:
    exp = claims.get("exp")
    if isinstance(exp, (int, float)) and not isinstance(exp, bool):
        return float(exp)
    return None


def _monotonic_deadline(expires_at: Optional[float]) -> float:
    if expires_at is None:
        return float("inf")
    return time.monotonic() + (expires_at - time.time())


def _probe(bearer: str) -> None:
    """One PostgREST call carrying the caller's token. Raises Problem 401 if it is refused."""
    pg = PostgrestClient(bearer)
    resp = requests.get(f"{pg.base}/{AUTH_PROBE_PATH}", headers=pg._headers(), timeout=pg.timeout)
    if resp.status_code in (401, 403):
        try:
            message = str(resp.json().get("message") or "")
        except (ValueError, AttributeError):
            message = ""
        if not message or message.startswith("permission denied"):
            # What PostgREST says to the anon role: no user or service token was presented.
            message = "a user or service access token is required"
        raise Problem(
            401,
            "Unauthorized",
            f"The data layer refused this token: {message[:200]}. Only GET /info is "
            f"unauthenticated.",
        )
    if not resp.ok:
        raise Problem(
            502,
            "Bad Gateway",
            f"The token could not be checked ({resp.status_code} from the data layer).",
        )


def _forget(key: str) -> None:
    with _auth_lock:
        _auth_cache.pop(key, None)


def _authenticate(bearer: str, fresh: bool = False) -> Caller:
    """Accept the token or raise Problem. `fresh` skips the cache: an open stream's re-check."""
    key = _credential_key(bearer)
    if not fresh:
        with _auth_lock:
            hit = _auth_cache.get(key)
            if hit is not None and hit[0] > time.monotonic():
                _auth_cache.move_to_end(key)
                return hit[1]

    claims = _unverified_claims(bearer)
    expires_at = _expiry(claims)
    try:
        if expires_at is not None and expires_at <= time.time():
            # Refused on this server's clock too, so a stream and a request agree on the moment.
            raise Problem(
                401, "Unauthorized", "This token has expired. Only GET /info is unauthenticated."
            )
        _probe(bearer)
    except Problem:
        _forget(key)
        raise

    caller = Caller(_principal(bearer, claims), expires_at)
    keep = AUTH_CACHE_SECONDS
    if expires_at is not None:
        keep = min(keep, expires_at - time.time())
    if keep > 0:
        with _auth_lock:
            _auth_cache[key] = (time.monotonic() + keep, caller)
            _auth_cache.move_to_end(key)
            while len(_auth_cache) > AUTH_CACHE_MAX:
                _auth_cache.popitem(last=False)
    return caller


# =================================================================================================
# HTTP
# =================================================================================================
class Problem(Exception):
    def __init__(self, status: int, title: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.title = title
        self.detail = detail


def _require_element_ids(body: dict, required: bool = True) -> list:
    """
    The `elementIds` array from a bulk request body, validated and capped.

    ONE HELPER FOR EVERY BULK ENDPOINT, because the cap is only worth having if it is not possible
    to add a sixth handler that forgets it -- the same argument main/index.ts makes for its function
    allow-list.

    `required=False` for the two type endpoints, where an absent array means "all of them" and is a
    documented shorthand rather than a malformed request. An array that IS present is capped either
    way: "all types" is bounded by the schema count, a caller-supplied list is not.
    """
    wanted = body.get("elementIds")
    if wanted is None and not required:
        return []
    if not isinstance(wanted, list):
        raise Problem(400, "Bad Request", "elementIds array is required.")
    _cap_bulk(wanted, "elementIds")
    if not all(isinstance(eid, str) for eid in wanted):
        # An object or array here is unhashable, and would be a 500 at the first lookup.
        raise Problem(400, "Bad Request", "elementIds must be an array of strings.")
    return wanted


def _int_field(body: dict, name: str, default: int, minimum: int) -> int:
    """
    An integer body field of at least `minimum`, or `default` when absent or null. Anything else
    is a 400: JSON `true` is refused although Python counts it as 1, and `2.0` is taken as 2.
    """
    value = body.get(name)
    if value is None:
        return default
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise Problem(
            400,
            "Bad Request",
            f"{name} must be an integer of {minimum} or more; got {json.dumps(value)}.",
        )
    return value


def _max_depth(body: dict) -> int:
    """`maxDepth`: 1 (the default) is the object alone, 0 is unbounded, N descends N-1 levels."""
    return _int_field(body, "maxDepth", 1, 0)


def _cap_bulk(entries: list, field: str) -> list:
    """
    Refuse a caller-supplied batch larger than the cap.

    SEPARATE FROM THE SHAPE CHECK because two different shapes arrive: the bulk read endpoints take
    `elementIds`, and subscription registration takes either that or an `objects` array of
    dictionaries. Both are unbounded lists from an authenticated-but-otherwise-unprivileged caller,
    and the registration one is the more expensive -- it does not merely answer, it ADDS TO
    PER-CLIENT STATE that outlives the request and that every later poll is evaluated against.
    """
    if len(entries) > MAX_BULK_ELEMENT_IDS:
        raise Problem(
            400,
            "Bad Request",
            f"{field} names {len(entries)} elements; this server accepts at most "
            f"{MAX_BULK_ELEMENT_IDS} per request. Split the batch -- results are paired to "
            f"requests by position, so a truncated answer would be mis-read rather than short.",
        )
    return entries


def _require_client_id(body: dict) -> str:
    client_id = body.get("clientId")
    if not isinstance(client_id, str) or not client_id:
        # A spec MUST: "A request that omits clientId is malformed and the server MUST reject it
        # with 400 Bad Request." Defaulting it would silently merge every anonymous caller's
        # subscriptions into one namespace.
        raise Problem(400, "Bad Request", "clientId is required on every subscription request.")
    return client_id


class Handler(BaseHTTPRequestHandler):
    server_version = f"aber-i3x/{SERVER_VERSION}"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------------------------
    def log_message(self, fmt, *args):
        logger.debug("%s - %s", self.address_string(), fmt % args)

    def _read_body(self) -> None:
        """
        Consume the request body BEFORE any handler runs, and before any early refusal.

        THE BODY MUST ALWAYS BE READ, even on a 400 or 401. `protocol_version = "HTTP/1.1"` means
        keep-alive, so an unread body stays in the socket and the next request on that connection
        starts parsing mid-JSON. The server then answers `501 Unsupported method '<garbage>'` with
        BaseHTTPRequestHandler's HTML error page -- and the failure lands on whichever request came
        NEXT, not on the one that skipped the read. That is how a missing `clientId` on one call
        turned into "POST /subscriptions: response is not valid JSON" on another.
        """
        self._raw_body = b""
        length = int(self.headers.get("Content-Length") or 0)
        if length > 0:
            self._raw_body = self.rfile.read(length)

    def _body(self) -> dict:
        if not getattr(self, "_raw_body", b""):
            return {}
        try:
            body = json.loads(self._raw_body.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            raise Problem(400, "Bad Request", "Request body is not valid JSON.")
        if not isinstance(body, dict):
            raise Problem(400, "Bad Request", "Request body must be a JSON object.")
        return body

    def _query(self) -> dict:
        from urllib.parse import parse_qs, urlparse

        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def _send(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, default=str).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        # "When i3X requests include Accept-Encoding: gzip, servers MUST respond with
        # Content-Encoding: gzip." A MUST, and the conformance suite has a dedicated check for it.
        if "gzip" in (self.headers.get("Accept-Encoding") or "").lower():
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
                gz.write(raw)
            raw = buf.getvalue()
            headers["Content-Encoding"] = "gzip"
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _ok(self, result, status: int = 200, detail: Optional[dict] = None) -> None:
        payload = {"success": True, "result": result}
        if detail:
            payload["responseDetail"] = detail
        self._send(status, payload)

    def _bulk(self, results: List[dict]) -> None:
        # A bulk response is 200 with per-item success, even when items failed: the request itself
        # succeeded. `success` at the top is the AND of the items, which is what the suite checks.
        self._send(
            200, {"success": all(r.get("success") for r in results), "results": results}
        )

    def _fail(self, status: int, title: str, detail: str) -> None:
        self._send(
            status,
            {
                "success": False,
                "responseDetail": {"title": title, "status": status, "detail": detail},
            },
        )

    def _bearer(self) -> str:
        auth = self.headers.get("Authorization") or ""
        if not auth.strip():
            raise Problem(
                401,
                "Unauthorized",
                "Authorization header is required. Only GET /info is unauthenticated.",
            )
        return auth

    def _pg(self) -> PostgrestClient:
        return PostgrestClient(self._bearer())

    # -- dispatch ----------------------------------------------------------------------------
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def _dispatch(self, method: str) -> None:
        self._read_body()
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if not path.startswith("/v1/") and path != "/v1":
            self._fail(
                404,
                "Not Found",
                f"Unknown path {path} -- i3X endpoints are prefixed with /v1 (spec: Versioning).",
            )
            return
        route = f"{method} {path[3:] or '/'}"
        handler = ROUTES.get(route)
        if handler is None:
            self._fail(404, "Not Found", f"No such i3X endpoint: {route}")
            return
        # Reset per request: a keep-alive connection reuses this handler for the next one.
        self.caller = None
        try:
            if route not in UNAUTHENTICATED_ROUTES:
                self.caller = _authenticate(self._bearer())
            handler(self)
        except Problem as exc:
            self._fail(exc.status, exc.title, exc.detail)
        except SubscriptionError as exc:
            self._fail(exc.status, exc.title, exc.detail)
        except requests.RequestException as exc:
            logger.warning("upstream error: %s", exc)
            self._fail(502, "Bad Gateway", f"Upstream data layer unreachable: {exc}")
        except Exception as exc:  # noqa: BLE001
            logger.exception("unhandled error on %s", route)
            self._fail(500, "Internal Server Error", str(exc))


# =================================================================================================
# Handlers
# =================================================================================================
def h_info(req: Handler) -> None:
    """MUST NOT require authentication -- it is also the health check."""
    req._ok(
        {
            "specVersion": SPEC_VERSION,
            "serverVersion": SERVER_VERSION,
            "serverName": SERVER_NAME,
            "capabilities": {
                "query": {"history": True},
                # Declared false AND not implemented. See the module docstring: the capability flag
                # and the 405 are two statements of one decision, and a client that trusts the flag
                # and a client that probes the verb must reach the same conclusion.
                "update": {"current": False, "history": False},
                "subscribe": {"stream": True},
            },
        }
    )


def h_namespaces(req: Handler) -> None:
    req._ok(A.namespaces(_build_types(_load_address_space(req._pg()))))


def _in_namespace(req: Handler, types: List[dict]) -> List[dict]:
    """`?namespaceUri=` keeps the types in that namespace; one that serves nothing gives []."""
    uri = req._query().get("namespaceUri")
    return [t for t in types if t["namespaceUri"] == uri] if uri else types


def h_objecttypes(req: Handler) -> None:
    req._ok(_in_namespace(req, _build_types(_load_address_space(req._pg()))))


def h_objecttypes_query(req: Handler) -> None:
    body = req._body()
    wanted = _require_element_ids(body, required=False)
    types = {t["elementId"]: t for t in _build_types(_load_address_space(req._pg()))}
    if not wanted:
        req._ok(list(types.values()))
        return
    req._bulk(
        [
            {"success": True, "elementId": eid, "result": types[eid]}
            if eid in types
            else {
                "success": False,
                "elementId": eid,
                "responseDetail": {
                    "title": "Not Found",
                    "status": 404,
                    "detail": f"No object type {eid!r}.",
                },
            }
            for eid in wanted
        ]
    )


def h_relationshiptypes(req: Handler) -> None:
    req._bearer()
    req._ok(_in_namespace(req, A.relationship_types()))


def h_relationshiptypes_query(req: Handler) -> None:
    req._bearer()
    wanted = _require_element_ids(req._body(), required=False)
    types = {t["elementId"]: t for t in A.relationship_types()}
    if not wanted:
        req._ok(list(types.values()))
        return
    req._bulk(
        [
            {"success": True, "elementId": eid, "result": types[eid]}
            if eid in types
            else {
                "success": False,
                "elementId": eid,
                "responseDetail": {
                    "title": "Not Found",
                    "status": 404,
                    "detail": f"No relationship type {eid!r}.",
                },
            }
            for eid in wanted
        ]
    )


def _strip_metadata(obj: dict, include: bool) -> dict:
    """`metadata` is returned only when asked for -- it is the expensive half of an Object."""
    if include:
        return obj
    return {k: v for k, v in obj.items() if k != "metadata"}


def _not_found(element_id: str, kind: str) -> dict:
    return {
        "success": False,
        "elementId": element_id,
        "responseDetail": {
            "title": "Not Found",
            "status": 404,
            "detail": "No %s %r visible to this caller." % (kind, element_id),
        },
    }


def h_objects(req: "Handler") -> None:
    query = req._query()
    objects = _build_objects(_load_address_space(req._pg()))
    items = list(objects.values())
    type_filter = query.get("typeElementId")
    if type_filter:
        items = [o for o in items if o["typeElementId"] == type_filter]
    if query.get("root") == "true":
        # Exactly one object has `parentId: null` -- the synthetic site. Everything else hangs off
        # it, including Unassigned, which is what stops a device with no cell becoming a second root.
        items = [o for o in items if o["parentId"] is None]
    include_metadata = query.get("includeMetadata") == "true"
    req._ok([_strip_metadata(o, include_metadata) for o in items])


def h_objects_list(req: "Handler") -> None:
    body = req._body()
    wanted = _require_element_ids(body)
    include_metadata = body.get("includeMetadata") is True
    objects = _build_objects(_load_address_space(req._pg()))
    # Bulk results MUST come back in the order requested -- the suite has a dedicated check
    # (`badbulk`), because a client pairing responses to requests positionally would otherwise
    # mis-attribute every value in the batch.
    req._bulk(
        [
            {
                "success": True,
                "elementId": eid,
                "result": _strip_metadata(objects[eid], include_metadata),
            }
            if eid in objects
            else _not_found(eid, "object")
            for eid in wanted
        ]
    )


def h_objects_related(req: "Handler") -> None:
    """
    Edges out of each requested object, as `{sourceRelationship, object}` pairs.

    Bulk over `elementIds`, not a single `elementId`: relationship traversal is the expensive
    operation in a browse client, and answering one element per round trip is what makes an
    exploratory UI feel slow against a remote server.
    """
    body = req._body()
    wanted = _require_element_ids(body)
    wanted_type = body.get("relationshipType")
    include_metadata = body.get("includeMetadata") is True
    objects = _build_objects(_load_address_space(req._pg()))

    results = []
    for eid in wanted:
        obj = objects.get(eid)
        if obj is None:
            results.append(_not_found(eid, "object"))
            continue
        edges = []
        rels = (obj.get("metadata") or {}).get("relationships") or {}
        for rel_name, targets in rels.items():
            if wanted_type and rel_name != wanted_type:
                continue
            for target in targets:
                if target in objects:
                    edges.append(
                        {
                            "sourceRelationship": rel_name,
                            "object": _strip_metadata(objects[target], include_metadata),
                        }
                    )
        results.append({"success": True, "elementId": eid, "result": edges})
    req._bulk(results)


def _component_ids(objects, element_id: str, budget) -> list:
    """Flat list of HasComponent descendants within the depth budget. `budget < 0` is unbounded."""
    out, seen = [], set()

    def walk(eid: str, remaining) -> None:
        if remaining == 0:
            return
        obj = objects.get(eid) or {}
        rels = (obj.get("metadata") or {}).get("relationships") or {}
        for child in rels.get("HasComponent", []):
            if child in seen or child not in objects:
                continue
            seen.add(child)
            out.append(child)
            walk(child, remaining if remaining < 0 else remaining - 1)

    walk(element_id, budget)
    return out


def _current_value(objects, space: dict, element_id: str):
    """The bare {value, quality, timestamp} for one object, or None if it is not in the space."""
    obj = objects.get(element_id)
    if obj is None:
        return None
    # Built once by _build_objects(); see the note there. Falling back to a fresh index keeps this
    # function correct if it is ever called with a `space` that did not come through that path.
    gateways_by_sid = space.get("_gateways_by_sid") or {g["sparkplug_id"]: g for g in space["gateways"]}
    if element_id in gateways_by_sid:
        return A.gateway_value(gateways_by_sid[element_id])
    devices_by_sid = space.get("_devices_by_sid") or {d["sparkplug_id"]: d for d in space["devices"]}
    if element_id in devices_by_sid:
        return A.device_value(devices_by_sid[element_id], metrics_for(element_id))
    # A metric: `<sparkplug_id>/<metric name>`, split at the first `/`.
    sid, _, name = element_id.partition("/")
    if name and sid in devices_by_sid:
        return A.device_metric_value(devices_by_sid[sid], element_id, metrics_for(sid).get(name))
    # A container's value is what its type declares. Counts are of devices, never of children:
    # a cell's children include its gateways, and the site's are cells and Unassigned.
    if element_id == A.SITE_ELEMENT_ID:
        return A.site_value(len(space["cells"]), len(devices_by_sid))
    rels = (obj.get("metadata") or {}).get("relationships") or {}
    return A.cell_value(obj, sum(1 for c in rels.get("HasChildren", []) if c in devices_by_sid))


def h_objects_value(req: "Handler") -> None:
    """
    Current values.

    THE RLS GATE IS `_build_objects`, not the value cache. The address space is assembled from
    PostgREST reads made with the caller's own token, so an element the caller cannot see is simply
    absent from `objects` and reports as not found -- indistinguishable from one that does not
    exist. The MQTT cache is only ever consulted for an id that survived that step, which is what
    stops it becoming a way to read every device on the site.
    """
    body = req._body()
    wanted = _require_element_ids(body)
    max_depth = _max_depth(body)
    space = _load_address_space(req._pg())
    objects = _build_objects(space)

    results = []
    for eid in wanted:
        vqt = _current_value(objects, space, eid)
        if vqt is None:
            results.append(_not_found(eid, "object"))
            continue
        obj = objects[eid]
        result = {
            "isComposition": obj["isComposition"],
            "value": vqt["value"],
            "quality": vqt["quality"],
            "timestamp": vqt["timestamp"],
        }
        if obj["isComposition"] and max_depth != 1:
            # maxDepth 0 means unbounded; anything above 1 descends that many levels.
            budget = -1 if max_depth == 0 else max_depth - 1
            components = {}
            for child in _component_ids(objects, eid, budget):
                child_vqt = _current_value(objects, space, child)
                if child_vqt:
                    components[child] = {
                        "value": child_vqt["value"],
                        "quality": child_vqt["quality"],
                        "timestamp": child_vqt["timestamp"],
                    }
            result["components"] = components
        results.append({"success": True, "elementId": eid, "result": result})
    req._bulk(results)


RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}")


def _read_telemetry(pg: PostgrestClient, element_id: str, start, end, limit: int) -> List[dict]:
    """One device's raw samples in [start, end], newest first."""
    return pg.get(
        "telemetry",
        {
            "select": "time,metric_name,val_double,val_string,val_bool",
            "asset_id": "eq." + element_id,
            "time": "gte." + str(start),
            "and": "(time.lte." + str(end) + ")",
            "order": "time.desc",
            "limit": str(limit),
        },
    )


def h_objects_history(req: "Handler") -> None:
    """
    History comes from TimescaleDB through PostgREST, never from the value cache.

    `public.telemetry` is a `postgres_fdw` projection, so this read crosses the wrapper and carries
    the caller's token like every other read. startTime and endTime are REQUIRED: an unbounded
    history query over a hypertable is not a slow request, it is an availability incident, and the
    spec makes both mandatory for that reason.
    """
    body = req._body()
    wanted = _require_element_ids(body)
    start, end = body.get("startTime"), body.get("endTime")
    if not start or not end:
        raise Problem(400, "Bad Request", "startTime and endTime are required.")
    if not RFC3339.match(str(start)) or not RFC3339.match(str(end)):
        raise Problem(400, "Bad Request", "startTime and endTime must be valid RFC 3339 timestamps.")
    limit = min(_int_field(body, "limit", 1000, 1), 10000)
    max_depth = _max_depth(body)

    pg = req._pg()
    space = _load_address_space(pg)
    objects = _build_objects(space)
    device_sids = set(d["sparkplug_id"] for d in space["devices"])

    def samples_for(eid: str) -> list:
        # Only devices carry telemetry. A cell has no series of its own, and an empty list is the
        # honest answer -- inventing an aggregate would assert a measurement nobody took.
        if eid not in device_sids:
            return []
        rows = _read_telemetry(pg, eid, start, end, limit)
        out = []
        for row in rows:
            value = row.get("val_double")
            if value is None:
                value = row.get("val_string")
            if value is None:
                value = row.get("val_bool")
            out.append(
                {
                    "value": value,
                    "quality": "Good" if value is not None else "GoodNoData",
                    "timestamp": A.to_rfc3339_utc(row.get("time")),
                }
            )
        return out

    results = []
    for eid in wanted:
        obj = objects.get(eid)
        if obj is None:
            results.append(_not_found(eid, "object"))
            continue
        try:
            result = {"isComposition": obj["isComposition"], "values": samples_for(eid)}
            if obj["isComposition"] and (max_depth == 0 or max_depth > 1):
                budget = -1 if max_depth == 0 else max_depth - 1
                result["components"] = dict(
                    (child, {"values": samples_for(child)})
                    for child in _component_ids(objects, eid, budget)
                )
        except SubscriptionError as exc:
            results.append(
                {
                    "success": False,
                    "elementId": eid,
                    "responseDetail": {
                        "title": exc.title,
                        "status": exc.status,
                        "detail": exc.detail,
                    },
                }
            )
            continue
        results.append({"success": True, "elementId": eid, "result": result})
    req._bulk(results)


def h_update_refused(req: Handler) -> None:
    """
    `PUT /objects/value` and `/objects/history` -- 405, deliberately and permanently.

    Update is a MAY, `GET /info` declares it false, and this is the durable half of that statement:
    a capability flag is advice, an unimplemented verb is a fact. The `Allow` header names what the
    resource does support, which is what 405 is for.
    """
    req.send_response(405)
    req.send_header("Allow", "POST")
    body = json.dumps(
        {
            "success": False,
            "responseDetail": {
                "title": "Method Not Allowed",
                "status": 405,
                "detail": (
                    "This i3X server is read-only. Update is optional in i3X 1.0 and GET /info "
                    "declares update.current and update.history false. Writes belong on the "
                    "Sparkplug B command path, where they are audited."
                ),
            },
        }
    ).encode("utf-8")
    req.send_header("Content-Type", "application/json")
    req.send_header("Content-Length", str(len(body)))
    req.end_headers()
    req.wfile.write(body)


# -- subscriptions ----------------------------------------------------------------------------
def _owned_subscription(req: Handler, client_id: str, body: dict):
    """The subscription named in the body, if this clientId AND this principal own it; else 404."""
    return registry.get_owned(
        client_id, body.get("subscriptionId") or "", principal=req.caller.principal
    )


def h_sub_create(req: Handler) -> None:
    body = req._body()
    client_id = _require_client_id(body)
    sub = registry.create(
        client_id, body.get("displayName") or "", principal=req.caller.principal
    )
    req._ok(
        {
            "clientId": client_id,
            "subscriptionId": sub.subscription_id,
            "displayName": sub.display_name,
        }
    )


def h_sub_list(req: Handler) -> None:
    body = req._body()
    client_id = _require_client_id(body)
    req._bulk(
        registry.list_owned(
            client_id, body.get("subscriptionIds") or [], principal=req.caller.principal
        )
    )


def h_sub_delete(req: Handler) -> None:
    body = req._body()
    client_id = _require_client_id(body)
    results = []
    for sid in body.get("subscriptionIds") or []:
        try:
            registry.delete(client_id, sid, principal=req.caller.principal)
        except SubscriptionError as exc:
            results.append(
                {
                    "success": False,
                    "subscriptionId": sid,
                    "responseDetail": {
                        "title": exc.title,
                        "status": exc.status,
                        "detail": exc.detail,
                    },
                }
            )
        else:
            results.append({"success": True, "subscriptionId": sid, "result": None})
    req._bulk(results)


def _registration_entries(body: dict) -> list:
    """
    The objects a subscription request wants registered, normalised and capped.

    TWO ACCEPTED SHAPES: `objects` (dictionaries) or `elementIds` (strings). Capped through the
    same helper the bulk READ endpoints use, and this is the path where the cap earns most: a
    registration does not merely produce a response, it adds to the client's monitored set, which
    outlives the request and is what every later poll is evaluated against.
    """
    raw = body.get("objects") or body.get("elementIds") or []
    if not isinstance(raw, list):
        raise Problem(400, "Bad Request", "objects (or elementIds) must be an array.")
    return [
        {"elementId": e} if isinstance(e, str) else (e or {})
        for e in _cap_bulk(raw, "objects" if body.get("objects") else "elementIds")
    ]


def h_sub_register(req: Handler) -> None:
    """
    Register objects, rejecting unknown ones PER ITEM.

    Registration is validated against the caller's own address space, not accepted blindly. Two
    reasons, and the second is the one that matters: an unknown elementId that registers
    "successfully" produces a subscription that will never emit anything, and the client has no way
    to tell that from a machine that is simply quiet -- it waits forever for a value that cannot
    arrive. Validating here also means the monitored set can only ever contain ids this caller is
    allowed to see, so the subscription cannot become a way around RLS on the value path.
    """
    body = req._body()
    client_id = _require_client_id(body)
    sub = _owned_subscription(req, client_id, body)
    entries = _registration_entries(body)
    known = _build_objects(_load_address_space(req._pg())) if entries else {}

    valid, results = [], []
    for entry in entries:
        eid = entry.get("elementId")
        if not eid:
            results.append(
                {
                    "success": False,
                    "elementId": eid,
                    "responseDetail": {
                        "title": "Bad Request",
                        "status": 400,
                        "detail": "elementId is required.",
                    },
                }
            )
        elif eid not in known:
            results.append(_not_found(eid, "object"))
        else:
            valid.append(entry)
    registry.register(sub, valid)
    results.extend(
        {"success": True, "elementId": e["elementId"], "result": None} for e in valid
    )
    # Requested order, not valid-then-invalid: a client pairing responses positionally would
    # otherwise mis-attribute every result in the batch.
    order = {e.get("elementId"): i for i, e in enumerate(entries)}
    results.sort(key=lambda r: order.get(r.get("elementId"), 0))
    req._bulk(results)


def h_sub_unregister(req: Handler) -> None:
    """
    Unregister objects, reporting unknown ones per item.

    Removing something that was never registered is NOT an error -- the end state the client asked
    for is the end state it gets -- but an elementId that does not exist at all is, because it means
    the client is working from a stale or wrong view of the address space and silence would let it
    keep doing so.
    """
    body = req._body()
    client_id = _require_client_id(body)
    sub = _owned_subscription(req, client_id, body)
    entries = _registration_entries(body)
    known = _build_objects(_load_address_space(req._pg())) if entries else {}

    results, removable = [], []
    for entry in entries:
        eid = entry.get("elementId")
        if not eid or eid not in known:
            results.append(_not_found(eid or "", "object"))
        else:
            removable.append(eid)
    registry.unregister(sub, removable)
    results.extend({"success": True, "elementId": eid, "result": None} for eid in removable)
    order = {e.get("elementId"): i for i, e in enumerate(entries)}
    results.sort(key=lambda r: order.get(r.get("elementId"), 0))
    req._bulk(results)


def h_sub_sync(req: Handler) -> None:
    body = req._body()
    client_id = _require_client_id(body)
    sub = _owned_subscription(req, client_id, body)
    batches, status = registry.sync(sub, body.get("lastSequenceNumber"))
    detail = None
    if status == 206:
        detail = {
            "title": "Updates dropped due to queue overflow",
            "status": 206,
            "detail": (
                f"Updates were dropped from the subscription queue. The server limit is "
                f"{registry.queue_limit} batches."
            ),
        }
    req._ok(batches, status=status, detail=detail)


def h_sub_stream(req: Handler) -> None:
    body = req._body()
    client_id = _require_client_id(body)
    sub = _owned_subscription(req, client_id, body)
    _serve_stream(req, sub, registry.open_stream(sub), req._bearer(), req.caller)


ROUTES = {
    "GET /info": h_info,
    "GET /namespaces": h_namespaces,
    "GET /objecttypes": h_objecttypes,
    "POST /objecttypes/query": h_objecttypes_query,
    "GET /relationshiptypes": h_relationshiptypes,
    "POST /relationshiptypes/query": h_relationshiptypes_query,
    "GET /objects": h_objects,
    "POST /objects/list": h_objects_list,
    "POST /objects/related": h_objects_related,
    "POST /objects/value": h_objects_value,
    "POST /objects/history": h_objects_history,
    "PUT /objects/value": h_update_refused,
    "PUT /objects/history": h_update_refused,
    "POST /subscriptions": h_sub_create,
    "POST /subscriptions/list": h_sub_list,
    "POST /subscriptions/delete": h_sub_delete,
    "POST /subscriptions/register": h_sub_register,
    "POST /subscriptions/unregister": h_sub_unregister,
    "POST /subscriptions/sync": h_sub_sync,
    "POST /subscriptions/stream": h_sub_stream,
}


# =================================================================================================
# MQTT
# =================================================================================================
def _ms_to_iso(ms) -> Optional[str]:
    if not ms:
        return None
    try:
        return (
            datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except (ValueError, OSError, OverflowError):
        return None


def decode_metrics(raw: bytes) -> Optional[List[dict]]:
    """
    Decode a Sparkplug B payload to plain metric dicts, protobuf first and JSON second.

    THE JSON ARM IS NOT OPTIONAL, and its absence is not a decode warning -- it is total silence on
    the value path. `node_red_flow.json`, which is what the demo stack and every E2E run publish
    with, emits the JSON encoding; protobuf-only parsing raises `Wire format was corrupt` on every
    single DDATA and the i3X server serves `GoodNoData` for a fleet that is publishing perfectly.
    `ingestion.py::parse_sparkplug_payload` carries the same two arms for the same reason; keep them
    in step.

    Returns None when neither arm decodes, which the caller treats as "not a Sparkplug payload" --
    `spBv1.0/STATE/...` birth certificates are plain text and legitimately land here.
    """
    try:
        import sparkplug_b_pb2

        payload = sparkplug_b_pb2.Payload()
        payload.ParseFromString(raw)
        out = []
        for metric in payload.metrics:
            which = metric.WhichOneof("value")
            out.append(
                {
                    "name": metric.name or None,
                    "alias": metric.alias if metric.HasField("alias") else None,
                    "datatype": metric.datatype or None,
                    "field": which,
                    "value": getattr(metric, which) if which and which not in UNSERVED_VALUE_FIELDS else None,
                    "timestamp": _ms_to_iso(metric.timestamp),
                }
            )
        return out
    except Exception:  # noqa: BLE001 -- fall through to the JSON encoding
        pass

    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    payload_ts = data.get("timestamp")
    out = []
    for m in data.get("metrics") or []:
        value, field = None, None
        for key in ("double_value", "int_value", "string_value", "boolean_value", "value"):
            if m.get(key) is not None:
                value, field = m[key], key
                break
        datatype = m.get("datatype")
        if not isinstance(datatype, int) or isinstance(datatype, bool):
            datatype = None
        # Marked Int32 as ingestion's JSON arm marks it, so an undeclared negative reads as itself.
        if field == "int_value" and datatype is None and isinstance(value, int) and -(2**31) <= value < 0:
            datatype = 3
        out.append(
            {
                "name": m.get("name") or None,
                "alias": m.get("alias"),
                "datatype": datatype,
                "field": field,
                "value": value,
                "timestamp": _ms_to_iso(m.get("timestamp") or payload_ts),
            }
        )
    return out


def on_message(client, userdata, msg):  # noqa: ARG001
    try:
        parts = msg.topic.split("/")
        if len(parts) < 4:
            return
        group_id, msg_type, edge_node_id = parts[1], parts[2], parts[3]
        device_id = parts[4] if len(parts) > 4 else None

        metrics = decode_metrics(msg.payload)
        if metrics is None:
            logger.debug("undecodable payload on %s; ignoring", msg.topic)
            return

        if msg_type == "NBIRTH":
            register_birth_aliases(group_id, edge_node_id, metrics, reset=True)
            return
        if msg_type == "DBIRTH":
            register_birth_aliases(group_id, edge_node_id, metrics, device_id=device_id)
        if msg_type not in ("DBIRTH", "DDATA") or not device_id:
            return

        named = {}
        for metric in metrics:
            name = resolve_metric_name(group_id, edge_node_id, metric)
            if not name or name in IDENTITY_METRICS:
                # Identity metrics are wire plumbing, not observations -- the same reason ingestion
                # excludes them from `last_birth_metrics`. Including them here would make every
                # conformant device report two values no schema models.
                continue
            if metric.get("field") in UNSERVED_VALUE_FIELDS:
                continue
            value = metric_value(group_id, edge_node_id, device_id, name, metric)
            record_value(device_id, name, value, metric["timestamp"])
            named[name] = {"value": value, "timestamp": metric["timestamp"]}
        if named and device_id in registry.monitored_element_ids():
            _stage_and_push(device_id, metrics_for(device_id))
    except Exception:  # noqa: BLE001
        logger.exception("failed to handle %s", msg.topic)


def start_mqtt():
    import paho.mqtt.client as mqtt

    # MQTT 5 with paho 1.6.1's v1 callback API -- the protocol and the callback style are separate
    # choices, and only paho 2.x would force the latter to move. NOT for the DISCONNECT reason
    # code: mosquitto sends one and paho 1.6.1 discards it (measured; see ingestion.py's
    # on_disconnect). This is on v5 because the rest of the platform is.
    client = mqtt.Client(client_id=f"i3x-service-{os.getpid()}", protocol=mqtt.MQTTv5)
    if MQTT_USER and MQTT_PASSWORD:
        client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    if MQTT_TLS_ENABLED:
        if not MQTT_TLS_CA_FILE or not os.path.exists(MQTT_TLS_CA_FILE):
            # Fails closed. TLS that does not verify is indistinguishable from a successful
            # interception, so a missing CA stops startup rather than degrading to plaintext.
            raise SystemExit(
                f"MQTT_TLS_ENABLED is set but the CA file {MQTT_TLS_CA_FILE!r} is missing."
            )
        client.tls_set(ca_certs=MQTT_TLS_CA_FILE)

    # `properties` is the MQTT 5 signature and defaults so the function is callable under either
    # protocol. `rc` is a ReasonCodes under v5 and `== 0` still holds -- paho's ReasonCodes.__eq__
    # compares against int.
    def on_connect(c, u, f, rc, properties=None):  # noqa: ARG001
        if rc == 0:
            logger.info("MQTT connected; subscribing to spBv1.0/#")
            c.subscribe("spBv1.0/#", qos=0)
        else:
            logger.error("MQTT connection refused, rc=%s", rc)

    def on_disconnect(c, u, rc, properties=None):  # noqa: ARG001
        # BEFORE THIS THERE WAS NO on_disconnect, so a drop was silent. A ReasonCodes here would
        # mean the broker stated a reason; on paho 1.6.1 that does not happen even under v5, so in
        # practice this reports paho's own MQTT_ERR_CONN_LOST. The branch stays because a newer
        # paho would take it. A log line either way -- the loop below reconnects and should.
        if rc == 0:
            return
        if isinstance(rc, int):
            logger.warning("MQTT connection dropped (paho rc=%s); no reason from the broker. "
                           "Reconnecting.", rc)
        else:
            logger.warning("MQTT disconnected by the broker: %s (reason code %s). Reconnecting.",
                           rc, int(rc.value))

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    def run():
        while True:
            try:
                # v5's spelling of clean_session. NO SESSION EXPIRY INTERVAL: Sparkplug's
                # NDEATH is the Last Will, and a surviving session would delay it.
                client.connect(MQTT_HOST, MQTT_PORT, 60, clean_start=True)
                client.loop_forever()
            except Exception as exc:  # noqa: BLE001
                logger.warning("MQTT connection failed: %s; retrying in 5s", exc)
                time.sleep(5)

    threading.Thread(target=run, name="mqtt", daemon=True).start()
    return client


def start_reaper():
    def run():
        while True:
            time.sleep(REAPER_INTERVAL_SECONDS)
            try:
                for sid in registry.reap():
                    logger.info("reaped idle subscription %s", sid)
            except Exception:  # noqa: BLE001
                logger.exception("subscription reaper failed")

    threading.Thread(target=run, name="reaper", daemon=True).start()


def main():
    # THE ONE STARTUP REFUSAL. This process must never hold a service-role key: it authenticates the
    # caller and queries as them, and a key in the environment would let a future code path bypass
    # RLS for the whole address space. Refusing to start is the only check that cannot be forgotten,
    # and it turns a silent privilege escalation into a container that will not boot.
    if os.getenv("SUPABASE_SERVICE_ROLE_KEY"):
        raise SystemExit(
            "SUPABASE_SERVICE_ROLE_KEY is set in this process's environment. The i3X service "
            "queries PostgREST as the CALLER so that RLS applies to the address space; holding a "
            "service-role key would defeat that. Remove it from the i3x-service environment."
        )
    if not SUPABASE_GATEWAY_KEY:
        logger.warning(
            "SUPABASE_PUBLISHABLE_KEY is not set -- PostgREST reads will be refused by the "
            "gateway."
        )

    start_mqtt()
    start_reaper()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    server.daemon_threads = True
    logger.info(
        "i3X %s server listening on http://%s:%d/v1 (subscriptions: ttl=%ss queue=%d)",
        SPEC_VERSION,
        LISTEN_HOST,
        LISTEN_PORT,
        SUBSCRIPTION_TTL_SECONDS,
        SUBSCRIPTION_QUEUE_LIMIT,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
