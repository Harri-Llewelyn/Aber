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

TIMESTAMPS ARE REBASED, AND BOTH PLACES THAT CARRY ONE MUST MOVE. The daemon refuses a metric more
than 24 hours behind now (7 days when it is flagged `is_historical`), and `telemetry`'s primary key
is `(time, asset_id, metric_name)`, so a verbatim run is both out of window and a row-for-row
collision. Every timestamp moves by one offset, preserving the intervals; dividing that offset by a
speed factor is the same operation, which is why there is one mechanism and not two.
`payload.timestamp` is the message clock, but process_ddata() reads `metric.timestamp` per metric
and falls back to the payload's only when the metric has none -- rebase the payload alone and the
sanity window drops the lot.

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
import base64
import binascii
import codecs
import json
import math
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from google.protobuf import json_format
from google.protobuf.message import DecodeError

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
# How long `record` waits for the SUBACK before it would ask for a birth it could not record.
SUBSCRIBE_TIMEOUT_SECONDS = 10

# Playback authenticates as the gateway it publishes as -- username == sparkplug_id, which is what
# makes the broker's %u rule constrain anything at all. No fallback and no default:
# there is no gateway this tool should pick on an operator's behalf.
PLAY_USER = os.getenv("MQTT_PLAYBACK_USER", "")
PLAY_PASSWORD = os.getenv("MQTT_PLAYBACK_PASSWORD", "")

# Mirrors ingestion.py, including the environment variable and the default of the historical bound.
# Named here rather than imported because importing the daemon pulls in its database and Supabase
# clients, and this tool must run against a capture file with neither. A unit test holds the three
# to the daemon's.
TELEMETRY_MAX_AGE_SECONDS = 24 * 60 * 60
TELEMETRY_MAX_FUTURE_SECONDS = 5 * 60
TELEMETRY_MAX_HISTORICAL_AGE_SECONDS = int(
    os.getenv("TELEMETRY_MAX_HISTORICAL_AGE_SECONDS", str(7 * 24 * 60 * 60)))

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
# The device segment is present on these three and absent on the node's three
# (tck-id-topic-structure-namespace-device-id-associated-message-types, -non-associated-).
DEVICE_MESSAGE_TYPES = ("DBIRTH", "DDATA", "DDEATH")
# Everything an edge node publishes. NCMD, DCMD and STATE are a host's, and are never recorded.
EDGE_NODE_MESSAGE_TYPES = NODE_MESSAGE_TYPES + DEVICE_MESSAGE_TYPES

# The longest a capture may run from its first message, as its last `offset_ms`.
MAX_OFFSET_MS = 24 * 60 * 60 * 1000

# EVERY value field the proto defines for a scalar metric, and the list is exhaustive on purpose.
# A field missing from here is a value the recorder reads and does not write down, which produces
# a capture that plays back a metric with no value at all -- and set_metric_value() in validate.py
# only ever emits three of these, so a fleet using `float_value` (datatype 9) or `long_value`
# (datatype 4) would be silently hollowed out by a list written from the simulator's habits.
VALUE_FIELDS = (
    "string_value", "double_value", "float_value",
    "boolean_value", "int_value", "long_value",
)

# The rest of a metric, so the file records every field the proto defines. Flags are written only
# when true, as the daemon reads them. Sub-messages are in protobuf's JSON mapping with the proto's
# field names; bytes are base64, and an extension value is its serialised bytes in base64.
FLAG_FIELDS = ("is_historical", "is_transient", "is_null")
MESSAGE_FIELDS = ("metadata", "properties")
MESSAGE_VALUE_FIELDS = ("dataset_value", "template_value")


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
    # A reading replayed from an edge node's buffer. Only a JSON `true` sets it, as only a set
    # protobuf field does on the other path.
    if m.get("is_historical") is True:
        metric.is_historical = True
    for flag in ("is_transient", "is_null"):
        if m.get(flag) is True:
            setattr(metric, flag, True)
    for name in MESSAGE_FIELDS:
        _merge_message(m.get(name), getattr(metric, name))
    if field is None:
        _non_scalar_value(metric, m)
    return metric


def _base64(value):
    """The bytes a base64 string holds, or None when `value` is not one."""
    if not isinstance(value, str):
        return None
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None


def _merge_message(value, target):
    """
    Fill the sub-message `target` from its JSON mapping. Anything not in that form leaves it unset,
    and the metric keeps the rest: these fields carry no reading, so one cannot cost the metric.
    """
    if not isinstance(value, dict):
        return
    try:
        parsed = json_format.ParseDict(value, type(target)())
    except (json_format.Error, AttributeError, RecursionError, TypeError, ValueError):
        return
    target.SetInParent()
    target.MergeFrom(parsed)


def _non_scalar_value(metric, m):
    """The bytes, DataSet, Template or extension value of a metric that has no scalar one."""
    raw = _base64(m.get("bytes_value"))
    if raw is not None:
        metric.bytes_value = raw
        return
    for name in MESSAGE_VALUE_FIELDS:
        _merge_message(m.get(name), getattr(metric, name))
        if metric.HasField(name):
            return
    raw = _base64(m.get("extension_value"))
    if raw is not None:
        extension = type(metric.extension_value)()
        try:
            extension.ParseFromString(raw)
        except DecodeError:
            return
        metric.extension_value.SetInParent()
        metric.extension_value.MergeFrom(extension)


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
    body = _base64(data.get("body"))
    if body is not None:
        payload.body = body
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
    if payload.HasField("body"):
        out["body"] = base64.b64encode(payload.body).decode("ascii")
    out["metrics"] = [metric_to_dict(m) for m in payload.metrics]
    return out


