"""
The Unified Namespace bridge: every decoded DDATA metric republished on a plain topic.

Sparkplug B topics are shaped for transport (`spBv1.0/<group>/DDATA/<node>/<device>`, one protobuf
per message). A BI tool or SCADA client wants one number under a name it can read, which is what
ISA-95's hierarchy gives:

    <root>/<enterprise>/<site>/<area>/<cell>/<device>/<metric>

with the enterprise being the Sparkplug group the message arrived under, and the metric name as the
leaf -- a catalog name containing `/` becomes a subtree, which is the convention the catalog's own
`metric_group` prefix already follows. The rest of the path is the database's: the view
`device_uns_paths` (supabase/README.md, 0214) answers each device's path below the root, or why it
has none, and the dashboard shows the same rows.

THE PATH IS FIXED AT THE LEVEL THE ASSET HONESTLY OCCUPIES. An area-wide asset (a building's BMS)
publishes under `<area>/<device>` with no cell; a site-wide asset under `<site>/<device>` with
neither. A device whose path is incomplete -- unassigned, in a cell filed in no area, a site with no
name yet -- is NOT published under a placeholder: an invented segment would put a word nobody chose
in every topic, and the Areas page's unfiled queue is where an operator makes it complete. Every
skip is counted by reason.

RETAINED, QoS 0. Retained so a subscriber sees the last value without waiting for the next DDATA;
QoS 0 as every Sparkplug publisher on this stack is, and because the next reading is the retry.

OFF BY DEFAULT (`UNS_MQTT_ENABLED`), for the Directory publisher's reason: a topic has no caller,
so the broker ACL is the only access control, and publishing the plant's readings on a readable tree
is an exposure decision a deployment makes. The broker's roles grant the daemon write on
`<UNS_MQTT_TOPIC_ROOT>/#`, derived from the same chart value, and grant no gateway a read of it.

RUNS ON THE INGESTION CALLBACK THREAD, after the historian commit, which puts a second publish per
message on the single-writer path (ingestion/README.md -> "The single-writer ceiling"). It is timed
into its own histogram so that cost is visible beside the write's.
"""
import json
import os
import re
import threading
import time
from datetime import timezone

from logging_config import get_logger

logger = get_logger("ingestion")

# -------------------------------------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------------------------------------
UNS_MQTT_ENABLED = os.getenv("UNS_MQTT_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")

# The root, one level or several. Not under `spBv1.0/`, which belongs to Sparkplug and is confined
# per gateway.
UNS_MQTT_TOPIC_ROOT = os.getenv("UNS_MQTT_TOPIC_ROOT", "uns").strip().strip("/") or "uns"

# How long a device's path and the metric catalog's units are believed before being re-read. A
# relocation or a rename on the dashboard therefore moves a device's topic within this window.
UNS_CONTEXT_TTL_SECONDS = int(os.getenv("UNS_CONTEXT_TTL_SECONDS", "60"))

# One row per device: its path below the root, or the reason it has none.
PATH_VIEW = "device_uns_paths"

# The characters a topic level may not carry: the separator and the two wildcards. The view refuses
# them in every name on the path; here they guard the message's group, as
# gateways_sparkplug_group_format guards a configured one.
TOPIC_UNSAFE = re.compile(r"[/+#]")
# The metric leaf, and the root, may contain `/` (a catalog group prefix, or a root of several
# levels); only the wildcards are refused.
LEAF_UNSAFE = re.compile(r"[+#]")

# The skip reasons, each a label value on aber_ingestion_uns_skipped_total. Listed so metrics.py's
# table and this module cannot disagree about the set. All but location_unknown and publish_error
# are the view's own answers; mirror check 27 holds the view and the dashboard to this list.
SKIP_REASONS = (
    "site_unset",        # `site.name` is empty: nothing has a complete path yet
    "location_unknown",  # the view had no row for the device, or could not be read
    "lane",              # shadow or simulated: not a place on the plant
    "unassigned",        # nobody has said where the device is
    "cell_unfiled",      # the cell is in no area, so the path has a hole in it
    "unsafe_name",       # a segment carries / + or #, or is empty
    "publish_error",     # the client refused the publish
)


# -------------------------------------------------------------------------------------------------
# A small TTL cache, so a path is one PostgREST read per device per minute rather than per DDATA
# -------------------------------------------------------------------------------------------------
class _TtlCache:
    def __init__(self, ttl):
        self.ttl = ttl
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key, loader):
        """The cached value for `key`, or `loader()` stored for `ttl` seconds. None is cacheable:
        a device the view has no row for should not cost a round trip per message either."""
        now = time.time()
        with self._lock:
            entry = self._data.get(key)
            if entry is not None and now - entry[1] < self.ttl:
                return entry[0]
        value = loader()
        with self._lock:
            self._data[key] = (value, now)
        return value

    def clear(self):
        with self._lock:
            self._data.clear()


_context = _TtlCache(UNS_CONTEXT_TTL_SECONDS)


def reset_cache():
    """For tests, and for a future operator control: forget every cached path and the units."""
    _context.clear()


# -------------------------------------------------------------------------------------------------
# What the topic is made of
# -------------------------------------------------------------------------------------------------
def _rows(query):
    res = query.execute()
    return (res.data if res else None) or []


