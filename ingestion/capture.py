#!/usr/bin/env python3
"""
Broker capture and playback -- record live Sparkplug B traffic, and publish it back.

  record   subscribe to the broker and write what arrives to a capture file
  play     publish a capture file back, rebased onto now
  inspect  describe a capture file without a broker

A CAPTURE CANNOT BE PLAYED BACK AS ITSELF, and that decides the whole design. The broker's roles
confine every gateway to `spBv1.0/+/+/<sparkplug_id>/#`: the fourth topic segment must equal the
connecting username, and there is no wildcard-write principal to fall back on (mosquitto/README.md).
So `play` publishes as ONE gateway, under ONE credential provisioned the ordinary way, and REWRITES
the identity in every topic onto assets that gateway owns.

IT REFUSES UP FRONT WHEN THE TARGET IS NOT THE CREDENTIAL IT HOLDS, because the failure mode is
silence: a refused publish is dropped with no PUBACK at QoS 0 under MQTT 3.1.1 and 5 alike, so the
publisher learns nothing from the broker by construction, and the run reports success and moves
nothing.

TIMESTAMPS ARE REBASED, AND BOTH PLACES THAT CARRY ONE MUST MOVE. `_timestamp_is_sane()` rejects a
metric more than 24 hours behind now, and `telemetry`'s primary key is `(time, asset_id,
metric_name)`, so a verbatim run is both out of window and a row-for-row collision. Every timestamp
moves by one offset, preserving the intervals; dividing that offset by a speed factor is the same
operation, which is why there is one mechanism and not two. `payload.timestamp` is the message
clock, but process_ddata() reads `metric.timestamp` per metric and falls back to the payload's only
when the metric has none -- rebase the payload alone and the sanity window drops the lot.

THE FILE IS ALWAYS JSON; THE WIRE IS WHATEVER WAS RECORDED. Editing a captured value by hand is half
the point, so the file holds the readable form whatever arrived, in the shape
parse_sparkplug_payload() already accepts as its fallback. Playback re-encodes into the encoding
each message arrived in: both are live traffic here, they enter the daemon down different branches,
and replaying a JSON fleet as protobuf would mean a fault reproduced through this tool could be one
the playback introduced. (docs/incidents.md -- "A recorder that understood one encoding reported
the fleet as idle")

Related: README.md -> "Broker Capture and Playback" (what the feature is for, the three caps, and
         the sections this summarises).
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

import sparkplug_b_pb2

# The capture file's own version. Bumped when the shape changes in a way an older reader would
# misread rather than reject -- `play` refuses an unknown version rather than guessing, because a
# capture is exactly the kind of file that gets kept for a year and opened by a newer tool.
CAPTURE_VERSION = 1

MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_TLS_ENABLED = os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
MQTT_TLS_CA_FILE = os.getenv("MQTT_TLS_CA_FILE", "").strip()

# The recorder is a CONSUMER, so it defaults to a principal the broker's roles already grant
# `read spBv1.0/#` and no asset write at all. Recording needs nothing more, and pointing it at a
# gateway credential would hand a mistyped subcommand the ability to publish.
#
# FALLS BACK TO THE INGESTION PRINCIPAL'S OWN VARIABLES: the daemon reads MQTT_USER/MQTT_PASSWORD
# inside its container, while a host-run tool is handed the MQTT_INGESTION_* names.
RECORD_USER = os.getenv("MQTT_CAPTURE_USER") or os.getenv("MQTT_INGESTION_USER") \
    or "aber_ingestion"
RECORD_PASSWORD = (os.getenv("MQTT_CAPTURE_PASSWORD") or os.getenv("MQTT_INGESTION_PASSWORD")
                   or os.getenv("MQTT_PASSWORD") or "")

# Playback authenticates as the gateway it publishes as -- username == sparkplug_id, which is what
# makes the per-gateway role at the broker constrain anything at all. No fallback and no default:
# there is no gateway this tool should pick on an operator's behalf.
PLAY_USER = os.getenv("MQTT_PLAYBACK_USER", "")
PLAY_PASSWORD = os.getenv("MQTT_PLAYBACK_PASSWORD", "")

# Mirrors ingestion.py. Named here rather than imported because importing the daemon pulls in its
# database and Supabase clients, and this tool must run against a capture file with neither.
TELEMETRY_MAX_AGE_SECONDS = 24 * 60 * 60
TELEMETRY_MAX_FUTURE_SECONDS = 5 * 60

# `sparkplug_id` is a GENERATED column: the prefix plus the first 21 hex characters of the row's
# UUID. Anything else is not an id this stack issued, and pinning the shape here is what turns a
# typo into a refusal instead of a silent broker drop.
GATEWAY_ID_RE = re.compile(r"^gwy[0-9a-f]{21}$")
DEVICE_ID_RE = re.compile(r"^dev[0-9a-f]{21}$")

# Read on DBIRTH by extract_claimed_asset_id(). It has to be rewritten alongside the topic: a
# payload still claiming the captured device's id under a rewritten topic is a mismatch, and
# resolve_wire_identity() quarantines exactly that.
ASSET_ID_METRIC = "Asset_ID"

NODE_MESSAGE_TYPES = ("NBIRTH", "NDATA", "NDEATH")

# EVERY value field the proto defines for a scalar metric, and the list is exhaustive on purpose.
# A field missing from here is a value the recorder reads and does not write down, which produces
# a capture that plays back a metric with no value at all -- and set_metric_value() in validate.py
# only ever emits three of these, so a fleet using `float_value` (datatype 9) or `long_value`
# (datatype 4) would be silently hollowed out by a list written from the simulator's habits.
VALUE_FIELDS = (
    "string_value", "double_value", "float_value",
    "boolean_value", "int_value", "long_value",
)


class CaptureError(Exception):
    """A capture file, or a playback plan, that cannot be trusted to do what it says."""


# ---------------------------------------------------------------------------------------------
# The JSON encoding, as the daemon reads it
# ---------------------------------------------------------------------------------------------
# ingestion.py's parse_sparkplug_payload() reads a JSON body through json_payload(), and so do
# decode_wire_payload() and dict_to_payload() here, so a recorded JSON message replays as what the
# daemon stored from it. Defined here, not in the daemon, because this tool runs without the
# daemon's database clients.

# MIRRORED in i3x/i3x_service.py; test_i3x_service.py asserts the two copies agree, and both
# suites read test-harness/fixtures/sparkplug-json-values.json.
def json_metric_value(metric):
    """
    The (field, value, datatype) one JSON-encoded metric carries, as the protobuf encoding would
    hold it: the first present of the six Sparkplug value keys, then a bare `value`, which is typed
    by what it holds. An integer is stored as its two's complement in `int_value`, or `long_value`
    when the key, a 64-bit datatype or its size needs 64 bits; a negative one with no datatype is
    marked Int32 or Int64 so it reads back signed. A `float_value` is rounded to 32 bits.

    (None, None, datatype) when no value key is present. ValueError when the value is not the JSON
    type its key names or does not fit its field; the caller drops that metric, not its payload.
    """
    import struct

    datatype = metric.get("datatype")
    if not isinstance(datatype, int) or isinstance(datatype, bool) or not 0 <= datatype < 2**32:
        datatype = None
    for key in ("int_value", "long_value", "float_value", "double_value", "boolean_value",
                "string_value", "value"):
        value = metric.get(key)
        if value is None:
            continue
        if key == "value" and (isinstance(value, bool) or not isinstance(value, int)):
            key = {bool: "boolean_value", float: "double_value", str: "string_value"}.get(type(value))
            if key is None:
                raise ValueError("value %r is not a number, a boolean or a string" % (value,))
        if key in ("int_value", "long_value", "value"):
            if isinstance(value, float) and value.is_integer():
                value = int(value)
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError("%s %r is not an integer" % (key, value))
            wide = (key == "long_value" or datatype in (4, 8, 13)
                    or (key == "value" and not -(2**31) <= value < 2**32))
            bits = 64 if wide else 32
            if not -(2 ** (bits - 1)) <= value < 2**bits:
                raise ValueError("%s %d does not fit in %d bits" % (key, value, bits))
            if value < 0 and datatype is None:
                datatype = 4 if wide else 3
            return ("long_value" if wide else "int_value"), value & ((1 << bits) - 1), datatype
        if key in ("float_value", "double_value"):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError("%s %r is not a number" % (key, value))
            if key == "float_value":
                try:
                    value = struct.unpack("<f", struct.pack("<f", value))[0]
                except OverflowError:
                    raise ValueError("float_value %r does not fit in 32 bits" % (value,)) from None
            return key, float(value), datatype
        if not isinstance(value, bool if key == "boolean_value" else str):
            raise ValueError("%s %r is not a %s" % (key, value, key.split("_")[0]))
        return key, value, datatype
    return None, None, datatype


# What json_metric() raises for a metric the daemon drops while keeping the rest of its payload.
JSON_METRIC_REFUSED = (AttributeError, TypeError, ValueError)


def json_metric(m):
    """
    One JSON-encoded metric as the protobuf metric the daemon stores. Raises one of
    JSON_METRIC_REFUSED for a metric it drops.
    """
    metric = sparkplug_b_pb2.Payload.Metric()
    field, value, datatype = json_metric_value(m)
    # An absent or null name is an alias-only metric, as i3X reads it. Left unset, as the protobuf
    # encoding leaves it; the daemon reads `metric.name` as '' either way.
    if m.get("name"):
        metric.name = m["name"]
    # Assigning the field is what makes HasField('alias') true, which resolve_metric_name() tests.
    if m.get("alias") is not None:
        metric.alias = int(m["alias"])
    if field is not None:
        setattr(metric, field, value)
    if datatype is not None:
        metric.datatype = datatype
    # The metric's own reading time, which the protobuf path already honours: a report-by-exception
    # refresh or a batched reading is filed when it was taken.
    ts = m.get("timestamp")
    if isinstance(ts, (int, float)) and not isinstance(ts, bool) and ts > 0:
        metric.timestamp = int(ts)
    return metric


def json_payload(data, refused=None):
    """
    A decoded JSON Sparkplug body as the protobuf Payload the daemon reads from it.

    A metric the daemon drops is left out, and appended to `refused` as (metric, error) when a list
    is passed; the rest of the payload is kept. Raises where the daemon drops the whole message. An
    absent payload clock stays absent: the daemon stamps the arrival time itself.
    """
    payload = sparkplug_b_pb2.Payload()
    if "timestamp" in data:
        payload.timestamp = int(data["timestamp"])
    # The Factory+ payload marker. Nothing branches on it: the TOPIC identifies the asset.
    if data.get("uuid"):
        payload.uuid = str(data["uuid"])
    # Only when present and numeric: a defaulted 0 would read as a wrap, and a JSON fleet is not
    # exempt from gap detection.
    seq = data.get("seq")
    if isinstance(seq, (int, float)) and not isinstance(seq, bool):
        payload.seq = int(seq) % 256
    for m in data.get("metrics", []):
        try:
            metric = json_metric(m)
        except JSON_METRIC_REFUSED as err:
            if refused is not None:
                refused.append((m, err))
            continue
        payload.metrics.add().CopyFrom(metric)
    return payload


# ---------------------------------------------------------------------------------------------
# Payload conversion
# ---------------------------------------------------------------------------------------------
def payload_to_dict(payload):
    """
    A Sparkplug payload as the readable, hand-editable shape the capture file stores.

    Only fields that are SET are emitted. That is not tidiness: `HasField` is load bearing all
    over the daemon -- check_message_sequence() tests `HasField('seq')` and resolve_metric_name()
    tests `HasField('alias')` -- so emitting a defaulted 0 for an absent field would turn "this
    publisher sends no sequence number" into "this publisher sent sequence 0", which reads as a
    legitimate wrap and masks a real gap.
    """
    out = {}
    if payload.HasField("timestamp"):
        out["timestamp"] = int(payload.timestamp)
    if payload.HasField("seq"):
        out["seq"] = int(payload.seq)
    if payload.HasField("uuid"):
        out["uuid"] = payload.uuid

    metrics = []
    for m in payload.metrics:
        entry = {}
        if m.HasField("name"):
            entry["name"] = m.name
        if m.HasField("alias"):
            entry["alias"] = int(m.alias)
        if m.HasField("timestamp"):
            entry["timestamp"] = int(m.timestamp)
        if m.HasField("datatype"):
            entry["datatype"] = int(m.datatype)
        # Exactly one value field is set on a well-formed metric, but a capture must not assume
        # that of traffic it did not generate: whatever is set is what gets written down.
        for field in VALUE_FIELDS:
            if m.HasField(field):
                entry[field] = getattr(m, field)
        metrics.append(entry)
    out["metrics"] = metrics
    return out


def dict_to_payload(data):
    """
    The inverse: a dict back to a protobuf Payload object, read as the daemon reads the same dict
    sent as JSON (json_payload()). A playback in either encoding therefore carries what the daemon
    stored from the recording: a metric the daemon drops is dropped, and the rest of the message
    is kept.

    An absent key stays absent, for the same HasField reason as above; the file may have been HAND
    EDITED, so an absent key is a deliberate statement. A null payload clock counts as absent.
    """
    if "timestamp" in data and data["timestamp"] is None:
        data = {key: value for key, value in data.items() if key != "timestamp"}
    return json_payload(data)


def dict_to_payload_bytes(data):
    """The same, serialised -- what a protobuf-encoded message puts on the wire."""
    return dict_to_payload(data).SerializeToString()


# ---------------------------------------------------------------------------------------------
# Wire encodings
# ---------------------------------------------------------------------------------------------
# BOTH OF THESE ARE LIVE TRAFFIC ON THIS STACK. `parse_sparkplug_payload()` falls back to JSON
# because the gateway appliance's flow publishes it, and a standard Sparkplug B edge node publishes
# protobuf, so a recorder that read only one would report the other's gateways as idle.
ENCODING_PROTOBUF = "protobuf"
ENCODING_JSON = "json"


def decode_wire_payload(raw):
    """
    (Payload, encoding) for one message off the wire, mirroring parse_sparkplug_payload().

    Protobuf first, then JSON, in that order and for the daemon's reason: whatever the daemon
    would have made of these bytes is what the capture should record. A capture that decoded more
    carefully than the daemon does would faithfully record traffic the daemon never ingested. The
    JSON arm is the daemon's own json_payload(), so it raises where the daemon drops the message.
    """
    payload = sparkplug_b_pb2.Payload()
    try:
        payload.ParseFromString(raw)
        return payload, ENCODING_PROTOBUF
    except Exception:
        pass
    data = json.loads(raw.decode("utf-8"))
    return json_payload(data), ENCODING_JSON


def encode_wire_payload(payload_dict, encoding):
    """
    Back to the wire in the encoding the message was RECORDED in, not in a preferred one.

    Playing a JSON fleet back as protobuf would exercise the other branch of
    parse_sparkplug_payload() -- so a fault being reproduced through this tool could be a fault
    the playback itself introduced or, worse, one it silently repaired. The encoding is part of
    what was observed, so it is part of what is replayed.
    """
    if encoding == ENCODING_JSON:
        return json.dumps(payload_dict, separators=(",", ":")).encode("utf-8")
    if encoding == ENCODING_PROTOBUF:
        return dict_to_payload_bytes(payload_dict)
    raise CaptureError(
        "unknown wire encoding %r; this capture cannot be replayed faithfully" % (encoding,)
    )


# ---------------------------------------------------------------------------------------------
# Topics and identity
# ---------------------------------------------------------------------------------------------
def split_topic(topic):
    """
    (group, msg_type, edge_node, device) for a Sparkplug topic; device is None on node topics.

    Raises rather than returning None for a topic that is not Sparkplug at all. The recorder
    subscribes to `spBv1.0/#` so nothing else can arrive, which means a topic that fails here is
    a corrupted or hand-mangled capture file and should stop the run rather than be skipped --
    skipping it would play back a subset while reporting a whole.
    """
    parts = topic.split("/")
    if len(parts) < 4 or parts[0] != "spBv1.0":
        raise CaptureError("not a Sparkplug B topic: %r" % (topic,))
    group, msg_type, edge_node = parts[1], parts[2], parts[3]
    device = parts[4] if len(parts) > 4 else None
    return group, msg_type, edge_node, device


def capture_identities(messages):
    """
    Every edge node and device id the capture publishes under, in first-seen order.

    This is what the operator has to provide a mapping for, so it is reported by `inspect` and
    used by `plan_playback` to refuse a partial map rather than pass an unmapped id through.
    """
    edge_nodes, devices = [], []
    for msg in messages:
        _, _, edge_node, device = split_topic(msg["topic"])
        if edge_node not in edge_nodes:
            edge_nodes.append(edge_node)
        if device and device not in devices:
            devices.append(device)
    return edge_nodes, devices


def rewrite_identity(topic, payload_dict, gateway_id, device_map):
    """
    Move one message onto the playback gateway's own assets.

    Returns (topic, payload_dict) -- a NEW dict, because a caller replaying the same capture at
    two speeds must not have the first run's rebasing edit the second run's source.

    THE GROUP IS NOT REWRITTEN. A capture recorded under another group replays under it, and
    resolve_gateway() accepts it by sparkplug_id with a group-mismatch warning, so the difference
    stays visible in the log rather than being quietly relabelled away. `--group` overrides it
    explicitly when that is genuinely what is wanted.
    """
    group, msg_type, _, device = split_topic(topic)

    new_topic = "spBv1.0/%s/%s/%s" % (group, msg_type, gateway_id)
    new_device = None
    if device is not None:
        new_device = device_map.get(device)
        if new_device is None:
            raise CaptureError(
                "device %r appears in the capture but has no mapping. Every captured device needs "
                "one: publishing it unmapped would address an asset this gateway does not own, "
                "which the broker drops silently." % (device,)
            )
        new_topic = "%s/%s" % (new_topic, new_device)

    out = dict(payload_dict)
    out["metrics"] = [dict(m) for m in payload_dict.get("metrics", [])]

    # THE PAYLOAD'S OWN CLAIM HAS TO AGREE WITH THE TOPIC. A DBIRTH carrying the captured device's
    # Asset_ID under a rewritten topic is precisely the disagreement resolve_wire_identity()
    # treats as a faulty identity, so playback would quarantine every device it created.
    #
    # Only rewritten when the metric is ALREADY THERE. An aliased DDATA deliberately carries no
    # Asset_ID -- "the topic is the only identity available" -- and adding one would make the
    # capture less realistic than the traffic it came from.
    for metric in out["metrics"]:
        if metric.get("name") == ASSET_ID_METRIC and new_device is not None:
            metric["string_value"] = new_device

    return new_topic, out


# ---------------------------------------------------------------------------------------------
# Rebasing
# ---------------------------------------------------------------------------------------------
def rebase_payload(payload_dict, capture_epoch_ms, play_epoch_ms, speed=1.0):
    """
    Move every timestamp in one payload from capture time onto playback time.

    One rule applied uniformly: a timestamp `speed` times its original distance from the start of
    the capture, measured from the start of playback. Applied to the payload clock and to every
    metric that carries its own, so the intervals the capture recorded survive.

    A metric with NO timestamp is left without one, deliberately. process_ddata() falls back to
    the payload's for exactly that case, so the fallback keeps working -- whereas materialising
    one here would write a timestamp the original publisher never sent, into a historian, which
    is the same class of corruption `_timestamp_is_sane()` refuses to commit by clamping.

    A ZERO IS NOT A TIMESTAMP EITHER, and is left alone for the same reason. The daemon's test is
    `HasField` plus `> 0`, so a zero already means "use the payload's" -- and it is the payload's
    clock that is rebased. Moving it would turn a reading the daemon files under the payload clock
    into one carrying a manufactured time, far enough from now to be dropped.
    """
    if speed <= 0:
        raise CaptureError("speed must be greater than zero, got %r" % (speed,))

    def move(ts):
        return int(play_epoch_ms + (int(ts) - capture_epoch_ms) / speed)

    out = dict(payload_dict)
    if out.get("timestamp"):
        out["timestamp"] = move(out["timestamp"])

    metrics = []
    for m in payload_dict.get("metrics", []):
        entry = dict(m)
        if entry.get("timestamp"):
            entry["timestamp"] = move(entry["timestamp"])
        metrics.append(entry)
    out["metrics"] = metrics
    return out


def timestamp_is_sane(ts_ms, now_ms):
    """ingestion.py's window, restated so a capture can be checked before it is published."""
    delta = (ts_ms - now_ms) / 1000.0
    return -TELEMETRY_MAX_AGE_SECONDS <= delta <= TELEMETRY_MAX_FUTURE_SECONDS


