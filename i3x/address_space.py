"""
Projection of the platform's model onto the i3X 1.0 address space.

i3X INTRODUCES NO NEW TYPE SYSTEM, which is why this is a projection rather than a schema.
ObjectTypes ARE JSON Schema and `schemas.schema_definition` already stores JSON Schema, so a schema
row is an ObjectType with no translation at all.

The mappings that are decisions rather than mechanics -- elementId is `sparkplug_id` and displayName
is `name`, so renaming an asset does not move it here; `parentId` is WHERE an asset is (its cell,
else its area, else the site) and the data path is a separate relationship pair; location is
`HasParent`/`HasChildren` only, and `HasComponent` is kept for the metrics a device's value is
composed of; Unassigned and the Simulated and Shadow lanes are SYNTHETIC objects with no table behind
them; and `quality` is derived at READ TIME, never stored -- are set out in README.md -> "Address
space".

EVERY READ HERE GOES THROUGH PostgREST AS THE CALLER. There is no service-role key in this process
(see `PostgrestClient`), which is what makes the i3X address space obey the same RLS as the
dashboard, and it is why values are gated on a metadata read rather than served straight from the
MQTT cache -- that cache has no RLS of its own.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from functools import lru_cache
from typing import Dict, List, Optional

# The synthetic objects. Prefixed so they cannot collide with a sparkplug_id (24 chars, `gwy`/`dev`)
# or a UUID.
SITE_ELEMENT_ID = "i3x:site"
UNASSIGNED_ELEMENT_ID = "i3x:unassigned"
# The root's displayName is this `system_settings` key's value, the one the UNS bridge publishes
# under; the fallback stands in while it is empty.
SITE_NAME_SETTING = "site.name"
SITE_FALLBACK_NAME = "Site"

# The `device_locations.location_source` labels placement reads; ingestion/uns_publish.py mirrors
# the same set. test_i3x_service.py holds these to the view's own labels.
SOURCE_SHADOW = "shadow"
SOURCE_SIMULATED = "simulated"
SOURCE_SITE_WIDE = "site_wide"
SOURCE_AREA_WIDE = "area_wide"
SOURCE_EXPLICIT = "explicit"
SOURCE_UNASSIGNED = "unassigned"

# One synthetic parent per lane: (elementId, displayName, description). A lane is a fact about the
# gateway, not a place, and exists in the space only while something is in it.
LANES = {
    SOURCE_SIMULATED: (
        "i3x:lane:simulated",
        "Simulated",
        "Assets behind a simulated gateway: their telemetry is generated rather than observed. "
        "Synthetic, and not a place: such an asset cannot be filed in a cell.",
    ),
    SOURCE_SHADOW: (
        "i3x:lane:shadow",
        "Shadow",
        "Assets behind a playback gateway: recorded captures of real machines, republished. "
        "Synthetic, and not a place: such an asset cannot be filed in a cell.",
    ),
}

# Namespaces. i3X groups TYPES into namespaces, and every type served here is this deployment's own:
# a schema is a JSON Schema authored here even when every metric it names comes from a standard.
# So GET /namespaces lists these two and nothing else, and every Object's typeNamespaceUri is the
# local one. A vocabulary such as MTConnect is where a metric's semantic id comes from, not a
# namespace any type belongs to; listing one would promise types a client never meets (#459).
NS_LOCAL = "https://aber.local/i3x"
NS_RELATIONSHIPS = "https://aber.local/i3x/relationships"

# Synthetic ObjectTypes for the levels that have no `schemas` row. Areas, cells and gateways are
# infrastructure, not modelled equipment; giving them a real schema row would put them in the
# registry the Schemas tab manages, where an operator could version or archive them. A lane and
# Unassigned are groupings that claim no place, so neither is typed as a cell; Unassigned is not a
# lane either, so it has a type of its own.
SITE_TYPE_ID = "i3x:type:site"
AREA_TYPE_ID = "i3x:type:area"
CELL_TYPE_ID = "i3x:type:cell"
LANE_TYPE_ID = "i3x:type:lane"
UNASSIGNED_TYPE_ID = "i3x:type:unassigned"
GATEWAY_TYPE_ID = "i3x:type:gateway"
UNTYPED_DEVICE_TYPE_ID = "i3x:type:device"

SYNTHETIC_TYPES = [
    {
        "elementId": SITE_TYPE_ID,
        "displayName": "Site",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Site",
        "version": "1.0.0",
        "schema": {
            "type": "object",
            "properties": {"cellCount": {"type": "number"}, "deviceCount": {"type": "number"}},
        },
    },
    {
        "elementId": AREA_TYPE_ID,
        "displayName": "Area",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Area",
        "version": "1.0.0",
        "schema": {
            "type": "object",
            "properties": {
                "cellCount": {"type": "number"},
                "deviceCount": {"type": "number"},
                "description": {"type": ["string", "null"]},
            },
        },
    },
    {
        "elementId": CELL_TYPE_ID,
        "displayName": "Cell",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Cell",
        "version": "1.0.0",
        "schema": {
            "type": "object",
            "properties": {
                "deviceCount": {"type": "number"},
                "description": {"type": ["string", "null"]},
            },
        },
    },
    {
        "elementId": LANE_TYPE_ID,
        "displayName": "Lane",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Lane",
        "version": "1.0.0",
        "schema": {
            "type": "object",
            "properties": {
                "deviceCount": {"type": "number"},
                "description": {"type": ["string", "null"]},
            },
        },
    },
    {
        "elementId": UNASSIGNED_TYPE_ID,
        "displayName": "Unassigned",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Unassigned",
        "version": "1.0.0",
        "schema": {
            "type": "object",
            "properties": {
                "deviceCount": {"type": "number"},
                "description": {"type": ["string", "null"]},
            },
        },
    },
    {
        "elementId": GATEWAY_TYPE_ID,
        "displayName": "Edge Gateway",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Gateway",
        "version": "1.0.0",
        "schema": {
            "type": "object",
            "properties": {
                # An open label, as the gateway_status view derives it: ONLINE, OFFLINE, STALE,
                # an enrolment state, or a status the gateway reports itself.
                "status": {"type": "string"},
                "sparkplugGroup": {"type": "string"},
                "lastHeartbeat": {"type": ["string", "null"]},
            },
            "required": ["status"],
        },
    },
    {
        "elementId": UNTYPED_DEVICE_TYPE_ID,
        "displayName": "Unmodelled Device",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Device",
        "version": "1.0.0",
        # A device with no schema attached. Deliberately open rather than empty: it publishes real
        # metrics, we simply have no model that names them, which is a different statement from
        # "it has no properties".
        "schema": {"type": "object", "additionalProperties": True},
    },
]
_SYNTHETIC_SOURCE_TYPE_IDS = {t["elementId"]: t["sourceTypeId"] for t in SYNTHETIC_TYPES}

# Relationship types, registered in both directions. `reverseOf` is a MUST-have pair: the conformance
# suite checks that following a relationship and then its reverse returns you to where you started,
# and a one-way registration fails that.
RELATIONSHIP_TYPES = [
    (
        "HasParent",
        "HasChildren",
        "Organizational parent: where this object is. An asset's is its cell, else its area, else "
        "the site; a simulated or replayed asset's is its lane; one nobody has placed is under "
        "Unassigned. Location is never composition.",
    ),
    (
        "HasChildren",
        "HasParent",
        "Organizational children: the areas, cells, lanes and assets filed under this object. Each "
        "is independently valued, and a value query never returns them, whatever its maxDepth.",
    ),
    (
        "HasComponent",
        "ComponentOf",
        "The metrics a device's value is composed of. Each is an Object of its own, so one metric "
        "can be read or subscribed to alone, and a value query with maxDepth > 1 returns them under "
        "`components`. Only a device publishes it: the site, areas, cells and lanes organise their "
        "children and compose nothing.",
    ),
    ("ComponentOf", "HasComponent", "The device whose value this metric is part of."),
    (
        "ConnectsVia",
        "ProvidesConnectivityFor",
        "The edge gateway carrying this device's Sparkplug B traffic. This is the DATA PATH, which is "
        "deliberately not the same edge as HasParent -- a device's location and its connectivity are "
        "independent facts here.",
    ),
    (
        "ProvidesConnectivityFor",
        "ConnectsVia",
        "Devices whose Sparkplug B traffic arrives through this gateway.",
    ),
]


def relationship_types() -> List[dict]:
    return [
        {
            "elementId": rid,
            "displayName": rid,
            "namespaceUri": NS_RELATIONSHIPS,
            "relationshipId": rid,
            "reverseOf": rev,
            "metadata": {"description": desc},
        }
        for rid, rev, desc in RELATIONSHIP_TYPES
    ]


def namespaces(object_types: Optional[List[dict]] = None) -> List[dict]:
    """
    The namespaces the served types belong to: the local one, the relationships', and each one a
    metric type takes from its standard. Exactly those, so `object_types` is what is served.
    """
    standards = {t["namespaceUri"] for t in object_types or []} - {NS_LOCAL, NS_RELATIONSHIPS}
    return [
        {"uri": NS_LOCAL, "displayName": "Aber Local"},
        {"uri": NS_RELATIONSHIPS, "displayName": "Aber Relationships"},
    ] + [{"uri": uri, "displayName": _namespace_display_name(uri)} for uri in sorted(standards)]


def schema_source_type_id(row: dict) -> str:
    """
    A schema type's `sourceTypeId`, which its devices carry too: the semantic id when there is
    one, the identifier of the concept the type instantiates, else the name.
    """
    return row.get("semantic_id") or row.get("schema_name") or row["id"]


def _schema_definition(row: dict) -> dict:
    definition = row.get("schema_definition")
    if not isinstance(definition, dict):
        # A schema whose definition is unreadable is reported as an object with unknown properties
        # rather than dropped. "Has a model we cannot parse" and "has no model" are different
        # findings, the same distinction deviceTags.js makes for Unmodelled.
        definition = {"type": "object", "additionalProperties": True}
    return definition


def object_type_from_schema(row: dict) -> dict:
    """A `schemas` row is an ObjectType with no translation -- its definition IS JSON Schema."""
    return {
        "elementId": row["id"],
        "displayName": row.get("schema_name") or row["id"],
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": schema_source_type_id(row),
        "version": str(row.get("version") or "1"),
        "schema": _schema_definition(row),
        "metadata": {
            "description": row.get("description") or row.get("change_description") or None,
            "status": row.get("status"),
        },
    }


SCHEMA_SET_TYPE_PREFIX = "i3x:type:schemas:"


def schema_set_type_id(schema_ids) -> str:
    """The type of a device with several schemas, named by their sorted ids so any order agrees."""
    return SCHEMA_SET_TYPE_PREFIX + "+".join(sorted(schema_ids))


def schema_set_type(rows: List[dict]) -> dict:
    """
    The type of every device carrying exactly these schemas: a kind of each, so `allOf` over their
    definitions, inlined rather than referenced. `sourceTypeId` is its own id: no source namespace
    defines the combination.
    """
    ordered = sorted(rows, key=lambda row: row["id"])
    type_id = schema_set_type_id(row["id"] for row in ordered)
    names = [row.get("schema_name") or row["id"] for row in ordered]
    return {
        "elementId": type_id,
        "displayName": " + ".join(names),
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": type_id,
        "version": "1.0.0",
        "schema": {"type": "object", "allOf": [_schema_definition(row) for row in ordered]},
        "related": {"relationshipType": "InheritsFrom", "types": [row["id"] for row in ordered]},
        "metadata": {
            "description": "Every schema attached to the device: " + ", ".join(names) + ".",
            "status": None,
        },
    }


# -------------------------------------------------------------------------------------------------
# Metric types. A catalog row is the type of that metric on every device; a metric the catalog does
# not hold is typed by the Sparkplug datatype its DBIRTH declared, or UnknownType.
# -------------------------------------------------------------------------------------------------
METRIC_TYPE_PREFIX = "i3x:type:metric:"
SPARKPLUG_TYPE_PREFIX = "i3x:type:sparkplug:"
UNKNOWN_TYPE_ID = "i3x:type:unknown"

# Sparkplug B datatype code -> (name, JSON type of the value this server serves). DateTime is served
# as epoch milliseconds. A code not listed has no scalar form here.
SPARKPLUG_SCALARS = {
    1: ("Int8", "integer"), 2: ("Int16", "integer"), 3: ("Int32", "integer"),
    4: ("Int64", "integer"), 5: ("UInt8", "integer"), 6: ("UInt16", "integer"),
    7: ("UInt32", "integer"), 8: ("UInt64", "integer"), 9: ("Float", "number"),
    10: ("Double", "number"), 11: ("Boolean", "boolean"), 12: ("String", "string"),
    13: ("DateTime", "integer"), 14: ("Text", "string"), 15: ("UUID", "string"),
}

# Always served, so every metric's typeElementId resolves. UnknownType's schema is `{}` rather than
# the guide's `{"type": "object"}`: a metric's value is a bare scalar and must conform to its type.
UNKNOWN_TYPE = {
    "elementId": UNKNOWN_TYPE_ID,
    "displayName": "UnknownType",
    "namespaceUri": NS_LOCAL,
    "sourceTypeId": "UnknownType",
    "version": "1.0.0",
    "schema": {},
}
_SPARKPLUG_TYPES = {
    code: {
        "elementId": SPARKPLUG_TYPE_PREFIX + name,
        "displayName": "Sparkplug " + name,
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": name,
        "version": "1.0.0",
        "schema": {"type": json_type},
    }
    for code, (name, json_type) in SPARKPLUG_SCALARS.items()
}
METRIC_FALLBACK_TYPES = [_SPARKPLUG_TYPES[code] for code in sorted(_SPARKPLUG_TYPES)]
METRIC_FALLBACK_TYPES.append(UNKNOWN_TYPE)

# The namespaces a metric's semantic id can be defined in. MTConnect and ISO 22400 ids are minted
# here, so theirs are local. OPC UA and ASHRAE 223P ids are the standard's own, and a scalar type
# adapted from one is an in-exact implementation, which the guide marks with `?projection=i3X`.
PROJECTION_SUFFIX = "?projection=i3X"
_LOCAL_STANDARD_NAMESPACES = {
    "https://aber.local/semantics/mtconnect/v2.0": "MTConnect 2.0 (Aber ids)",
    "https://aber.local/semantics/iso22400": "ISO 22400 (Aber ids)",
}
_OPCUA_NAMESPACE_ROOT = "http://opcfoundation.org/UA/"
_ASHRAE_223P_NAMESPACE = "http://data.ashrae.org/standard223#"
_ASHRAE_223P_PROJECTION = "http://data.ashrae.org/standard223" + PROJECTION_SUFFIX


def metric_type_namespace(semantic_id) -> str:
    """
    The namespace a catalog metric's semantic id is defined in, and so its type's. An OPC UA id is
    `<companion spec namespace><BrowseName>`, so the namespace is the id up to its last `/`. An id
    under any other authority, or none, is local: never a namespace in someone else's name.
    """
    if not isinstance(semantic_id, str) or not semantic_id:
        return NS_LOCAL
    for uri in _LOCAL_STANDARD_NAMESPACES:
        if semantic_id.startswith(uri + "/"):
            return uri
    if semantic_id.startswith(_OPCUA_NAMESPACE_ROOT) and not any(c in semantic_id for c in "?#"):
        return semantic_id[: semantic_id.rindex("/") + 1] + PROJECTION_SUFFIX
    if semantic_id.startswith(_ASHRAE_223P_NAMESPACE):
        return _ASHRAE_223P_PROJECTION
    return NS_LOCAL


def scalar_schema(datatype) -> dict:
    """The JSON Schema of a value served for this Sparkplug datatype; `{}` when it has no scalar."""
    scalar = SPARKPLUG_SCALARS.get(datatype)
    return {"type": scalar[1]} if scalar else {}


def metric_type_id(name: str) -> str:
    """A catalog metric's type: its name is unique and immutable, so the id is persistent."""
    return METRIC_TYPE_PREFIX + name