def metric_to_dict(m):
    """One metric as the file records it: every field that is set, and only those."""
    entry = {}
    if m.HasField("name"):
        entry["name"] = m.name
    if m.HasField("alias"):
        entry["alias"] = int(m.alias)
    if m.HasField("timestamp"):
        entry["timestamp"] = int(m.timestamp)
    if m.HasField("datatype"):
        entry["datatype"] = int(m.datatype)
    for flag in FLAG_FIELDS:
        if m.HasField(flag) and getattr(m, flag):
            entry[flag] = True
    for name in MESSAGE_FIELDS:
        if m.HasField(name):
            entry[name] = json_format.MessageToDict(getattr(m, name),
                                                    preserving_proto_field_name=True)
    # The value is a oneof, so at most one of these is set.
    for field in VALUE_FIELDS:
        if m.HasField(field):
            entry[field] = getattr(m, field)
    if m.HasField("bytes_value"):
        entry["bytes_value"] = base64.b64encode(m.bytes_value).decode("ascii")
    for name in MESSAGE_VALUE_FIELDS:
        if m.HasField(name):
            entry[name] = json_format.MessageToDict(getattr(m, name),
                                                    preserving_proto_field_name=True)
    if m.HasField("extension_value"):
        entry["extension_value"] = base64.b64encode(
            m.extension_value.SerializeToString()).decode("ascii")
    return entry


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


# ---------------------------------------------------------------------------------------------
# What a capture file may hold
# ---------------------------------------------------------------------------------------------
# One rule set, restated in the page's upload check (frontend/src/api.js); see README.md -> "The
# file is JSON". Errors name a message by its 0-based index.
def _json_kind(value):
    """The JSON name of a value's type, for a refusal."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, str):
        return "a string"
    if isinstance(value, list):
        return "an array"
    return "an object" if isinstance(value, dict) else type(value).__name__


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def segment_problem(segment):
    """
    What makes `segment` unfit to be a topic segment, or None. A group, edge node or device id is
    valid UTF-8 without '+', '/' or '#' (tck-id-topic-structure-namespace-valid-group-id,
    -valid-edge-node-id, -valid-device-id), and MQTT forbids NUL in a topic.
    """
    if not segment:
        return "is empty"
    for char, name in (("+", "'+'"), ("#", "'#'"), ("/", "'/'"), ("\x00", "a NUL character")):
        if char in segment:
            return "contains %s" % name
    try:
        segment.encode("utf-8")
    except UnicodeEncodeError:
        return "is not valid UTF-8"
    return None


def check_topic(topic):
    """
    (group, msg_type, edge_node, device) for a topic an edge node publishes; CaptureError for any
    other, STATE and the two command types included.
    """
    if not isinstance(topic, str):
        raise CaptureError("its topic is %s, not a string" % _json_kind(topic))
    parts = topic.split("/")
    if parts[0] != "spBv1.0" or len(parts) not in (4, 5):
        raise CaptureError("topic %r is not spBv1.0/<group>/<type>/<edge node>[/<device>]"
                           % (topic,))
    msg_type = parts[2]
    if msg_type not in EDGE_NODE_MESSAGE_TYPES:
        raise CaptureError(
            "topic %r: %s is not one of the six message types an edge node publishes (%s)"
            % (topic, msg_type, ", ".join(EDGE_NODE_MESSAGE_TYPES)))
    has_device = len(parts) == 5
    if has_device != (msg_type in DEVICE_MESSAGE_TYPES):
        raise CaptureError("topic %r: a %s %s a device segment" % (
            topic, msg_type, "never has" if has_device else "always has"))
    for name, segment in (("group", parts[1]), ("edge node", parts[3]),
                          ("device", parts[4] if has_device else None)):
        problem = segment is not None and segment_problem(segment)
        if problem:
            raise CaptureError("topic %r: the %s segment %s" % (topic, name, problem))
    return parts[1], msg_type, parts[3], parts[4] if has_device else None


def _check_message(msg, previous_offset):
    """One message's shape. Returns its offset_ms."""
    if not isinstance(msg, dict):
        raise CaptureError("it is %s, not an object" % _json_kind(msg))
    if "topic" not in msg:
        raise CaptureError("it has no topic")
    check_topic(msg["topic"])
    payload = msg.get("payload")
    if not isinstance(payload, dict):
        raise CaptureError("its payload is %s, not an object" % _json_kind(payload))
    if "metrics" in payload:
        metrics = payload["metrics"]
        if not isinstance(metrics, list):
            raise CaptureError("its metrics are %s, not an array" % _json_kind(metrics))
        for index, metric in enumerate(metrics):
            if not isinstance(metric, dict):
                raise CaptureError("its metric %d is %s, not an object"
                                   % (index, _json_kind(metric)))
    encoding = msg.get("encoding", ENCODING_PROTOBUF)
    if encoding not in (ENCODING_PROTOBUF, ENCODING_JSON):
        raise CaptureError("its encoding %r is neither %r nor %r"
                           % (encoding, ENCODING_PROTOBUF, ENCODING_JSON))

    if "offset_ms" not in msg:
        raise CaptureError("it has no offset_ms")
    offset = msg["offset_ms"]
    if not _is_number(offset) or offset != int(offset):
        raise CaptureError("its offset_ms is %r, not a whole number of milliseconds" % (offset,))
    if offset < 0:
        raise CaptureError("its offset_ms %d is negative" % offset)
    if offset < previous_offset:
        raise CaptureError("its offset_ms %d is earlier than the message before it (%d): the "
                           "messages are out of order" % (offset, previous_offset))
    if offset > MAX_OFFSET_MS:
        raise CaptureError("its offset_ms %d is more than 24 hours after the first message, the "
                           "longest a capture may run" % offset)
    return int(offset)


def check_capture(capture):
    """
    The capture file's shape, checked before anything is planned. Returns its messages; raises
    CaptureError naming the first problem.
    """
    _check_fields(capture)
    messages = capture.get("messages")
    if not isinstance(messages, list):
        raise CaptureError("the capture's messages are %s, not an array" % _json_kind(messages))
    if not messages:
        raise CaptureError("capture contains no messages")
    previous = 0
    for index, msg in enumerate(messages):
        try:
            previous = _check_message(msg, previous)
        except CaptureError as err:
            raise CaptureError("message %d: %s" % (index, err)) from None
    return messages