# ---------------------------------------------------------------------------------------------
# The playback plan
# ---------------------------------------------------------------------------------------------
def plan_playback(capture, gateway_id, device_map, play_epoch_ms, speed=1.0, group=None):
    """
    Turn a capture into an ordered list of (delay_ms, topic, payload_bytes).

    PURE, AND THAT IS THE POINT. Everything that can be wrong about a playback -- an unmapped
    device, a rebasing that lands outside the sanity window, a malformed topic -- is decided here,
    with no broker and no clock, so the tests can assert it and `play --dry-run` can show it.
    Publishing is then a loop that cannot make a new decision.
    """
    version = capture.get("aber_capture_version")
    if version != CAPTURE_VERSION:
        raise CaptureError(
            "capture file is version %r, this tool reads version %d. Refusing to guess at the "
            "difference." % (version, CAPTURE_VERSION)
        )

    if not GATEWAY_ID_RE.match(gateway_id or ""):
        raise CaptureError(
            "%r is not a gateway sparkplug_id ('gwy' followed by 21 lowercase hex characters). "
            "The edge-node segment must equal the row's generated id or verify_gateway_binding() "
            "rejects every message." % (gateway_id,)
        )
    for captured, target in sorted(device_map.items()):
        if not DEVICE_ID_RE.match(target or ""):
            raise CaptureError(
                "%r maps to %r, which is not a device sparkplug_id ('dev' followed by 21 "
                "lowercase hex characters)." % (captured, target)
            )

    messages = capture.get("messages", [])
    if not messages:
        raise CaptureError("capture contains no messages")

    capture_epoch_ms = capture.get("capture_epoch_ms")
    if capture_epoch_ms is None:
        raise CaptureError("capture has no capture_epoch_ms; it cannot be rebased")

    plan = []
    for msg in messages:
        topic, payload = rewrite_identity(msg["topic"], msg["payload"], gateway_id, device_map)
        if group:
            _, msg_type, _, device = split_topic(topic)
            topic = "spBv1.0/%s/%s/%s" % (group, msg_type, gateway_id)
            if device:
                topic = "%s/%s" % (topic, device)
        payload = rebase_payload(payload, capture_epoch_ms, play_epoch_ms, speed)
        delay_ms = int(msg["offset_ms"] / speed)
        # Defaulting an absent encoding to protobuf is for captures written before the field
        # existed, and for a hand-written one. It is the Sparkplug B default and the daemon's
        # first branch, so it is the right thing to assume when nothing says otherwise.
        encoding = msg.get("encoding", ENCODING_PROTOBUF)
        plan.append((delay_ms, topic, encode_wire_payload(payload, encoding), payload))
    return plan


