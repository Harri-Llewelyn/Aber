"""
Projection of the Factory+ model onto the i3X 1.0 address space.

i3X INTRODUCES NO NEW TYPE SYSTEM, which is why this is a projection rather than a schema. ObjectTypes
ARE JSON Schema, and `schemas.schema_definition` already stores JSON Schema -- so a schema row is an
ObjectType with no translation at all. That was the stated reason for rejecting native AAS Submodel
tables, and it is why i3X costs a read-side adapter where AAS cost an exporter plus a metamodel.

FOUR MAPPINGS THAT ARE NOT MECHANICAL, each of which is a decision:

  elementId is `sparkplug_id`. i3X requires an elementId that is unique and persistent, and is only
  "human-readable when practical" -- which is exactly the split this repository already makes between
  `sparkplug_id` (immutable, on the wire) and `name` (a freely editable display label). So elementId
  is the sparkplug_id and displayName is the name. Renaming an asset therefore does not move it in the
  i3X address space, for the same reason it does not detach its telemetry.

  parentId is the CELL, not the gateway. i3X gives an Object exactly one parentId, and a device here
  has two parents: a cell (where it is) and a gateway (how its data arrives). HasParent is
  organizational hierarchy, so the cell wins; the data path is modelled as a separate relationship
  pair with a `reverseOf`, which is what relationships are for. Collapsing them would make a virtual
  gateway -- a host-run proxy with no honest cell -- unrepresentable.

  Unassigned is a SYNTHETIC object. `parentId: null` means root, so a device with no cell would
  otherwise be a second root beside the site. A synthetic object is legitimate here in a way a magic
  `cells` row is not: it exists only in this projection, has no table behind it, and so cannot be
  edited, deleted, or picked up by the pg_cron purge that runs past RLS.

  quality is derived at READ TIME, never stored -- the same rule as `gateway_status` and device tags.
  A quarantined device or a stale gateway is `Uncertain`; a metric that has never been published is
  `GoodNoData` with no value; anything else is `Good`. A `quality` column on the telemetry hypertable
  would be a stored verdict that goes stale the moment the gateway does.

EVERY READ HERE GOES THROUGH PostgREST AS THE CALLER. There is no service-role key in this process --
see `PostgrestClient`. That is what makes the i3X address space obey the same RLS as the dashboard,
and it is the reason values are gated on a metadata read rather than served straight from the MQTT
cache (which has no RLS of its own).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

# The synthetic objects. Prefixed so they cannot collide with a sparkplug_id (24 chars, `gwy`/`dev`)
# or a UUID.
SITE_ELEMENT_ID = "i3x:site"
UNASSIGNED_ELEMENT_ID = "i3x:unassigned"

# Namespaces. One per vocabulary already in the database, plus this deployment's own. The local one
# is the same `acs-cymru.local` authority the semantic ids use -- an id under mtconnect.org or
# iso.org would assert an interoperability that does not exist, and that rule does not stop being
# true because the transport changed.
NS_LOCAL = "https://acs-cymru.local/i3x"
NS_RELATIONSHIPS = "https://acs-cymru.local/i3x/relationships"

# THE KEYS ARE `metric_catalog.standard` VALUES, VERBATIM, and that is the whole contract. They are
# the strings in frontend/src/utils/standards.js `STANDARDS` -- spaces, not hyphens. `namespaces()`
# looks them up and SKIPS anything it cannot resolve, so a key that does not match the column drops
# a whole vocabulary out of GET /namespaces with no error anywhere: the endpoint answers 200 with a
# shorter list, which reads as "this deployment does not use that standard" rather than as a bug.
# `ISO-22400` and `OPC-UA` were spelled that way here and matched nothing for exactly that reason.
# test_standard_namespaces_cover_every_known_standard pins them against standards.js.
STANDARD_NAMESPACES = {
    "MTConnect": "https://mtconnect.org/v2.0",
    "ISO 22400": "https://acs-cymru.local/semantics/iso22400",
    "OPC UA": "https://opcfoundation.org/UA",
    # Issued by ASHRAE, not minted here -- migration 0013 CHECKs that every seeded id sits under
    # this namespace.
    "ASHRAE 223P": "http://data.ashrae.org/standard223#",
}

# Synthetic ObjectTypes for the three levels that have no `schemas` row. Cells and gateways are
# infrastructure, not modelled equipment; giving them a real schema row would put them in the
# registry the Schemas tab manages, where an operator could version or archive them.
SITE_TYPE_ID = "i3x:type:site"
CELL_TYPE_ID = "i3x:type:cell"
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
        "elementId": CELL_TYPE_ID,
        "displayName": "Factory Cell",
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
        "elementId": GATEWAY_TYPE_ID,
        "displayName": "Edge Gateway",
        "namespaceUri": NS_LOCAL,
        "sourceTypeId": "Gateway",
        "version": "1.0.0",
        "schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["ONLINE", "OFFLINE", "STALE", "UNKNOWN"]},
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

# Relationship types, registered in both directions. `reverseOf` is a MUST-have pair: the conformance
# suite checks that following a relationship and then its reverse returns you to where you started,
# and a one-way registration fails that.
RELATIONSHIP_TYPES = [
    ("HasParent", "HasChildren", "Organizational parent in the site hierarchy."),
    ("HasChildren", "HasParent", "Organizational children in the site hierarchy."),
    (
        "HasComponent",
        "ComponentOf",
        "Members of a composition. Carried ALONGSIDE HasChildren rather than instead of it, because "
        "the two answer different questions: HasChildren is the browse hierarchy, HasComponent is "
        "what `maxDepth > 1` on a value query descends. Only objects with `isComposition: true` "
        "publish it -- Unassigned is a queue, not a composition, so it has children and no "
        "components. IT IS NOT A TARGET OF ONE EITHER: the site names its cells and its site-wide "
        "gateways as components and leaves Unassigned out, because `ComponentOf` is this edge's "
        "inverse and a back edge from Unassigned would assert a membership its own description "
        "denies. Every other HasComponent edge DOES carry its ComponentOf -- EXP-20 requires it, "
        "and for a long time nothing emitted one at all.",
    ),
    ("ComponentOf", "HasComponent", "The composition this object is a member of."),
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


def namespaces(standards_in_use: Iterable[str]) -> List[dict]:
    out = [
        {"uri": NS_LOCAL, "displayName": "Factory+ Local"},
        {"uri": NS_RELATIONSHIPS, "displayName": "Factory+ Relationships"},
    ]
    for standard in sorted(set(s for s in standards_in_use if s)):
        uri = STANDARD_NAMESPACES.get(standard)
        if uri:
            out.append({"uri": uri, "displayName": standard})
    return out


def schema_type_namespace(standard: Optional[str]) -> str:
    return STANDARD_NAMESPACES.get(standard or "", NS_LOCAL)


def object_type_from_schema(row: dict) -> dict:
    """A `schemas` row is an ObjectType with no translation -- its definition IS JSON Schema."""
    definition = row.get("schema_definition")
    if not isinstance(definition, dict):
        # A schema whose definition is unreadable is reported as an object with unknown properties
        # rather than dropped. "Has a model we cannot parse" and "has no model" are different
        # findings, the same distinction deviceTags.js makes for Unmodelled.
        definition = {"type": "object", "additionalProperties": True}
    return {
        "elementId": row["id"],
        "displayName": row.get("schema_name") or row["id"],
        "namespaceUri": schema_type_namespace(row.get("standard")),
        # The semantic id when there is one -- that is precisely "the identifier of the concept this
        # type instantiates", which is what sourceTypeId means. Falling back to the name keeps the
        # field populated for locally-minted schemas.
        "sourceTypeId": row.get("semantic_id") or row.get("schema_name") or row["id"],
        "version": str(row.get("version") or "1"),
        "schema": definition,
        "metadata": {
            "description": row.get("description") or row.get("change_description") or None,
            "status": row.get("status"),
        },
    }


def _quality_for_device(device: dict, has_value: bool) -> str:
    if device.get("is_quarantined"):
        # The device is publishing but we have refused to trust its identity. Not Bad -- the readings
        # may be perfectly good -- but explicitly not vouched for.
        return "Uncertain"
    if not has_value:
        return "GoodNoData"
    return "Good"


def device_object(device: dict, effective_cell_id: Optional[str], schema_id: Optional[str]) -> dict:
    """Project a `devices` row (joined with its resolved location) onto an i3X Object."""
    element_id = device["sparkplug_id"]
    gateway_sid = device.get("_gateway_sparkplug_id")
    relationships = {}
    parent = effective_cell_id or UNASSIGNED_ELEMENT_ID
    relationships["HasParent"] = [parent]
    # THE INVERSE OF THE CELL'S `HasComponent`, and it has to be emitted or EXP-20 fails: every
    # forward edge MUST be traversable backwards. Not emitted under Unassigned, which publishes no
    # `HasComponent` to be the inverse of -- see RELATIONSHIP_TYPES.
    if parent != UNASSIGNED_ELEMENT_ID:
        relationships["ComponentOf"] = [parent]
    if gateway_sid:
        relationships["ConnectsVia"] = [gateway_sid]
    return {
        "elementId": element_id,
        "displayName": device.get("name") or element_id,
        "typeElementId": schema_id or UNTYPED_DEVICE_TYPE_ID,
        "parentId": parent,
        # A device is a component of its cell in the composition sense: deleting the cell does not
        # delete the device (ON DELETE SET NULL), so this is an aggregation, not a composition.
        "isComposition": False,
        # The i3X term for "publishes beyond its model", which is the Unmodelled concept exactly.
        # Derived, never stored -- see `is_extended`.
        "isExtended": bool(device.get("_is_extended")),
        "metadata": {
            "description": device.get("description"),
            "typeNamespaceUri": NS_LOCAL,
            "sourceTypeId": device.get("sparkplug_id"),
            "relationships": relationships,
            "quarantined": bool(device.get("is_quarantined")),
        },
    }


def gateway_object(gateway: dict, device_sids: List[str]) -> dict:
    element_id = gateway["sparkplug_id"]
    parent = gateway.get("cell_id") or (
        SITE_ELEMENT_ID if gateway.get("location_scope") == "site_wide" else UNASSIGNED_ELEMENT_ID
    )
    relationships = {"HasParent": [parent]}
    # As for a device: the inverse of whatever publishes `HasComponent` toward this gateway -- its
    # cell, or the site itself when `location_scope` is site_wide. Unassigned publishes none.
    if parent != UNASSIGNED_ELEMENT_ID:
        relationships["ComponentOf"] = [parent]
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


def cell_object(cell: dict, child_ids: List[str]) -> dict:
    relationships = {"HasParent": [SITE_ELEMENT_ID], "ComponentOf": [SITE_ELEMENT_ID]}
    if child_ids:
        relationships["HasChildren"] = sorted(child_ids)
        # A cell IS a composition of the assets in it, so the same edge is also a component edge.
        # `maxDepth > 1` on a value query descends HasComponent, not HasChildren.
        relationships["HasComponent"] = sorted(child_ids)
    return {
        "elementId": cell["id"],
        "displayName": cell.get("name") or cell["id"],
        "typeElementId": CELL_TYPE_ID,
        "parentId": SITE_ELEMENT_ID,
        "isComposition": True,
        "isExtended": False,
        "metadata": {
            "description": cell.get("description"),
            "typeNamespaceUri": NS_LOCAL,
            "sourceTypeId": "Cell",
            "relationships": relationships,
        },
    }


def _site_relationships(child_ids: List[str]) -> dict:
    """
    The site's edges, and the one asymmetry in them.

    EVERY CHILD IS A CHILD; NOT EVERY CHILD IS A COMPONENT. `HasChildren` is the browse hierarchy
    and takes all of them. `HasComponent` is what `maxDepth > 1` on a value query descends, and
    Unassigned is left out of it: it is the ABSENCE of a location decision rather than a place, it
    holds no value of its own, and it publishes no `HasComponent` of its own -- so a descent that
    reaches it stops there, having added an empty node and nothing else. Cells and site-wide
    gateways are real and stay.

    This is also what makes the graph symmetric. `ComponentOf` is the declared inverse of
    `HasComponent`, so naming Unassigned here would oblige it to carry a `ComponentOf` back --
    asserting a membership the object's own description denies.
    """
    rels = {"HasChildren": sorted(child_ids)}
    components = sorted(c for c in child_ids if c != UNASSIGNED_ELEMENT_ID)
    if components:
        rels["HasComponent"] = components
    return rels


def site_object(child_ids: List[str]) -> dict:
    return {
        "elementId": SITE_ELEMENT_ID,
        "displayName": "Factory+ Site",
        "typeElementId": SITE_TYPE_ID,
        # The only true root. i3X reads `parentId: null` as root, so there must be exactly one.
        "parentId": None,
        "isComposition": True,
        "isExtended": False,
        "metadata": {
            "description": "Synthetic root of this deployment's address space.",
            "typeNamespaceUri": NS_LOCAL,
            "sourceTypeId": "Site",
            "relationships": _site_relationships(child_ids),
        },
    }


def unassigned_object(child_ids: List[str]) -> dict:
    return {
        "elementId": UNASSIGNED_ELEMENT_ID,
        "displayName": "Unassigned",
        "typeElementId": CELL_TYPE_ID,
        "parentId": SITE_ELEMENT_ID,
        # NOT a composition: nothing here owns its children, they are simply not placed yet.
        "isComposition": False,
        "isExtended": False,
        "metadata": {
            "description": (
                "Assets with no resolved cell. Synthetic: this is the ABSENCE of a location "
                "decision, not a place, which is why it is not a row in `cells`."
            ),
            "typeNamespaceUri": NS_LOCAL,
            "sourceTypeId": "Cell",
            # `HasParent` MUST be here: `parentId` above says the site is the parent, and a
            # relationship graph that disagrees with `parentId` fails EXP-21 as well as EXP-20.
            # Its absence is what the conformance suite reported. No `ComponentOf`, because the
            # site deliberately does not name this queue among its components.
            "relationships": {
                "HasParent": [SITE_ELEMENT_ID],
                "HasChildren": sorted(child_ids),
            },
        },
    }


def is_extended(declared_metrics, modelled_metrics) -> bool:
    """
    i3X `isExtended` is Unmodelled: the object publishes beyond the type that describes it.

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

    THIS EXISTS FOR PYTHON 3.10, WHICH THE CONTAINER RUNS. `datetime.fromisoformat` only became a
    general ISO 8601 parser in 3.11; before that it accepted a fractional part of EXACTLY 3 or 6
    digits and raised `ValueError` on anything else. PostgREST emits `timestamptz` with trailing
    zeros stripped, so `...:11.11239+00:00` -- five digits, because the microsecond happened to end
    in a zero -- is a perfectly ordinary response that 3.10 cannot parse and 3.12 can.

    That asymmetry is the whole danger. `to_rfc3339_utc` returns an unparseable value UNCHANGED, by
    design, so the failure was not an exception: roughly one timestamp in ten kept its `+00:00`
    offset and shipped as a conformance violation, on the container only, intermittently. The
    official suite caught it in CI on a value the local run happened not to produce. Same shape as
    the f-string defect: 3.12 is more permissive than 3.10, and testing on the newer one hides it.
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