def metric_type_from_catalog(row: dict) -> dict:
    """
    A `metric_catalog` row is the type of that metric on every device: a scalar derived from its
    datatype, annotated with its description and unit, with its semantic id as `sourceTypeId`.
    """
    schema = scalar_schema(row.get("datatype"))
    if row.get("description"):
        schema["description"] = row["description"]
    if row.get("units"):
        schema["x-unit"] = row["units"]
    return {
        "elementId": metric_type_id(row["name"]),
        "displayName": row["name"],
        "namespaceUri": metric_type_namespace(row.get("semantic_id")),
        "sourceTypeId": row.get("semantic_id") or row["name"],
        "version": "1.0.0",
        "schema": schema,
        "metadata": {
            "description": row.get("description"),
            "standard": row.get("standard"),
            "deprecated": bool(row.get("deprecated")),
        },
    }


def fallback_metric_type(datatype) -> dict:
    """The type of a metric no catalog row describes, from the datatype its DBIRTH declared."""
    return _SPARKPLUG_TYPES.get(datatype, UNKNOWN_TYPE)


def _namespace_display_name(uri: str) -> str:
    if uri in _LOCAL_STANDARD_NAMESPACES:
        return _LOCAL_STANDARD_NAMESPACES[uri]
    if uri == _ASHRAE_223P_PROJECTION:
        return "ASHRAE 223P (i3X projection)"
    if uri.startswith(_OPCUA_NAMESPACE_ROOT) and uri.endswith(PROJECTION_SUFFIX):
        spec = uri[len(_OPCUA_NAMESPACE_ROOT): -len(PROJECTION_SUFFIX)].strip("/")
        return f"OPC UA {spec or 'base'} (i3X projection)"
    return uri


