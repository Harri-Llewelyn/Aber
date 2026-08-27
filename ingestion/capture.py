#!/usr/bin/env python3
"""
Broker capture and playback -- record live Sparkplug B traffic, and publish it back.

WHAT THIS IS FOR. Three things this stack could not do before: verify a dashboard against a
machine that was on site for two hours, reproduce a fault by editing a value by hand, and load
test at a chosen multiple of real time against a fleet whose measured rate is 0.95 msg/s.

  record   subscribe to the broker and write what arrives to a capture file
  play     publish a capture file back, rebased onto now
  inspect  describe a capture file without a broker

=================================================================================================
THE ONE THING THAT DECIDES THE WHOLE DESIGN: A CAPTURE CANNOT BE PLAYED BACK AS ITSELF.
=================================================================================================

mosquitto.acl confines every gateway to `spBv1.0/+/+/%u/#` -- the fourth topic segment must equal
the connecting username. Its header states the rule this rests on: "THERE IS NO WILDCARD-WRITE
PRINCIPAL", and that was not an oversight to work around. It replaced a shared account that could
forge DBIRTH and DDATA for every machine on site, which `verify_gateway_binding()` could not
detect, "since a forged message under a CORRECTLY BOUND device passes that check by construction".

A playback tool that published captured topics verbatim would be that account, reintroduced --
and would need write access to every edge node that ever appears in any capture. So it does not.
`play` publishes as ONE gateway, under ONE credential provisioned the ordinary way, and REWRITES
the identity in every topic onto assets that gateway owns. Playback is a gateway like any other.

AND THE FAILURE MODE FOR GETTING THIS WRONG IS SILENCE, which is why it is refused up front rather
than discovered. mosquitto.acl records that a refused publish is dropped with no PUBACK at QoS 0,
under MQTT 3.1.1 and 5 alike, so "the publisher learns nothing from the broker by construction".
validate.py has already been bitten by exactly this: a mismatch there "shows up as every publish
being silently dropped", producing "a full run in which every publish went nowhere". `play`
therefore refuses to start when the target gateway is not the credential it holds, because the
alternative is a playback that reports success and moves nothing.

=================================================================================================
WHY TIMESTAMPS ARE REBASED, AND WHY THAT IS ALSO THE SPEED CONTROL
=================================================================================================

`_timestamp_is_sane()` rejects any metric more than 24 hours behind now, because such a row "lands
outside the retention policy, or inside an already-compressed chunk that rejects the write". A
capture published at its original timestamps is therefore worthless the day after it was recorded.

It also could not be written even if it were fresh: `telemetry`'s primary key is
`(time, asset_id, metric_name)`, so a verbatim second run collides with the first row for row.

So playback rebases: every timestamp moves by the same offset, preserving the intervals between
them. Dividing that offset by a speed factor is the same operation, which is why there is one
mechanism here and not two.

TWO PLACES CARRY A TIMESTAMP AND BOTH MUST MOVE. `payload.timestamp` is the message clock, but
process_ddata() reads `metric.timestamp` per metric and only falls back to the payload's when the
metric has none. Rebasing the payload alone leaves every metric on its original clock, and the
sanity window then drops the lot -- a playback that connects, publishes, reports success, and
writes nothing.

=================================================================================================
THE FILE IS ALWAYS JSON. THE WIRE IS WHATEVER WAS RECORDED.
=================================================================================================

Editing a captured value by hand is half the point of the feature, so the file holds the readable
form regardless of what arrived. The shape it uses is deliberately the one
parse_sparkplug_payload() already accepts as its fallback, so a hand-edit that is valid here is
valid to the daemon too.

BUT PLAYBACK RE-ENCODES INTO THE ENCODING EACH MESSAGE ARRIVED IN, and that is not a detail. Both
encodings are live traffic on this stack -- the Node-RED simulator flow publishes JSON, physical
gateways publish protobuf -- and they enter the daemon down different branches of
parse_sparkplug_payload(). Replaying a JSON fleet as protobuf would mean a fault reproduced
through this tool could be one the playback introduced, or one it silently repaired. The encoding
is part of what was observed, so it is part of what is replayed.

That both encodings are in use here was not obvious and was found by recording: the first version
of this tool understood protobuf only, skipped every message the seeded fleet published, and then
reported the fleet as idle.
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

# The recorder is a CONSUMER, so it defaults to a principal mosquitto.acl already grants
# `read spBv1.0/#` and no asset write at all. Recording needs nothing more, and pointing it at a
# gateway credential would hand a mistyped subcommand the ability to publish.
#
# FALLS BACK TO THE INGESTION PRINCIPAL'S OWN VARIABLES, because that is how .env names it. The
# daemon reads MQTT_USER/MQTT_PASSWORD and docker-compose maps MQTT_INGESTION_* onto those inside
# the container -- so a host-run tool that read MQTT_PASSWORD would find nothing in a shell that
# had sourced .env, which is the only way anybody runs this.
RECORD_USER = os.getenv("MQTT_CAPTURE_USER") or os.getenv("MQTT_INGESTION_USER") \
    or "factoryplus_ingestion"
RECORD_PASSWORD = (os.getenv("MQTT_CAPTURE_PASSWORD") or os.getenv("MQTT_INGESTION_PASSWORD")
                   or os.getenv("MQTT_PASSWORD") or "")

# Playback authenticates as the gateway it publishes as -- username == sparkplug_id, which is what
# makes the `%u` pattern in mosquitto.acl constrain anything at all. No fallback and no default:
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
    The inverse: a dict back to a protobuf Payload object.

    Every assignment is guarded on presence for the same HasField reason as above -- and on the
    way in this also matters because the file may have been HAND EDITED, so an absent key is a
    deliberate statement and must not be filled in with a zero.
    """
    payload = sparkplug_b_pb2.Payload()
    if data.get("timestamp") is not None:
        payload.timestamp = int(data["timestamp"])
    if data.get("seq") is not None:
        # Sparkplug's seq is a single byte that wraps. A hand-edited 300 is a typo, but taking it
        # modulo rather than refusing matches what the daemon's own JSON fallback does with it.
        payload.seq = int(data["seq"]) % 256
    if data.get("uuid"):
        payload.uuid = str(data["uuid"])

    for m in data.get("metrics", []):
        metric = payload.metrics.add()
        if m.get("name") is not None:
            metric.name = str(m["name"])
        if m.get("alias") is not None:
            metric.alias = int(m["alias"])
        if m.get("timestamp") is not None:
            metric.timestamp = int(m["timestamp"])
        if m.get("datatype") is not None:
            metric.datatype = int(m["datatype"])
        if m.get("string_value") is not None:
            metric.string_value = str(m["string_value"])
        if m.get("double_value") is not None:
            metric.double_value = float(m["double_value"])
        if m.get("boolean_value") is not None:
            metric.boolean_value = bool(m["boolean_value"])
        if m.get("int_value") is not None:
            metric.int_value = int(m["int_value"])
        if m.get("long_value") is not None:
            metric.long_value = int(m["long_value"])
        if m.get("float_value") is not None:
            metric.float_value = float(m["float_value"])
    return payload