def window_outcome(plan, now_ms):
    """
    How the daemon's sanity window will treat a plan: (lossy, metrics_kept, metrics_dropped).

    `lossy` holds one (topic, timestamp, at_send_ms) per message that would lose at least one
    metric, naming the first offending stamp. The two counts are METRICS, and they are what decides
    whether a playback can write anything at all: a plan every message of which loses a metric is
    not the same claim as a plan that writes nothing, and reading it as one refuses a playback the
    daemon would have filed in full.

    THE RULE IS process_ddata()'S, RESTATED HERE SO A CAPTURE CAN BE CHECKED BEFORE IT IS
    PUBLISHED. A metric is judged on ITS OWN timestamp and falls back to the payload's only when it
    has none -- where none means absent OR zero, because `HasField` plus `> 0` is the test the
    daemon applies. The payload's clock is a verdict on NOTHING by itself: an absent or zero
    payload timestamp becomes the arrival time there, which is in window by construction. So an
    edge node with a skewed clock stamping payloads whose metrics each carry the device's own time
    costs nothing, which is the case the daemon's per-metric rule exists for.

    Reported BEFORE publishing rather than discovered afterwards, because the daemon's answer to
    an out-of-window metric is a counter and not an error -- so without this a playback reports
    success and writes nothing.

    SPEED IS NOT WHAT PUTS A MESSAGE OUT OF WINDOW, and the arithmetic is worth writing down
    because the intuition says otherwise. Playing an hour of capture at 0.1x takes ten hours, so
    the last message is sent ten hours from now -- but rebase_payload() divides by that same
    speed, so its timestamp moves to exactly ten hours from now too. The scheduler and the
    rebasing share a divisor, which makes every message in-window at the instant it is sent no
    matter what speed is chosen. Measuring at `now_ms + delay_ms` rather than at plan time is
    what keeps that true, and this function was first written with a comment claiming the
    opposite.

    What DOES fail is a timestamp already far from the capture epoch, because rebasing preserves
    that distance faithfully:

      * a metric carrying a genuinely old reading, which the daemon would have rejected live too;
      * a device whose clock is skewed against the recorder's, which only becomes visible once
        the capture is rebased onto a different absolute time;
      * a hand-edited timestamp, which is a case this tool invites by design.
    """
    lossy = []
    kept = dropped = 0
    for delay_ms, topic, _, payload in plan:
        # The clock at the moment this message is actually published, not at planning time.
        at_send_ms = now_ms + delay_ms
        payload_ts = payload.get("timestamp")
        if payload_ts is None or payload_ts <= 0:
            payload_ts = at_send_ms
        first_bad = None
        for metric in payload.get("metrics", []):
            ts = metric.get("timestamp")
            if ts is None or ts <= 0:
                ts = payload_ts
            if timestamp_is_sane(ts, at_send_ms):
                kept += 1
            else:
                dropped += 1
                if first_bad is None:
                    first_bad = ts
        if first_bad is not None:
            lossy.append((topic, first_bad, at_send_ms))
    return lossy, kept, dropped