# The gateway_status view's rule (ensure_gateway_status_view() in 0001), held to it by a test: an
# enrolment state stands, then OFFLINE, then a gateway with no heartbeat keeps its status, and one
# not heard from for longer than GATEWAY_STALE_SECONDS is STALE. The view compares exactly.
GATEWAY_STALE_SECONDS = 90
GATEWAY_ENROLMENT_STATUSES = ("PENDING_ENROLLMENT", "AWAITING_BIRTH")
# A gateway in one of these holds every value behind it: the devices' values are not current.
GATEWAY_DOWN_STATUSES = ("OFFLINE", "STALE")
UNKNOWN_STATUS = "UNKNOWN"

# Worst last. A device map's quality is the worst among the metrics it holds.
QUALITY_RANK = {"Good": 0, "GoodNoData": 1, "Uncertain": 2, "Bad": 3}


def instant(value) -> Optional[datetime]:
    """An aware UTC datetime from a datetime or an ISO 8601 string, or None when it is neither."""
    if isinstance(value, datetime):
        return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    if isinstance(value, str) and value.strip():
        return _parse_instant(value)
    return None


# Bounded. The same cached sample times are read on every value request.
@lru_cache(maxsize=1 << 16)
def _parse_instant(text: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(_normalise_fractional_seconds(text))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def gateway_live_status(gateway: dict, now: Optional[float] = None) -> str:
    """The view's `live_status` for a gateway row, upper-cased; UNKNOWN when no status is stored."""
    status = gateway.get("status")
    if not status:
        return UNKNOWN_STATUS
    if status in GATEWAY_ENROLMENT_STATUSES or status == "OFFLINE":
        return status
    heartbeat = instant(gateway.get("last_heartbeat"))
    if heartbeat is None:
        return status.upper()
    age = (now if now is not None else datetime.now(timezone.utc).timestamp()) - heartbeat.timestamp()
    return "STALE" if age > GATEWAY_STALE_SECONDS else status.upper()


def source_is_down(device: dict, gateway: Optional[dict] = None, now: Optional[float] = None) -> bool:
    """
    Whether a device's values can only be held ones: it is quarantined or OFFLINE, or its gateway
    is OFFLINE or STALE. A status that is not stored (None) is not a fault.
    """
    if device.get("is_quarantined"):
        return True
    if (device.get("status") or "").upper() == "OFFLINE":
        return True
    return gateway is not None and gateway_live_status(gateway, now) in GATEWAY_DOWN_STATUSES


def value_quality(device: dict, gateway: Optional[dict], has_value: bool,
                  now: Optional[float] = None) -> str:
    """
    The quality of a device's or a metric's value: the one rule for reads, staging and history.
    A source that is down makes a held value Uncertain and no value Bad; otherwise a value is Good
    and no value GoodNoData. README.md -> "Address space" has the table and the guide's words.
    """
    if source_is_down(device, gateway, now):
        return "Uncertain" if has_value else "Bad"
    return "Good" if has_value else "GoodNoData"


def worst_quality(*qualities: str) -> str:
    return max(qualities, key=QUALITY_RANK.__getitem__)


# What a stored telemetry row came from: ingestion writes DDATA only for a device that is not
# quarantined, so every stored sample was published by a trusted, live source.
STORED_SAMPLE_SOURCE = {"is_quarantined": False, "status": "ONLINE"}


def stored_sample_quality(has_value: bool) -> str:
    """A history entry's quality: `value_quality` for a sample ingestion stored."""
    return value_quality(STORED_SAMPLE_SOURCE, None, has_value)


def device_object(
    device: dict,
    parent_id: Optional[str],
    schema_id: Optional[str],
    schema: Optional[dict] = None,
    *,
    source_type_id: Optional[str] = None,
    metric_ids: Optional[List[str]] = None,
    extensions: Optional[Dict[str, dict]] = None,
) -> dict:
    """
    Project a `devices` row (joined with its resolved location) onto an i3X Object.

    `schema_id` is its type: its one schema, or the type of its set of schemas. The object's
    `sourceTypeId` is its type's: `schema`'s when it has one, else `source_type_id`. `metric_ids`
    are its components, and `extensions` the fragment of each metric no attached schema models.
    """
    element_id = device["sparkplug_id"]
    if source_type_id is None:
        if schema:
            source_type_id = schema_source_type_id(schema)
        else:
            source_type_id = schema_id or _SYNTHETIC_SOURCE_TYPE_IDS[UNTYPED_DEVICE_TYPE_ID]
    gateway_sid = device.get("_gateway_sparkplug_id")
    relationships = {}
    # Where `placement` filed it; None is Unassigned. Location is HasParent only, never ComponentOf.
    parent = parent_id or UNASSIGNED_ELEMENT_ID
    relationships["HasParent"] = [parent]
    if gateway_sid:
        relationships["ConnectsVia"] = [gateway_sid]
    if metric_ids:
        relationships["HasComponent"] = sorted(metric_ids)
    # The i3X term for "publishes beyond its model", which is the Unmodelled concept exactly.
    # Derived, never stored -- see `is_extended`.
    extended = bool(device.get("_is_extended"))
    metadata = {
        "description": device.get("description"),
        "typeNamespaceUri": NS_LOCAL,
        "sourceTypeId": source_type_id,
        "relationships": relationships,
    }
    if extended:
        metadata["schemaExtensions"] = dict(extensions or {})
    # Vendor keys, which i3X requires here whenever the object is extended.
    metadata["system"] = {"quarantined": bool(device.get("is_quarantined"))}
    return {
        "elementId": element_id,
        "displayName": device.get("name") or element_id,
        "typeElementId": schema_id or UNTYPED_DEVICE_TYPE_ID,
        "parentId": parent,
        # A composition of its metrics, each a leaf component. Its own value stays their map.
        "isComposition": bool(metric_ids),
        "isExtended": extended,
        "metadata": metadata,
    }


def metric_element_id(device_sid: str, name: str) -> str:
    """A metric's elementId. A sparkplug_id never contains `/`, so the first `/` splits it back."""
    return f"{device_sid}/{name}"


_UNPRINTABLE = re.compile(r"[\x00-\x1f\x7f]")


def metric_name_is_addressable(name) -> bool:
    """Whether `<device>/<name>` is a valid elementId: no surrounding whitespace, all printable."""
    if not isinstance(name, str) or not name or name != name.strip():
        return False
    return not _UNPRINTABLE.search(name)


def metric_object(device_sid: str, name: str, metric_type: dict) -> dict:
    """
    One metric of a device, a leaf component. As in CESMII's reference server, its parent is the
    device and its only edge is `ComponentOf`, so an organisational (`HasChildren`) walk never
    reaches it.
    """
    return {
        "elementId": metric_element_id(device_sid, name),
        "displayName": name,
        "typeElementId": metric_type["elementId"],
        "parentId": device_sid,
        "isComposition": False,
        "isExtended": False,
        "metadata": {
            "typeNamespaceUri": metric_type["namespaceUri"],
            "sourceTypeId": metric_type["sourceTypeId"],
            "relationships": {"ComponentOf": [device_sid]},
        },
    }


def gateway_location_source(gateway: dict) -> str:
    """
    A gateway's `location_source`, read off its own row in the view's precedence: shadow, then
    simulated, then its scope, then its cell. Gateways inherit nothing, so no view resolves it.
    """
    if gateway.get("is_shadow"):
        return SOURCE_SHADOW
    if gateway.get("is_simulated"):
        return SOURCE_SIMULATED
    scope = gateway.get("location_scope")
    if scope in (SOURCE_SITE_WIDE, SOURCE_AREA_WIDE):
        return scope
    return SOURCE_EXPLICIT if gateway.get("cell_id") else SOURCE_UNASSIGNED


def placement(
    source: Optional[str],
    cell_id: Optional[str],
    area_id: Optional[str],
    cell_ids,
    area_ids,
) -> str:
    """
    The elementId an asset is filed under: its lane, else the most specific place it names that is
    in this address space (its cell, else its area, else the site), else Unassigned.

    `source`, `cell_id` and `area_id` are what `device_locations` resolves for a device, or
    `gateway_location_source` and the row's own columns for a gateway. A place missing from
    `cell_ids` or `area_ids` (archived, or hidden by RLS) is climbed past rather than named, so
    every parentId resolves. Only an asset that names no place at all is Unassigned.
    """
    lane = LANES.get(source)
    if lane:
        return lane[0]
    if cell_id and cell_id in cell_ids:
        return cell_id
    if area_id and area_id in area_ids:
        return area_id
    if cell_id or area_id or source == SOURCE_SITE_WIDE:
        return SITE_ELEMENT_ID
    return UNASSIGNED_ELEMENT_ID


def gateway_object(gateway: dict, device_sids: List[str], parent_id: Optional[str]) -> dict:
    element_id = gateway["sparkplug_id"]
    # Where `placement` filed it; None is Unassigned. Location is HasParent only, never ComponentOf.
    parent = parent_id or UNASSIGNED_ELEMENT_ID
    relationships = {"HasParent": [parent]}
    if device_sids:
        relationships["ProvidesConnectivityFor"] = sorted(device_sids)
    return {
        "elementId": element_id,
        "displayName": gateway.get("name") or element_id,
        "typeElementId": GATEWAY_TYPE_ID,
        "parentId": parent,
        "isComposition": False,
        "isExtended": False,
        "metadata": {
            "description": gateway.get("description"),
            "typeNamespaceUri": NS_LOCAL,
            "sourceTypeId": "Gateway",
            "relationships": relationships,
        },
    }


def _location_object(
    element_id: str,
    display_name: str,
    type_id: str,
    parent_id: Optional[str],
    child_ids: List[str],
    description: Optional[str],
) -> dict:
    """
    A level of the location tree: the site, an area, a cell, a lane or Unassigned.

    `HasParent`/`HasChildren` only, and never a composition: its children are independently valued
    and a value query does not return them at any maxDepth. `HasParent` always matches `parentId`,
    which EXP-21 follows through `/objects/related`.
    """
    relationships = {}
    if parent_id:
        relationships["HasParent"] = [parent_id]
    if child_ids:
        relationships["HasChildren"] = sorted(child_ids)
    return {
        "elementId": element_id,
        "displayName": display_name,
        "typeElementId": type_id,
        "parentId": parent_id,
        "isComposition": False,
        "isExtended": False,
        "metadata": {
            "description": description,
            "typeNamespaceUri": NS_LOCAL,
            "sourceTypeId": _SYNTHETIC_SOURCE_TYPE_IDS[type_id],
            "relationships": relationships,
        },
    }


def area_object(area: dict, child_ids: List[str]) -> dict:
    """An area: its cells, and the area-wide assets filed on it directly."""
    return _location_object(
        area["id"], area.get("name") or area["id"], AREA_TYPE_ID, SITE_ELEMENT_ID, child_ids,
        area.get("description"),
    )


def cell_object(cell: dict, child_ids: List[str], parent_id: str) -> dict:
    """A cell, under its area, or directly under the site when it is filed in no area."""
    return _location_object(
        cell["id"], cell.get("name") or cell["id"], CELL_TYPE_ID, parent_id, child_ids,
        cell.get("description"),
    )


def lane_object(source: str, child_ids: List[str]) -> dict:
    """The Simulated or Shadow lane, keyed by the `location_source` that fills it."""
    element_id, display_name, description = LANES[source]
    return _location_object(
        element_id, display_name, LANE_TYPE_ID, SITE_ELEMENT_ID, child_ids, description
    )


def site_object(child_ids: List[str], name: Optional[str] = None) -> dict:
    """The only root, named by the `site.name` setting. i3X reads `parentId: null` as root."""
    display_name = name.strip() if isinstance(name, str) and name.strip() else SITE_FALLBACK_NAME
    return _location_object(
        SITE_ELEMENT_ID, display_name, SITE_TYPE_ID, None, child_ids,
        "Synthetic root of this deployment's address space.",
    )


def unassigned_object(child_ids: List[str]) -> dict:
    return _location_object(
        UNASSIGNED_ELEMENT_ID, "Unassigned", UNASSIGNED_TYPE_ID, SITE_ELEMENT_ID, child_ids,
        "Assets nobody has placed: no cell, no area-wide or site-wide scope, and in no lane. "
        "Synthetic: this is the ABSENCE of a location decision, not a place, which is why it is "
        "not a row in `cells`.",
    )


def is_extended(declared_metrics, modelled_metrics) -> bool:
    """
    i3X `isExtended` is Unmodelled: the object publishes beyond the type that describes it.
    `modelled_metrics` is the union across every schema attached to the device.

    Derived by subtraction at read time, exactly as `deviceTags.js` does it -- so editing a schema
    reclassifies its devices on the next request rather than at their next birth, which may be weeks
    away. No schema at all means not extended: "publishes beyond its model" and "has no model" are
    different findings and only one of them is a drift signal.
    """
    if not modelled_metrics:
        return False
    return bool(set(declared_metrics or []) - set(modelled_metrics))


_ISO_FRACTION_RE = re.compile(r"(?<=:\d\d)\.(\d+)")


def _normalise_fractional_seconds(text: str) -> str:
    """
    Pad or trim the fractional-seconds field to exactly 6 digits, and `Z` to `+00:00`.

    PostgREST strips trailing zeros from `timestamptz`, and `fromisoformat` before Python 3.11 read
    only 3 or 6 digits. `to_rfc3339_utc` returns an unparseable value unchanged, so normalising first
    keeps the result independent of the runtime's parser.
    """
    text = text.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    return _ISO_FRACTION_RE.sub(lambda m: "." + m.group(1)[:6].ljust(6, "0"), text, count=1)


def to_rfc3339_utc(value) -> Optional[str]:
    """
    Normalise any timestamp to RFC 3339 UTC with a literal `Z`.

    THE OFFSET FORM IS NOT ACCEPTED, and this is not pedantry about formatting -- i3X pins the
    representation so a client never has to decide whether `+00:00` and `Z` are the same instant
    before it can sort two series together. Python produces the offset form by default
    (`datetime.isoformat()` yields `...+00:00`) and PostgREST returns `timestamptz` the same way, so
    every timestamp in this server passes through here: the MQTT cache, the gateway heartbeat, the
    synthesised container values, and every row of history.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(_normalise_fractional_seconds(text))
        except ValueError:
            # Unparseable is returned unchanged rather than dropped: a malformed timestamp from a
            # device is a fact about that device, and silently blanking it would hide it.
            return text
    if dt.tzinfo is None:
        # Naive timestamps are treated as UTC. Everything upstream stores UTC -- the hypertable is
        # timestamptz and Sparkplug carries epoch millis -- so this only ever fires on a value that
        # lost its zone in transit, and guessing local time would shift it by the host's offset.
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    if dt.microsecond:
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return dt.isoformat().replace("+00:00", "Z")


def value_envelope(element_id: str, value, quality: str, timestamp: Optional[str]) -> dict:
    """
    One value, in the shape `/objects/value`, `/subscriptions/sync` and the SSE stream all use.

    A null value MUST NOT be reported as `Good` -- the conformance suite checks this specifically
    (`nullgood` is one of the reference mock's deliberate violations). Absent data is `GoodNoData`:
    the server is healthy and the object simply has not produced a value.
    """
    if value is None and quality == "Good":
        quality = "GoodNoData"
    return {
        "elementId": element_id,
        "value": value,
        "quality": quality,
        "timestamp": to_rfc3339_utc(timestamp),
    }


def site_value(cell_count: int, device_count: int) -> dict:
    """
    The site's value: exactly the properties the Site type declares.

    EVERY OBJECT NEEDS A VALUE, not only the ones that publish telemetry. `POST /objects/value` is
    how a client reads any object, and reporting "no such element" for a cell that plainly exists in
    `/objects` is worse than reporting a count.
    """
    return value_envelope(
        SITE_ELEMENT_ID, {"cellCount": cell_count, "deviceCount": device_count}, "Good", _now_iso()
    )


def _location_value(obj: dict, counts: dict) -> dict:
    """The counts a location type declares, then its description. Counts are of devices or cells."""
    value = dict(counts)
    value["description"] = (obj.get("metadata") or {}).get("description")
    return value_envelope(obj["elementId"], value, "Good", _now_iso())


def area_value(obj: dict, cell_count: int, device_count: int) -> dict:
    """An area's value: the cells filed in it, and every device in it, area-wide or in a cell."""
    return _location_value(obj, {"cellCount": cell_count, "deviceCount": device_count})


def cell_value(obj: dict, device_count: int) -> dict:
    """A cell's value: its devices and description."""
    return _location_value(obj, {"deviceCount": device_count})


def lane_value(obj: dict, device_count: int) -> dict:
    """A lane's value, and Unassigned's, which shares the Lane type: its devices and description."""
    return _location_value(obj, {"deviceCount": device_count})


def devices_below(objects: Dict[str, dict], element_id: str, device_ids) -> int:
    """How many of `device_ids` sit anywhere under `element_id`, following HasChildren down."""
    count, stack, seen = 0, [element_id], {element_id}
    while stack:
        rels = (objects.get(stack.pop(), {}).get("metadata") or {}).get("relationships") or {}
        for child in rels.get("HasChildren", []):
            if child in seen:
                continue
            seen.add(child)
            if child in device_ids:
                count += 1
            else:
                stack.append(child)
    return count


def gateway_value(gateway: dict, now: Optional[float] = None) -> dict:
    """
    A gateway's value is its live status as the `gateway_status` view derives it, STALE included,
    and `Good` whenever that is known: an OFFLINE seen through NDEATH is a fact, not a doubt. It is
    the devices behind it whose values go stale. No stored status is GoodNoData with no value.
    """
    status = gateway_live_status(gateway, now)
    heartbeat = gateway.get("last_heartbeat")
    if status == UNKNOWN_STATUS:
        return value_envelope(gateway["sparkplug_id"], None, "GoodNoData", heartbeat or _now_iso())
    return value_envelope(
        gateway["sparkplug_id"],
        {
            "status": status,
            "sparkplugGroup": gateway.get("sparkplug_group") or "",
            "lastHeartbeat": to_rfc3339_utc(heartbeat),
        },
        "Good",
        heartbeat or _now_iso(),
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _newest(timestamps) -> Optional[str]:
    """The latest of these timestamps as instants, not as text; unparseable ones are passed over."""
    dated = [(instant(t), t) for t in timestamps if t]
    dated = [(when, t) for when, t in dated if when is not None]
    return max(dated)[1] if dated else None


def device_value(device: dict, metrics: Dict[str, dict], gateway: Optional[dict] = None, *,
                 unavailable: bool = False, now: Optional[float] = None) -> dict:
    """
    A device's value is the map of its latest metric values.

    Each metric is also a component with a value of its own (`device_metric_value`), but the map
    stays the device's value: its ObjectType is its schemas, whose `properties` are the metric
    names, and one read at the default depth returns the whole device. Its quality is the worst
    among the metrics it holds, which is `value_quality` for a held value; `unavailable` means a
    metric could not be read, so a map is at best Uncertain. The timestamp is the newest sample's,
    else the device's last status change (`_status_changed_at`), else the current time.
    """
    value = {name: entry.get("value") for name, entry in metrics.items()} or None
    quality = value_quality(device, gateway, value is not None, now)
    if unavailable:
        quality = worst_quality(quality, "Uncertain" if value is not None else "Bad")
    latest = _newest(entry.get("timestamp") for entry in metrics.values())
    return value_envelope(
        device["sparkplug_id"], value, quality,
        latest or device.get("_status_changed_at") or _now_iso(),
    )


def device_metric_value(device: dict, element_id: str, entry: Optional[dict],
                        gateway: Optional[dict] = None, *, unavailable: bool = False,
                        now: Optional[float] = None) -> dict:
    """
    One metric's value: its cache `entry`, with `value_quality` for its device and gateway. A
    metric that could not be read (`unavailable`) and has no value is Bad. The timestamp is the
    sample's, else the device's last status change, else the current time.
    """
    value = entry.get("value") if entry else None
    if unavailable and value is None:
        quality = "Bad"
    else:
        quality = value_quality(device, gateway, value is not None, now)
    return value_envelope(
        element_id, value, quality,
        (entry or {}).get("timestamp") or device.get("_status_changed_at") or _now_iso(),
    )