def _check_fields(capture):
    """The document's own fields: an object of this version, with a numeric capture_epoch_ms."""
    if not isinstance(capture, dict):
        raise CaptureError("a capture file is a JSON object, and this one is %s"
                           % _json_kind(capture))
    version = capture.get("aber_capture_version")
    if version != CAPTURE_VERSION:
        raise CaptureError(
            "capture file is version %r, this tool reads version %d. Refusing to guess at the "
            "difference." % (version, CAPTURE_VERSION)
        )
    if "capture_epoch_ms" not in capture:
        raise CaptureError("capture has no capture_epoch_ms; it cannot be rebased")
    if not _is_number(capture["capture_epoch_ms"]):
        raise CaptureError("capture_epoch_ms is %s, not a number; it cannot be rebased"
                           % _json_kind(capture["capture_epoch_ms"]))


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


# ---------------------------------------------------------------------------------------------
# The file, a message at a time
# ---------------------------------------------------------------------------------------------
# Written with each message on a line of its own, after the document's other fields, so a recorder
# keeps each message only as the bytes it writes. read_capture() reads one a message at a time, in
# any layout of the same JSON, for the playback worker. README.md -> "The file is JSON".
MESSAGE_INDENT = b"    "
MESSAGE_SEPARATOR = b",\n" + MESSAGE_INDENT
FILE_TAIL = b"\n  ]\n}\n"


def message_line(entry, first=False):
    """One message as the file holds it, ASCII: its JSON on one line, after the separator from the
    message before it."""
    return (MESSAGE_INDENT if first else MESSAGE_SEPARATOR) + json.dumps(entry).encode("ascii")


def file_head(fields):
    """The file up to its first message: the document's other fields, one per line."""
    lines = ["{\n"]
    lines += ["  %s: %s,\n" % (json.dumps(key), json.dumps(value)) for key, value in fields.items()]
    lines.append('  "messages": [\n')
    return "".join(lines).encode("ascii")


def write_capture(fh, fields, messages):
    """Write a capture file to the binary file `fh`."""
    fh.write(file_head(fields))
    for index, entry in enumerate(messages):
        fh.write(message_line(entry, first=index == 0))
    fh.write(FILE_TAIL)


_JSON_SPACE = re.compile(r"[ \t\n\r]*")
_JSON = json.JSONDecoder()
# A value json could not decode this close to the end of what has been read may have been cut by
# the chunk boundary: `-Infinity` is the longest token, and a `\uXXXX` escape is six characters.
_CUT_MARGIN = 16


class _JsonText:
    """A JSON text read from an iterable of byte chunks, decoded a value at a time."""

    def __init__(self, chunks):
        self._chunks = iter(chunks)
        self._utf8 = codecs.getincrementaldecoder("utf-8")()
        self._read_bytes = 0
        self._ended = False
        self.text = ""
        self.pos = 0
        # Where `text` starts in the whole text, for an error's position.
        self._base = 0
        self._lines = 0
        self._line_start = 0

    def _more(self):
        """Append the next chunk, dropping what has been read. False at the end of the text."""
        if self._ended:
            return False
        if self.pos:
            newlines = self.text.count("\n", 0, self.pos)
            if newlines:
                self._lines += newlines
                self._line_start = self._base + self.text.rfind("\n", 0, self.pos) + 1
            self._base += self.pos
            self.text = self.text[self.pos:]
            self.pos = 0
        for chunk in self._chunks:
            added = self._decode(chunk, False)
            self._read_bytes += len(chunk)
            if added:
                self.text += added
                return True
        self._ended = True
        added = self._decode(b"", True)
        self.text += added
        return bool(added)

    def _decode(self, chunk, final):
        try:
            return self._utf8.decode(chunk, final)
        except UnicodeDecodeError as err:
            raise ValueError("not UTF-8 at byte %d (%s)"
                             % (self._read_bytes + err.start, err.reason)) from None

    def error(self, message, pos=None):
        """A ValueError placing `message` in the whole text, as json.loads() places one."""
        pos = self.pos if pos is None else pos
        newlines = self.text.count("\n", 0, pos)
        if newlines:
            column = pos - self.text.rfind("\n", 0, pos)
        else:
            column = self._base + pos - self._line_start + 1
        return ValueError("%s: line %d column %d (char %d)"
                          % (message, self._lines + newlines + 1, column, self._base + pos))

    def peek(self):
        """The next character after any whitespace, or '' at the end of the text."""
        while True:
            self.pos = _JSON_SPACE.match(self.text, self.pos).end()
            if self.pos < len(self.text):
                return self.text[self.pos]
            if not self._more():
                return ""

    def take(self, char):
        """Read past `char` if it is next."""
        if self.peek() != char:
            return False
        self.pos += 1
        return True

    def value(self):
        """The next JSON value, decoded."""
        if not self.peek():
            raise self.error("Expecting value")
        # After reading more, the value is decoded again from its start, which `pos` still marks.
        while True:
            try:
                value, end = _JSON.raw_decode(self.text, self.pos)
            except json.JSONDecodeError as err:
                cut = err.msg.startswith("Unterminated string") \
                    or err.pos >= len(self.text) - _CUT_MARGIN
                if cut and not self._ended:
                    self._more()
                    continue
                raise self.error(err.msg, err.pos) from None
            # A number that ends where the text read so far does may go on in the next chunk.
            if end == len(self.text) and not self._ended:
                self._more()
                continue
            self.pos = end
            return value


# What read_capture() yields as each top-level messages array begins, and what it records in
# `fields` for a messages value that is an array.
MESSAGES_BEGIN = object()
MESSAGES_ARRAY = object()

_FIRST_CHARACTER_KIND = {"[": "an array", '"': "a string", "t": "a boolean", "f": "a boolean",
                         "n": "null"}