def container_value(obj: dict, child_count: int, extra: Optional[dict] = None) -> dict:
    """
    A value for a cell, the site, or Unassigned.

    EVERY OBJECT NEEDS A VALUE, not only the ones that publish telemetry. `POST /objects/value` is
    how a client reads any object, and a composition with no value of its own cannot be the subject
    of a `maxDepth > 1` query -- which is the only way to read a subtree in one call. Reporting
    "no such element" for a cell that plainly exists in `/objects` is worse than reporting a count.
    """
    value = {"deviceCount": child_count}
    if extra:
        value.update(extra)
    return value_envelope(obj["elementId"], value, "Good", _now_iso())


def gateway_value(gateway: dict) -> dict:
    """
    A gateway's value is its liveness, derived the same way `gateway_status` derives it.

    STALE is `Uncertain`, not `Bad`: the gateway has not been heard from inside the threshold, which
    is a statement about our knowledge rather than about the equipment. `Bad` would assert a fault
    nobody has observed.
    """
    status = (gateway.get("status") or "UNKNOWN").upper()
    quality = "Uncertain" if status in ("STALE", "UNKNOWN", "OFFLINE") else "Good"
    return value_envelope(
        gateway["sparkplug_id"],
        {
            "status": status,
            "sparkplugGroup": gateway.get("sparkplug_group") or "",
            "lastHeartbeat": gateway.get("last_heartbeat"),
        },
        quality,
        gateway.get("last_heartbeat") or _now_iso(),
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def device_value(device: dict, metrics: Dict[str, dict]) -> dict:
    """
    A device's value is the map of its latest metric values.

    Composite rather than one-object-per-metric, because the device's ObjectType is its schema and
    that schema's `properties` are the metric names. Flattening each metric into its own Object would
    invent an elementId per metric that appears nowhere on the wire and in no table.
    """
    if not metrics:
        return value_envelope(device["sparkplug_id"], None, _quality_for_device(device, False), None)
    value = {name: entry.get("value") for name, entry in metrics.items()}
    latest = max((entry.get("timestamp") or "" for entry in metrics.values()), default=None)
    return value_envelope(
        device["sparkplug_id"], value, _quality_for_device(device, True), latest or None
    )