def path_of(supabase, device_id):
    """
    The device's row in device_uns_paths, `{"enterprise", "uns_path", "skip_reason"}`, or None
    when the view has no row for it. Cached per device.
    """
    def load():
        rows = _rows(
            supabase.table(PATH_VIEW)
            .select("device_id,enterprise,uns_path,skip_reason")
            .eq("device_id", device_id)
        )
        return rows[0] if rows else None
    return _context.get(("path", device_id), load)


def units_of(supabase):
    """Metric name -> units, from the catalog. One read per TTL for the whole table."""
    def load():
        rows = _rows(supabase.table("metric_catalog").select("name,units"))
        return {r["name"]: r.get("units") for r in rows if r.get("name")}
    return _context.get(("units",), load)


def topic_for(enterprise, row, root=None):
    """
    The device's topic base, or `(None, reason)` when it has none. Pure.

    `row` is the device's device_uns_paths row, which holds the rule: every level the asset is
    honestly at, and no invented ones. Its path starts with the group last recorded for the
    gateway; the topic takes `enterprise`, the group the message arrived under, so a change of
    group moves the topic at once rather than when the cache expires.
    """
    root = root or UNS_MQTT_TOPIC_ROOT
    if row is None:
        return None, "location_unknown"
    reason = row.get("skip_reason")
    if reason:
        # A reason the counters do not label is counted as a path that could not be read.
        return None, reason if reason in SKIP_REASONS else "location_unknown"
    path, recorded = row.get("uns_path"), row.get("enterprise")
    if not path or not recorded or not path.startswith(recorded + "/"):
        return None, "location_unknown"
    # The root may span levels, as the broker's grant on it does; the group is one level.
    if LEAF_UNSAFE.search(root) or not enterprise or TOPIC_UNSAFE.search(str(enterprise)):
        return None, "unsafe_name"
    return "%s/%s/%s" % (root, enterprise, path[len(recorded) + 1:]), None


def payload_for(metric_name, value, metric_at, units=None, asset_id=None):
    """
    One reading as JSON. `timestamp` is ISO 8601 in UTC at the millisecond precision Sparkplug
    carries; a value is not padded to a precision the wire never had.
    """
    at = metric_at if metric_at.tzinfo else metric_at.replace(tzinfo=timezone.utc)
    body = {
        "name": metric_name,
        "value": value,
        "timestamp": at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    if units:
        body["units"] = units
    if asset_id:
        body["asset_id"] = asset_id
    return body


# -------------------------------------------------------------------------------------------------
# The publish
# -------------------------------------------------------------------------------------------------
def publish_ddata(client, supabase, device, group_id, rows, count=None, observe=None, enabled=None):
    """
    Republish the metrics one DDATA wrote to the historian. `rows` is the list the write used:
    `(metric_at, asset_id, metric_name, val_double, val_string, val_bool)`. Returns the number of
    topics published.

    Called after the commit, so what is published is what was recorded, and never a reading the
    write rolled back. Every failure here is counted and logged and none of it reaches the caller:
    the daemon's job is the historian, and this is an adapter beside it.
    """
    on = UNS_MQTT_ENABLED if enabled is None else enabled
    if not on or not rows:
        return 0
    count = count or (lambda name, n=1: None)
    started = time.perf_counter()
    published = 0
    try:
        base, reason = topic_for(group_id, path_of(supabase, device["id"]))
        if reason:
            count("uns_skipped_%s" % reason, len(rows))
            logger.debug(
                "UNS: not publishing %d metric(s) for '%s' (%s).",
                len(rows), device.get("name"), reason,
            )
            return 0

        units = units_of(supabase)
        for metric_at, asset_id, metric_name, val_double, val_string, val_bool in rows:
            if not metric_name or LEAF_UNSAFE.search(metric_name):
                count("uns_skipped_unsafe_name")
                continue
            value = val_double if val_double is not None else val_string if val_string is not None else val_bool
            body = payload_for(metric_name, value, metric_at, units.get(metric_name), asset_id)
            try:
                client.publish("%s/%s" % (base, metric_name), json.dumps(body, default=str), qos=0, retain=True)
                published += 1
            except Exception as exc:  # noqa: BLE001 - one bad publish must not lose the rest
                count("uns_skipped_publish_error")
                logger.warning("UNS: publish of %s/%s failed: %s", base, metric_name, exc)
        count("uns_published", published)
    except Exception as exc:  # noqa: BLE001 - an adapter must never stop ingestion
        count("uns_skipped_location_unknown", len(rows))
        logger.warning("UNS: could not resolve a topic for '%s': %s", device.get("name"), exc)
    finally:
        if observe:
            observe(time.perf_counter() - started)
    return published


def announce():
    """Log the bridge's state at startup: off and silent reads the same as on and failing."""
    if UNS_MQTT_ENABLED:
        logger.info(
            "UNS bridge is ON: decoded DDATA metrics are republished retained under %s/<enterprise>/"
            "<site>/... once site.name is set and a device's path is complete. The broker ACL is the "
            "only thing deciding who reads that tree.",
            UNS_MQTT_TOPIC_ROOT,
        )
    else:
        logger.info(
            "UNS bridge is off (UNS_MQTT_ENABLED unset). Setting it republishes every decoded "
            "reading on plain %s/ topics, retained, for consumers without a Sparkplug decoder.",
            UNS_MQTT_TOPIC_ROOT,
        )