def read_capture(chunks, fields):
    """
    Read a capture file from `chunks`, an iterable of its bytes, without holding the document.
    Yields MESSAGES_BEGIN as each top-level "messages" array begins, then its messages one at a
    time; a repeated key is read as json.loads() reads it, the last one counting. Every other
    top-level field goes into `fields`, and so does a "messages" that is not an array (one that
    is becomes MESSAGES_ARRAY). Raises ValueError where the text is not JSON, and CaptureError
    for a document that is not an object.
    """
    reader = _JsonText(chunks)
    first = reader.peek()
    if first == "\ufeff":
        raise reader.error("Unexpected UTF-8 BOM (decode using utf-8-sig)")
    if first != "{":
        if first and (first in _FIRST_CHARACTER_KIND or first in "-0123456789NI"):
            raise CaptureError("a capture file is a JSON object, and this one is %s"
                               % _FIRST_CHARACTER_KIND.get(first, "a number"))
        raise reader.error("Expecting value")
    reader.pos += 1
    if not reader.take("}"):
        while True:
            if reader.peek() != '"':
                raise reader.error("Expecting property name enclosed in double quotes")
            key = reader.value()
            if not reader.take(":"):
                raise reader.error("Expecting ':' delimiter")
            if key == "messages" and reader.take("["):
                fields[key] = MESSAGES_ARRAY
                yield MESSAGES_BEGIN
                if not reader.take("]"):
                    while True:
                        yield reader.value()
                        if reader.take("]"):
                            break
                        if not reader.take(","):
                            raise reader.error("Expecting ',' delimiter")
            else:
                fields[key] = reader.value()
            if reader.take("}"):
                break
            if not reader.take(","):
                raise reader.error("Expecting ',' delimiter")
    if reader.peek():
        raise reader.error("Extra data")


def check_capture_file(chunks):
    """
    check_capture() for a file read from `chunks`, a message at a time, with the same refusals.
    Returns (fields, message_count, array): the document's other fields, and how many messages
    are in which of its messages arrays (the last, counted from 0).
    """
    fields = {}
    arrays = count = previous = 0
    problem = None
    for item in read_capture(chunks, fields):
        if item is MESSAGES_BEGIN:
            arrays += 1
            count = previous = 0
            problem = None
            continue
        if problem is None:
            try:
                previous = _check_message(item, previous)
            except CaptureError as err:
                problem = CaptureError("message %d: %s" % (count, err))
        count += 1
    _check_fields(fields)
    if fields.get("messages") is not MESSAGES_ARRAY:
        raise CaptureError("the capture's messages are %s, not an array"
                           % _json_kind(fields.get("messages")))
    if not count:
        raise CaptureError("capture contains no messages")
    if problem:
        raise problem
    return fields, count, arrays - 1


def _messages_in(chunks, array):
    """The messages of the file's `array`-th messages array, one at a time."""
    current = -1
    for item in read_capture(chunks, {}):
        if item is MESSAGES_BEGIN:
            current += 1
        elif current == array:
            yield item


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
                "one, onto a replay lane: published unmapped, its readings would reach the "
                "ingestion daemon as a device the Playback gateway has no lane for, and be "
                "quarantined." % (device,)
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

    def move(ts, what):
        if not _is_number(ts):
            raise CaptureError("%s %r is not a number" % (what, ts))
        return int(play_epoch_ms + (int(ts) - capture_epoch_ms) / speed)

    out = dict(payload_dict)
    if out.get("timestamp"):
        out["timestamp"] = move(out["timestamp"], "its payload timestamp")

    metrics = []
    for index, m in enumerate(payload_dict.get("metrics", [])):
        entry = dict(m)
        if entry.get("timestamp"):
            entry["timestamp"] = move(entry["timestamp"], "its metric %d's timestamp" % index)
        metrics.append(entry)
    out["metrics"] = metrics
    return out


def timestamp_is_sane(ts_ms, now_ms, historical=False):
    """
    ingestion.py's timestamp_refusal(), restated so a capture can be checked before it is published.
    A reading flagged `is_historical` may be older; the future bound is the same for both.
    """
    delta = (ts_ms - now_ms) / 1000.0
    oldest = TELEMETRY_MAX_HISTORICAL_AGE_SECONDS if historical else TELEMETRY_MAX_AGE_SECONDS
    return -oldest <= delta <= TELEMETRY_MAX_FUTURE_SECONDS