def dict_to_payload_bytes(data):
    """The same, serialised -- what a protobuf-encoded message puts on the wire."""
    return dict_to_payload(data).SerializeToString()


# ---------------------------------------------------------------------------------------------
# Wire encodings
# ---------------------------------------------------------------------------------------------
# BOTH OF THESE ARE LIVE TRAFFIC ON THIS STACK, which is not obvious and cost a recording to find
# out. `parse_sparkplug_payload()` falls back to JSON because the Node-RED simulator flow publishes
# it, so a recorder that only understood protobuf skipped every single message from the seeded
# fleet and then reported the fleet as idle.
ENCODING_PROTOBUF = "protobuf"
ENCODING_JSON = "json"


def decode_wire_payload(raw):
    """
    (Payload, encoding) for one message off the wire, mirroring parse_sparkplug_payload().

    Protobuf first, then JSON, in that order and for the daemon's reason: whatever the daemon
    would have made of these bytes is what the capture should record. A capture that decoded more
    carefully than the daemon does would faithfully record traffic the daemon never ingested.
    """
    payload = sparkplug_b_pb2.Payload()
    try:
        payload.ParseFromString(raw)
        return payload, ENCODING_PROTOBUF
    except Exception:
        pass
    data = json.loads(raw.decode("utf-8"))
    return dict_to_payload(data), ENCODING_JSON


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

    THE GROUP IS NOT REWRITTEN. resolve_gateway() scopes the edge-node lookup by group, and the
    playback gateway is registered under one group; but a capture recorded under a different group
    that is otherwise valid should fail the binding check loudly rather than be quietly relabelled
    into passing. `--group` overrides it explicitly when that is genuinely what is wanted.
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
    """
    if speed <= 0:
        raise CaptureError("speed must be greater than zero, got %r" % (speed,))

    def move(ts):
        return int(play_epoch_ms + (int(ts) - capture_epoch_ms) / speed)

    out = dict(payload_dict)
    if out.get("timestamp") is not None:
        out["timestamp"] = move(out["timestamp"])

    metrics = []
    for m in payload_dict.get("metrics", []):
        entry = dict(m)
        if entry.get("timestamp") is not None:
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
    version = capture.get("acs_capture_version")
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


def unsane_timestamps(plan, now_ms):
    """
    Which planned metrics would be dropped by the daemon's sanity window.

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
    bad = []
    for delay_ms, topic, _, payload in plan:
        # The clock at the moment this message is actually published, not at planning time.
        at_send_ms = now_ms + delay_ms
        stamps = [payload.get("timestamp")]
        stamps += [m.get("timestamp") for m in payload.get("metrics", [])]
        for ts in stamps:
            if ts is not None and not timestamp_is_sane(ts, at_send_ms):
                bad.append((topic, ts, at_send_ms))
                break
    return bad


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

    client = _connect(RECORD_USER, RECORD_PASSWORD, "acs-capture-record")
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
        "acs_capture_version": CAPTURE_VERSION,
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

    # THE REFUSAL THAT SAVES A SILENT RUN. mosquitto.acl pins the edge-node segment to the
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

    client = _connect(PLAY_USER, PLAY_PASSWORD, "acs-capture-play")
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
            # QoS 0, matching every other Sparkplug publisher on this stack. mosquitto.acl
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
          % (args.capture, capture.get("acs_capture_version"), capture.get("recorded_at")))
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
                    "was recorded from: mosquitto.acl confines a client to its own edge-node "
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