def unsane_timestamps(plan, now_ms):
    """
    Which planned messages would lose a metric to the daemon's sanity window.

    `capture.py play` refuses on any of them, which the worker does not: the CLI has an escape
    hatch to pass and a person at a terminal to read the message. The worker reads
    window_outcome()'s counts instead and refuses only a playback that would write nothing.
    """
    return window_outcome(plan, now_ms)[0]


def parse_device_map(pairs):
    """`--map dev<captured>=dev<target>`, repeatable. Returns {captured: target}."""
    mapping = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise CaptureError("--map expects captured=target, got %r" % (pair,))
        captured, target = pair.split("=", 1)
        captured, target = captured.strip(), target.strip()
        if not captured or not target:
            raise CaptureError("--map expects captured=target, got %r" % (pair,))
        if captured in mapping and mapping[captured] != target:
            raise CaptureError(
                "device %r is mapped twice, to %r and %r" % (captured, mapping[captured], target)
            )
        mapping[captured] = target
    return mapping


# ---------------------------------------------------------------------------------------------
# MQTT plumbing
# ---------------------------------------------------------------------------------------------
def _apply_tls(client):
    """Same posture as ingestion.py: opt-in, verified, and no way to ask for unverified."""
    if not MQTT_TLS_ENABLED:
        return
    if MQTT_TLS_CA_FILE and not os.path.isfile(MQTT_TLS_CA_FILE):
        raise CaptureError(
            "MQTT_TLS_ENABLED is set and MQTT_TLS_CA_FILE=%s does not exist" % MQTT_TLS_CA_FILE
        )
    client.tls_set(ca_certs=MQTT_TLS_CA_FILE or None)