def _span(seconds):
    """A bound in the unit a person would state it in: 24 hours, 7 days, 5 minutes."""
    if seconds >= 2 * 86400 and seconds % 86400 == 0:
        return "%d days" % (seconds // 86400)
    if seconds >= 3600 and seconds % 3600 == 0:
        return "%d hours" % (seconds // 3600)
    if seconds >= 60 and seconds % 60 == 0:
        return "%d minutes" % (seconds // 60)
    return "%d seconds" % seconds


def window_explanation(speed):
    """
    What puts a reading outside the daemon's window and what to try, for the playback worker's
    refusal and the CLI's. A slow speed is a cause and is named as one: the gap between a stamp and
    the time its message arrives is divided by the speed.
    """
    text = (
        "The daemon keeps a live reading up to %s old, a reading flagged is_historical up to %s "
        "old, and neither more than %s ahead. "
        "Rebasing keeps the gap between a reading's stamp and the time its message is received. "
        "So a reading that was already old when it was recorded, a device clock skewed against "
        "the recorder's, or a hand edit stays outside the window. "
        "A slow --speed stretches that gap, because the gap is divided by the speed. A reading "
        "that fits at 1x can be too old or too far in the future at 0.01x."
        % (_span(TELEMETRY_MAX_AGE_SECONDS), _span(TELEMETRY_MAX_HISTORICAL_AGE_SECONDS),
           _span(TELEMETRY_MAX_FUTURE_SECONDS))
    )
    if speed < 1:
        text += " This playback runs at %gx, so retrying at 1x may help." % speed
    return text


def first_message_epoch_ms(first_payload, first_received_ms):
    """
    The time a capture is rebased from: the first message's own clock, or when that message was
    RECEIVED if its payload carries none. A zero is no clock, as the daemon reads it. The receipt
    time and not the time the recording ended: the offsets count from the first receipt, so a later
    fallback would file every stamped reading early by the length of the recording.
    """
    stamp = first_payload.get("timestamp")
    return int(stamp) if stamp else int(first_received_ms)


# ---------------------------------------------------------------------------------------------
# The Sparkplug session a playback publishes in
# ---------------------------------------------------------------------------------------------
BDSEQ_METRIC = "bdSeq"
# Sparkplug's Int64, the datatype bdSeq carries.
INT64 = 4


def with_bdseq(payload_dict, bdseq):
    """
    A copy of an NBIRTH or NDEATH payload whose bdSeq metric is `bdseq` as an Int64, added when the
    recording carried none. A recorded bdSeq numbered the recorded node's connection; a replayed
    NBIRTH repeats the bdSeq of the Will its own connection registered
    (tck-id-topics-nbirth-bdseq-matching, tck-id-payloads-nbirth-bdseq-repeat).
    """
    out = dict(payload_dict)
    metrics = [dict(m) for m in payload_dict.get("metrics", [])]
    carried = [m for m in metrics if m.get("name") == BDSEQ_METRIC]
    if not carried:
        added = {"name": BDSEQ_METRIC}
        if out.get("timestamp"):
            added["timestamp"] = out["timestamp"]
        metrics.insert(0, added)
        carried = [added]
    for metric in carried:
        for key in VALUE_FIELDS + ("value",):
            metric.pop(key, None)
        metric["datatype"] = INT64
        metric["long_value"] = bdseq
    out["metrics"] = metrics
    return out


def node_death(bdseq, timestamp_ms):
    """An NDEATH, protobuf-encoded as a Will must be: bdSeq is its only metric and it has no seq."""
    return dict_to_payload_bytes({
        "timestamp": timestamp_ms,
        "metrics": [{"name": BDSEQ_METRIC, "datatype": INT64, "long_value": bdseq,
                     "timestamp": timestamp_ms}],
    })


REBIRTH_METRIC = "Node Control/Rebirth"
# Sparkplug's Boolean.
BOOLEAN = 11


def rebirth_request(timestamp_ms):
    """
    An NCMD asking an edge node to rebirth: `Node Control/Rebirth` = true, a timestamp and no seq
    (tck-id-operational-behavior-data-commands-ncmd-rebirth-name, -ncmd-rebirth-value,
    tck-id-payloads-ncmd-timestamp, tck-id-payloads-ncmd-seq). The same request the daemon sends.
    """
    return dict_to_payload_bytes({
        "timestamp": timestamp_ms,
        "metrics": [{"name": REBIRTH_METRIC, "datatype": BOOLEAN, "boolean_value": True}],
    })


def rebirth_target(topic_filter):
    """(group, edge node) when a `record --topic` filter names exactly one edge node, else None."""
    parts = topic_filter.split("/")
    if len(parts) < 4 or parts[0] != "spBv1.0":
        return None
    group, edge_node = parts[1], parts[3]
    if segment_problem(group) or segment_problem(edge_node):
        return None
    return group, edge_node


# ---------------------------------------------------------------------------------------------
# The playback plan
# ---------------------------------------------------------------------------------------------
def plan_playback(capture, gateway_id, device_map, play_epoch_ms, speed=1.0, group=None,
                  bdseq=None):
    """
    Turn a capture into an ordered list of (delay_ms, topic, payload_bytes, payload_dict), as one
    Sparkplug session of `gateway_id`. Pure: every refusal is decided here, with no broker and no
    clock, so the publishing loop cannot make a new decision.

    A session opens with an NBIRTH, so a capture without one is refused. Left out: what comes
    before the first NBIRTH, after a recorded NDEATH until the next NBIRTH, and a device's messages
    outside its DBIRTH..DDEATH. `seq` is numbered per session, 0 on each NBIRTH and none on an
    NDEATH. `bdseq` is the bdSeq of the MQTT session the plan starts in, carried by every NBIRTH and
    NDEATH; a recorded NDEATH ends it and the next is one more, wrapping 255 to 0. None keeps the
    recorded numbers. README.md -> "A replay is its own Sparkplug session".
    """
    messages = check_capture(capture)
    _check_plan_arguments(gateway_id, device_map, group)
    tally = _PlanTally()
    plan = list(_planned(messages, capture["capture_epoch_ms"], gateway_id, device_map,
                         play_epoch_ms, speed, group, bdseq, tally))
    tally.refuse_unplayable()
    return plan


def _check_plan_arguments(gateway_id, device_map, group):
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
    problem = group and segment_problem(group)
    if problem:
        raise CaptureError("the group %r %s" % (group, problem))


class _PlanTally:
    """What a pass over the messages planned, for the refusals only a whole pass can make."""

    def __init__(self):
        self.births = self.data = self.left_out = 0

    def refuse_unplayable(self):
        if not self.births:
            raise CaptureError(
                "this capture holds no NBIRTH, the edge node's birth certificate, so it cannot be "
                "replayed as a Sparkplug session: a session opens with one, and the data after it "
                "is read through what it declares. Record it again on the Capture page, which asks "
                "the edge node for its birth certificate when the recording starts."
            )
        if not self.data:
            raise CaptureError(
                "this capture holds only birth certificates and no NDATA or DDATA%s: nothing to "
                "replay." % (
                    ", once the %d message(s) recorded outside a Sparkplug session are left out "
                    "(a device's data replays only after its DBIRTH)" % self.left_out
                    if self.left_out else "")
            )


def _planned(messages, capture_epoch_ms, gateway_id, device_map, play_epoch_ms, speed, group,
             bdseq, tally):
    """plan_playback()'s messages, one at a time, from checked `messages`."""
    session = bdseq
    seq = 0
    born = False        # an NBIRTH has opened the session and no NDEATH has ended it
    devices = set()     # devices whose DBIRTH this session has published
    for index, msg in enumerate(messages):
        try:
            topic, payload = rewrite_identity(msg["topic"], msg["payload"], gateway_id, device_map)
            _, msg_type, _, device = split_topic(topic)
            if msg_type == "NBIRTH":
                born, devices, seq = True, set(), 0
                tally.births += 1
            elif not born or (msg_type in ("DDATA", "DDEATH") and device not in devices):
                tally.left_out += 1
                continue
            elif msg_type == "DBIRTH":
                devices.add(device)
            elif msg_type == "DDEATH":
                devices.discard(device)
            if group:
                topic = "spBv1.0/%s/%s/%s" % (group, msg_type, gateway_id)
                if device:
                    topic = "%s/%s" % (topic, device)
            payload = rebase_payload(payload, capture_epoch_ms, play_epoch_ms, speed)
            if msg_type == "NDEATH":
                # tck-id-payloads-ndeath-seq: an NDEATH carries no seq.
                payload.pop("seq", None)
                born, devices = False, set()
            else:
                payload["seq"] = seq
                seq = (seq + 1) % 256
            if msg_type in ("NDATA", "DDATA"):
                tally.data += 1
            if session is not None and msg_type in ("NBIRTH", "NDEATH"):
                payload = with_bdseq(payload, session)
                if msg_type == "NDEATH":
                    session = (session + 1) % 256
            delay_ms = int(msg["offset_ms"] / speed)
            # An absent encoding is protobuf: the Sparkplug B default and the daemon's first branch.
            encoding = msg.get("encoding", ENCODING_PROTOBUF)
            planned = (delay_ms, topic, encode_wire_payload(payload, encoding), payload)
        except CaptureError as err:
            raise CaptureError("message %d: %s" % (index, err)) from None
        except (AttributeError, KeyError, OverflowError, TypeError, ValueError) as err:
            raise CaptureError("message %d cannot be encoded: %s" % (index, err)) from None
        yield planned


class FilePlan:
    """
    plan_playback() for a capture file, holding neither the document nor the plan.
    `open_chunks()` returns the file's bytes as an iterable of chunks from its start, and is called
    once per pass. Making the plan reads the file twice, to check it and to plan and judge every
    message, so every refusal comes first; iterating reads it again and yields what plan_playback()
    lists, one message at a time. `bdseq` may be changed before iterating: it changes no refusal.
    """

    def __init__(self, open_chunks, gateway_id, device_map, play_epoch_ms, speed=1.0, group=None,
                 bdseq=None):
        fields, self.message_count, self._array = check_capture_file(open_chunks())
        _check_plan_arguments(gateway_id, device_map, group)
        self._open = open_chunks
        self._arguments = (fields["capture_epoch_ms"], gateway_id, device_map, play_epoch_ms,
                           speed, group)
        self.bdseq = bdseq
        self.length = 0
        self.first_topic = None
        # window_outcome()'s verdict, judged at `play_epoch_ms`, keeping only the first lossy one.
        self.lossy = self.metrics_kept = self.metrics_dropped = 0
        self.first_lossy = None
        tally = _PlanTally()
        for delay_ms, topic, _, payload in self._planned(tally):
            self.length += 1
            self.first_topic = self.first_topic or topic
            kept, dropped, first_bad = window_verdict(delay_ms, topic, payload, play_epoch_ms)
            self.metrics_kept += kept
            self.metrics_dropped += dropped
            if first_bad is not None:
                self.lossy += 1
                self.first_lossy = self.first_lossy or (topic, first_bad, play_epoch_ms + delay_ms)
        tally.refuse_unplayable()

    def _planned(self, tally):
        return _planned(_messages_in(self._open(), self._array), *self._arguments,
                        bdseq=self.bdseq, tally=tally)

    def __len__(self):
        return self.length

    def __iter__(self):
        return self._planned(_PlanTally())


def window_verdict(delay_ms, topic, payload, now_ms):
    """window_outcome() for one planned message: (metrics kept, metrics dropped, the first dropped
    one's stamp or None)."""
    if split_topic(topic)[1] != "DDATA":
        return 0, 0, None
    at_send_ms = now_ms + delay_ms
    payload_ts = payload.get("timestamp")
    if payload_ts is None or payload_ts <= 0:
        payload_ts = at_send_ms
    kept = dropped = 0
    first_bad = None
    for metric in payload.get("metrics", []):
        ts = metric.get("timestamp")
        if ts is None or ts <= 0:
            ts = payload_ts
        if timestamp_is_sane(ts, at_send_ms, metric.get("is_historical") is True):
            kept += 1
        else:
            dropped += 1
            if first_bad is None:
                first_bad = ts
    return kept, dropped, first_bad


def window_outcome(plan, now_ms):
    """
    How the daemon's sanity window will treat a plan: (lossy, metrics_kept, metrics_dropped).

    `lossy` holds (topic, first offending stamp, at_send_ms) for each message that would lose a
    metric. The rule is process_ddata()'s, the only place the daemon applies the window, so only
    DDATA is judged: a birth or a node message writes no reading. A metric is judged on its own
    timestamp, or its payload's when it has none (absent or zero), or its arrival when neither has
    one; a true `is_historical` takes the longer bound. Each message is judged when it is sent,
    `now_ms + delay_ms`, so the speed the plan was made at is in the verdict. README.md ->
    "Rebasing, and why it is also the speed control".
    """
    lossy = []
    kept = dropped = 0
    for delay_ms, topic, _, payload in plan:
        message_kept, message_dropped, first_bad = window_verdict(delay_ms, topic, payload, now_ms)
        kept += message_kept
        dropped += message_dropped
        if first_bad is not None:
            lossy.append((topic, first_bad, now_ms + delay_ms))
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
    ignored = []
    started_ms = None
    started_monotonic = None

    def on_message(client, userdata, msg):
        nonlocal started_ms, started_monotonic
        # What the daemon's on_message() ingests and nothing else: STATE, NCMD, DCMD and an empty
        # payload are left out, so the file holds only what a playback can publish.
        try:
            check_topic(msg.topic)
        except CaptureError:
            ignored.append(msg.topic)
            return
        if not msg.payload:
            ignored.append(msg.topic)
            return
        try:
            payload, encoding = decode_wire_payload(msg.payload)
        except Exception:
            # A payload this tool cannot decode is not written down as if it had been. Recording
            # a placeholder would produce a capture that plays back something the fleet never
            # sent, which is worse than a capture that is honestly short.
            skipped.append(msg.topic)
            print("  skipped undecodable payload on %s" % msg.topic, file=sys.stderr)
            return

        # Offsets from the monotonic clock, as the daemon's recorder stamps them: the wall clock can
        # step back, and a file whose offsets run backwards is refused at replay.
        now = time.monotonic_ns()
        if started_monotonic is None:
            started_monotonic = now
            started_ms = int(time.time() * 1000)
        offset_ms = (now - started_monotonic) // 1_000_000
        messages.append({
            "offset_ms": offset_ms,
            "topic": msg.topic,
            "encoding": encoding,
            "payload": payload_to_dict(payload),
        })
        if args.verbose:
            print("  %6dms  %s" % (offset_ms, msg.topic))

    client = _connect(RECORD_USER, RECORD_PASSWORD, "aber-capture-record")
    client.on_message = on_message
    subscribed = threading.Event()
    client.on_subscribe = lambda *_args: subscribed.set()
    client.subscribe(args.topic, qos=0)
    client.loop_start()

    print("Recording %s from %s:%d for %ds (Ctrl-C to stop early)..."
          % (args.topic, MQTT_HOST, MQTT_PORT, args.seconds))
    asked = _ask_for_rebirth(client, args, subscribed)
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
        if ignored:
            raise CaptureError(
                "recorded no messages: the %d that arrived were STATE, NCMD or DCMD, or empty, "
                "and an edge node publishes none of those. No edge node published under %r."
                % (len(ignored), args.topic)
            )
        raise CaptureError(
            "recorded no messages, and none arrived at all. The fleet may be idle, or %r may not "
            "be granted `read %s`." % (RECORD_USER, args.topic)
        )

    # THE CAPTURE EPOCH IS THE FIRST MESSAGE'S OWN CLOCK, not the recorder's. Rebasing measures
    # every timestamp's distance from this, so taking it from the wall clock at connect time
    # would fold the recorder's idle wait into every offset -- and would make the rebasing depend
    # on how long the recorder sat waiting for the fleet to say something. A first message with no
    # clock falls back to when it arrived.
    epoch_ms = first_message_epoch_ms(messages[0]["payload"], started_ms)

    edge_nodes, devices = capture_identities(messages)
    capture = {
        "aber_capture_version": CAPTURE_VERSION,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "recorded_from": {"broker": "%s:%d" % (MQTT_HOST, MQTT_PORT), "topic": args.topic},
        "capture_epoch_ms": epoch_ms,
        "duration_ms": messages[-1]["offset_ms"],
        "identities": {"edge_nodes": edge_nodes, "devices": devices},
        "messages": messages,
    }
    with open(args.out, "wb") as fh:
        write_capture(fh, {k: v for k, v in capture.items() if k != "messages"}, messages)

    print("\nWrote %s" % args.out)
    _print_summary(capture)
    if ignored:
        print("  left out:   %d STATE, NCMD, DCMD or empty message(s)" % len(ignored))
    if asked and not any(split_topic(m["topic"])[1] == "NBIRTH" for m in messages):
        # A refused QoS 0 publish is dropped without a word, so the broker can't say which.
        print("\n  A rebirth was asked for and no NBIRTH arrived: the edge node may not answer")
        print("  rebirth requests, or %r may not be allowed to publish NCMD." % RECORD_USER)
    return 0


def _ask_for_rebirth(client, args, subscribed):
    """
    Ask the edge node `--topic` names for its birth certificate once the subscription is in place,
    so its answer is recorded. True when asked. A filter covering several edge nodes asks none:
    each would republish every birth it holds.
    """
    if args.no_rebirth:
        return False
    target = rebirth_target(args.topic)
    if target is None:
        print("  No rebirth asked for: %s names no single edge node. Without the edge node's NBIRTH"
              % args.topic)
        print("  the file cannot be played back; name one with --topic "
              "spBv1.0/<group>/+/<edge node>/#.")
        return False
    if not subscribed.wait(SUBSCRIBE_TIMEOUT_SECONDS):
        print("  No rebirth asked for: the broker did not confirm the subscription within %ds, so"
              " the answer could not be recorded." % SUBSCRIBE_TIMEOUT_SECONDS)
        return False
    group, edge_node = target
    sent = client.publish("spBv1.0/%s/NCMD/%s" % (group, edge_node),
                          rebirth_request(int(time.time() * 1000)), qos=0, retain=False)
    if sent.rc != mqtt.MQTT_ERR_SUCCESS:
        print("  The rebirth request could not be sent (rc=%s)." % sent.rc)
        return False
    print("  Asked %s in group %s for its birth certificate (Node Control/Rebirth)."
          % (edge_node, group))
    return True


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
    if "NBIRTH" not in by_type:
        print("\n  No NBIRTH was recorded, so this capture cannot be played back: a replay opens")
        print("  with the edge node's birth certificate. Record again with --topic naming the edge")
        print("  node, so the recorder asks it for one, or record on the Capture page, which asks")
        print("  for one itself.")
    if capture["identities"]["devices"]:
        print("\n  Playback needs a --map for each device above, onto a replay lane of the")
        print("  Playback gateway: the Capture page's Prepare replay lanes makes them.")


# ---------------------------------------------------------------------------------------------
# play
# ---------------------------------------------------------------------------------------------
# Where a command-line user gets the Playback gateway's password. The page issues it; the
# break-glass provisioning script writes no platform record, and the worker would then hold a
# password the broker no longer has.
CREDENTIAL_ADVICE = (
    "Set MQTT_PLAYBACK_USER to the Playback gateway's sparkplug_id and MQTT_PLAYBACK_PASSWORD to "
    "its broker password. Issue the password from the gateway's drawer on the Gateways page "
    "(Generate Broker Credential), which shows it once. On Kubernetes the same password is "
    "delivered into the `mosquitto-passwords` Secret, key `playback_credentials.json`, as "
    "{\"<sparkplug_id>\": \"<password>\"}. Issuing a new one replaces the one the dashboard's "
    "playback worker holds; it reaches the worker within about a minute."
)


def cmd_play(args):
    # Imported here: playback_worker imports this module.
    import playback_worker

    with open(args.capture, encoding="utf-8") as fh:
        capture = json.load(fh)

    device_map = parse_device_map(args.map)
    edge_node = args.as_gateway
    bdseq = playback_worker._next_bdseq.get(edge_node, 0)
    now_ms = int(time.time() * 1000)
    plan = plan_playback(
        capture,
        gateway_id=edge_node,
        device_map=device_map,
        play_epoch_ms=now_ms,
        speed=args.speed,
        group=args.group,
        bdseq=bdseq,
    )
    left_out = len(capture["messages"]) - len(plan)
    if left_out:
        print("%d message(s) recorded outside a Sparkplug session are left out: before the first "
              "NBIRTH, after an NDEATH, or a device's before its DBIRTH." % left_out)

    bad = unsane_timestamps(plan, now_ms)
    if bad:
        topic, ts, at = bad[0]
        detail = (
            "%d of %d messages carry a timestamp the daemon will reject as too old or too far in "
            "the future at the moment they are sent (first: %s, stamped %s, sent at %s). %s"
            % (len(bad), len(plan), topic,
               datetime.fromtimestamp(ts / 1000.0, timezone.utc).isoformat(),
               datetime.fromtimestamp(at / 1000.0, timezone.utc).isoformat(),
               window_explanation(args.speed))
        )
        if not args.allow_unsane:
            raise CaptureError(
                detail + "\n\nThose metrics would be dropped and the playback would report "
                "success. Correct the timestamps in the capture, or pass --allow-unsane if the "
                "rejection is what is being tested."
            )
        print("WARNING: " + detail, file=sys.stderr)

    if args.dry_run:
        print("Dry run -- nothing published. Plan for gateway %s:" % edge_node)
        for delay_ms, topic, _, _ in plan[: args.head]:
            print("  +%7dms  %s" % (delay_ms, topic))
        if len(plan) > args.head:
            print("  ... %d more" % (len(plan) - args.head))
        return 0

    # The broker confines a client to its own edge-node segment and drops the rest at QoS 0 with
    # nothing logged at either end, so a mismatch is refused before connecting.
    if PLAY_USER != edge_node:
        raise CaptureError(
            "MQTT_PLAYBACK_USER is %r but --as-gateway is %r. The broker confines a client to "
            "`spBv1.0/+/+/<username>/#`, so every publish in this run would be discarded and the "
            "playback would report success having moved nothing. %s"
            % (PLAY_USER or "(unset)", edge_node, CREDENTIAL_ADVICE)
        )
    if not PLAY_PASSWORD:
        raise CaptureError("MQTT_PLAYBACK_PASSWORD is not set; the broker runs allow_anonymous "
                           "false. " + CREDENTIAL_ADVICE)

    # The dashboard's session, opened and ended by the same functions: the NDEATH as the Will,
    # the CONNACK awaited, and the NDEATH published before DISCONNECT.
    playback_worker.MQTT_HOST, playback_worker.MQTT_PORT = MQTT_HOST, MQTT_PORT
    will_topic = "spBv1.0/%s/NDEATH/%s" % (split_topic(plan[0][1])[0], edge_node)
    client = None
    sent = 0

    print("Playing %d messages as %s at %.3fx..." % (len(plan), edge_node, args.speed))
    started = time.time()
    try:
        for delay_ms, topic, payload_bytes, _ in plan:
            # Scheduled against the start of the run, so publishing time does not accumulate.
            remaining = started + delay_ms / 1000.0 - time.time()
            if remaining > 0:
                time.sleep(remaining)
            if client is None:
                client, error = playback_worker._open_session(edge_node, PLAY_PASSWORD,
                                                              will_topic, bdseq)
                if error and not sent:
                    raise CaptureError("%s\n\n%s" % (error, CREDENTIAL_ADVICE))
                if error:
                    raise CaptureError("publishing stopped after %d message(s): %s" % (sent, error))
            if split_topic(topic)[1] == "NDEATH":
                # A recorded death ends the session; the plan numbered what follows as the next.
                playback_worker._end_session(client, topic, payload_bytes)
                client = None
                bdseq = (bdseq + 1) % 256
            else:
                # QoS 0, as Sparkplug requires for these types. A publish the client could not
                # send is a lost connection, and the run stops rather than reporting success.
                info = client.publish(topic, payload_bytes, qos=0, retain=False)
                if info.rc != mqtt.MQTT_ERR_SUCCESS:
                    raise CaptureError(
                        "publishing stopped after %d message(s): the broker connection was lost "
                        "(%s)" % (sent, mqtt.error_string(info.rc)))
            sent += 1
            if args.verbose:
                print("  +%7dms  %s" % (delay_ms, topic))
    except KeyboardInterrupt:
        print("\nStopped early.")
    finally:
        if client is not None:
            playback_worker._end_session(client, will_topic,
                                         node_death(bdseq, int(time.time() * 1000)))

    print("Done in %.1fs: %d message(s) published." % (time.time() - started, sent))
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
    rec.add_argument("--topic", default="spBv1.0/#",
                     help="topic filter (default spBv1.0/#). Name one edge node, "
                          "spBv1.0/<group>/+/<edge node>/#, and the recorder asks it for its birth "
                          "certificate when the recording starts")
    rec.add_argument("--no-rebirth", action="store_true",
                     help="don't ask the edge node --topic names for its birth certificate")
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
                      help="the Playback gateway's sparkplug_id; must equal MQTT_PLAYBACK_USER")
    play.add_argument("--map", action="append", metavar="dev<captured>=dev<target>",
                      help="map a captured device onto its replay lane, made by the Capture page's "
                           "Prepare replay lanes; any other id stays in quarantine")
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