def _connect(username, password, client_id):
    client = mqtt.Client(client_id=client_id)
    client.username_pw_set(username, password)
    _apply_tls(client)
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    return client


# ---------------------------------------------------------------------------------------------
# record
# ---------------------------------------------------------------------------------------------
def cmd_record(args):
    messages = []
    skipped = []
    started_ms = None

    def on_message(client, userdata, msg):
        nonlocal started_ms
        try:
            payload, encoding = decode_wire_payload(msg.payload)
        except Exception:
            # A payload this tool cannot decode is not written down as if it had been. Recording
            # a placeholder would produce a capture that plays back something the fleet never
            # sent, which is worse than a capture that is honestly short.
            skipped.append(msg.topic)
            print("  skipped undecodable payload on %s" % msg.topic, file=sys.stderr)
            return

        now_ms = int(time.time() * 1000)
        if started_ms is None:
            started_ms = now_ms
        messages.append({
            "offset_ms": now_ms - started_ms,
            "topic": msg.topic,
            "encoding": encoding,
            "payload": payload_to_dict(payload),
        })
        if args.verbose:
            print("  %6dms  %s" % (now_ms - started_ms, msg.topic))

    client = _connect(RECORD_USER, RECORD_PASSWORD, "aber-capture-record")
    client.on_message = on_message
    client.subscribe(args.topic, qos=0)
    client.loop_start()

    print("Recording %s from %s:%d for %ds (Ctrl-C to stop early)..."
          % (args.topic, MQTT_HOST, MQTT_PORT, args.seconds))
    try:
        time.sleep(args.seconds)
    except KeyboardInterrupt:
        print("\nStopped early.")
    client.loop_stop()
    client.disconnect()

    if not messages:
        # An empty capture is almost always a credential or ACL problem rather than a quiet fleet,
        # and writing the file anyway would defer that discovery to playback.
        #
        # THE TWO CAUSES ARE NAMED SEPARATELY BECAUSE THEY POINT AT DIFFERENT SUBSYSTEMS, and
        # conflating them cost a debugging session: this tool first understood protobuf only, so
        # against the seeded Node-RED fleet -- which publishes JSON -- it skipped every message
        # and then reported the fleet as idle, sending the reader to look at the simulator.
        if skipped:
            raise CaptureError(
                "recorded no messages, but %d arrived and could not be decoded as Sparkplug B "
                "protobuf or as the JSON encoding parse_sparkplug_payload() accepts. This is a "
                "payload format neither this tool nor the ingestion daemon reads, so the daemon "
                "is not ingesting them either." % len(skipped)
            )
        raise CaptureError(
            "recorded no messages, and none arrived at all. The fleet may be idle, or %r may not "
            "be granted `read %s`." % (RECORD_USER, args.topic)
        )

    # THE CAPTURE EPOCH IS THE FIRST MESSAGE'S OWN CLOCK, not the recorder's. Rebasing measures
    # every timestamp's distance from this, so taking it from the wall clock at connect time
    # would fold the recorder's idle wait into every offset -- and would make the rebasing depend
    # on how long the recorder sat waiting for the fleet to say something.
    first = messages[0]["payload"].get("timestamp")
    capture_epoch_ms = int(first) if first is not None else int(time.time() * 1000)

    edge_nodes, devices = capture_identities(messages)
    capture = {
        "aber_capture_version": CAPTURE_VERSION,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "recorded_from": {"broker": "%s:%d" % (MQTT_HOST, MQTT_PORT), "topic": args.topic},
        "capture_epoch_ms": capture_epoch_ms,
        "duration_ms": messages[-1]["offset_ms"],
        "identities": {"edge_nodes": edge_nodes, "devices": devices},
        "messages": messages,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(capture, fh, indent=2)
        fh.write("\n")

    print("\nWrote %s" % args.out)
    _print_summary(capture)
    return 0


def _print_summary(capture):
    msgs = capture["messages"]
    by_type = {}
    for m in msgs:
        _, msg_type, _, _ = split_topic(m["topic"])
        by_type[msg_type] = by_type.get(msg_type, 0) + 1

    by_encoding = {}
    for m in msgs:
        enc = m.get("encoding", ENCODING_PROTOBUF)
        by_encoding[enc] = by_encoding.get(enc, 0) + 1

    print("  %d messages over %.1fs" % (len(msgs), capture["duration_ms"] / 1000.0))
    print("  types:      %s" % ", ".join("%s=%d" % kv for kv in sorted(by_type.items())))
    # Reported because it is routinely a surprise: the seeded fleet publishes JSON, not protobuf.
    print("  encodings:  %s" % ", ".join("%s=%d" % kv for kv in sorted(by_encoding.items())))
    print("  edge nodes: %s" % ", ".join(capture["identities"]["edge_nodes"]))
    print("  devices:    %s" % (", ".join(capture["identities"]["devices"]) or "(none)"))
    if capture["identities"]["devices"]:
        print("\n  Playback needs a --map for each device above, onto devices bound to the")
        print("  playback gateway. `capture.py play --help` explains why they cannot be reused.")


# ---------------------------------------------------------------------------------------------
# play
# ---------------------------------------------------------------------------------------------
def cmd_play(args):
    with open(args.capture, encoding="utf-8") as fh:
        capture = json.load(fh)

    device_map = parse_device_map(args.map)
    now_ms = int(time.time() * 1000)
    plan = plan_playback(
        capture,
        gateway_id=args.as_gateway,
        device_map=device_map,
        play_epoch_ms=now_ms,
        speed=args.speed,
        group=args.group,
    )

    bad = unsane_timestamps(plan, now_ms)
    if bad:
        topic, ts, at = bad[0]
        detail = (
            "%d of %d messages carry a timestamp the daemon will reject at the moment they are "
            "sent (first: %s, stamped %s, sent at %s). Rebasing preserves how far a timestamp "
            "sits from the capture's own epoch, so this is a reading that was already old when it "
            "was recorded, a device clock skewed against the recorder's, or a hand edit. Note "
            "that --speed cannot cause this: the scheduler and the rebasing divide by it alike."
            % (len(bad), len(plan), topic,
               datetime.fromtimestamp(ts / 1000.0, timezone.utc).isoformat(),
               datetime.fromtimestamp(at / 1000.0, timezone.utc).isoformat())
        )
        if not args.allow_unsane:
            raise CaptureError(
                detail + "\n\nThose metrics would be dropped and the playback would report "
                "success. Correct the timestamps in the capture, or pass --allow-unsane if the "
                "rejection is what is being tested."
            )
        print("WARNING: " + detail, file=sys.stderr)

    if args.dry_run:
        print("Dry run -- nothing published. Plan for gateway %s:" % args.as_gateway)
        for delay_ms, topic, _, _ in plan[: args.head]:
            print("  +%7dms  %s" % (delay_ms, topic))
        if len(plan) > args.head:
            print("  ... %d more" % (len(plan) - args.head))
        return 0

    # THE REFUSAL THAT SAVES A SILENT RUN. The broker's roles pin the edge-node segment to the
    # connecting username, and a mismatch is dropped with nothing logged at either end.
    if PLAY_USER != args.as_gateway:
        raise CaptureError(
            "MQTT_PLAYBACK_USER is %r but --as-gateway is %r. The broker confines a client to "
            "`spBv1.0/+/+/<username>/#`, so every publish in this run would be discarded and the "
            "playback would report success having moved nothing. Provision the credential with\n"
            "  node scripts/mosquitto-provision-gateway.mjs %s"
            % (PLAY_USER or "(unset)", args.as_gateway, args.as_gateway)
        )
    if not PLAY_PASSWORD:
        raise CaptureError("MQTT_PLAYBACK_PASSWORD is not set; the broker runs allow_anonymous false")

    client = _connect(PLAY_USER, PLAY_PASSWORD, "aber-capture-play")
    client.loop_start()

    print("Playing %d messages as %s at %.3fx..." % (len(plan), args.as_gateway, args.speed))
    started = time.time()
    try:
        for delay_ms, topic, payload_bytes, _ in plan:
            # Scheduled against the START of the run, not slept between messages. Cumulative
            # sleeps drift by however long each publish takes, so a long capture arrives
            # progressively later than the intervals it recorded -- which is the one property
            # playback exists to preserve.
            due = started + delay_ms / 1000.0
            remaining = due - time.time()
            if remaining > 0:
                time.sleep(remaining)
            # QoS 0, matching every other Sparkplug publisher on this stack. mosquitto/README.md
            # records why raising it is not an option: Sparkplug B requires QoS 0 for these
            # message types and delegates loss detection to `seq` and the rebirth request.
            client.publish(topic, payload_bytes, qos=0)
            if args.verbose:
                print("  +%7dms  %s" % (delay_ms, topic))
    except KeyboardInterrupt:
        print("\nStopped early.")
    finally:
        client.loop_stop()
        client.disconnect()

    print("Done in %.1fs." % (time.time() - started))
    return 0


# ---------------------------------------------------------------------------------------------
# inspect
# ---------------------------------------------------------------------------------------------
def cmd_inspect(args):
    with open(args.capture, encoding="utf-8") as fh:
        capture = json.load(fh)
    print("%s (version %s, recorded %s)"
          % (args.capture, capture.get("aber_capture_version"), capture.get("recorded_at")))
    _print_summary(capture)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="capture.py",
        description="Record Sparkplug B traffic from the broker, and publish it back rebased "
                    "onto now.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("record", help="subscribe and write a capture file")
    rec.add_argument("--out", required=True, help="capture file to write")
    rec.add_argument("--seconds", type=int, default=60, help="how long to record (default 60)")
    rec.add_argument("--topic", default="spBv1.0/#", help="topic filter (default spBv1.0/#)")
    rec.add_argument("--verbose", action="store_true")
    rec.set_defaults(func=cmd_record)

    play = sub.add_parser(
        "play",
        help="publish a capture back",
        description="Publishes as ONE gateway, rewriting every captured identity onto assets "
                    "that gateway owns. A capture cannot be played back under the identity it "
                    "was recorded from: the broker's roles confine a client to its own edge-node "
                    "segment, and a publish outside it is dropped silently at QoS 0.",
    )
    play.add_argument("capture", help="capture file to play")
    play.add_argument("--as-gateway", required=True, metavar="gwy...",
                      help="the playback gateway's sparkplug_id; must equal MQTT_PLAYBACK_USER")
    play.add_argument("--map", action="append", metavar="dev<captured>=dev<target>",
                      help="map a captured device onto one bound to the playback gateway")
    play.add_argument("--speed", type=float, default=1.0,
                      help="playback rate multiplier (default 1.0)")
    play.add_argument("--group", help="override the Sparkplug group (default: as captured)")
    play.add_argument("--dry-run", action="store_true", help="print the plan, publish nothing")
    play.add_argument("--head", type=int, default=20, help="lines of plan to show on --dry-run")
    play.add_argument("--allow-unsane", action="store_true",
                      help="publish even where the daemon will reject the timestamp")
    play.add_argument("--verbose", action="store_true")
    play.set_defaults(func=cmd_play)

    ins = sub.add_parser("inspect", help="describe a capture file; needs no broker")
    ins.add_argument("capture")
    ins.set_defaults(func=cmd_inspect)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except CaptureError as err:
        print("\ncapture.py: %s" % err, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
