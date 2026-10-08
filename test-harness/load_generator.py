"""
Synthetic Sparkplug B load, for measuring where this stack stops keeping up.

Publishes DDATA for a fleet that `scripts/load-test.mjs up` provisioned, holding each rate in
`--plan` for its duration (and, with `--soak`, the last rate that held for longer), and samples the
ingestion daemon's own metrics endpoint across every step. The report names the step at which the
historian writer stopped draining its queue, and whether the shortfall was the stack's or this
generator's. `--compress` adds the run's chunks' compressed bytes a row.

NOT the demonstration simulator: nothing here runs unless a Job is applied on purpose, the fleet
must already exist in the directory, and the accounts it publishes as are fixture accounts.
NOT playback either: playback replays one capture at the capture's own timestamps.

See test-harness/README.md for the method and the measured envelope.
"""
import argparse
import json
import os
import random
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict

import paho.mqtt.client as mqtt

import sparkplug_b_pb2

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

# The same transport contract as ingestion.py and validate.py: `mosquitto.tls.internalClients`
# sets all three names at once, and a named-but-absent CA file refuses to start.
MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TLS_ENABLED = os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
MQTT_TLS_CA_FILE = os.getenv("MQTT_TLS_CA_FILE", "").strip()

# One password for every fixture account: these are throwaway accounts on a stack being loaded,
# issued and revoked by the same script in the same minute. `scripts/load-test.mjs up` generates it.
LOADGEN_PASSWORD = os.getenv("LOADGEN_PASSWORD", "")
LOADGEN_PREFIX = os.getenv("LOADGEN_PREFIX", "LOADGEN")
# Only for a gateway row carrying no group of its own. Same env and same default as the
# daemon reads, so the generator addresses a device exactly where the daemon expects it.
DEFAULT_SPARKPLUG_GROUP = os.getenv("SPARKPLUG_GROUP", "Aber")

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")

METRICS_URL = os.getenv("INGESTION_METRICS_URL", "http://ingestion-metrics:9108/metrics")
# The BROKER's own exporter, and the only place a message lost between publisher and daemon
# is counted. Telemetry is QoS 0, so Mosquitto sheds rather than buffers for a subscriber
# that has stopped reading -- and the daemon cannot count what never reached it. Optional:
# the exporter is present only when metrics are enabled, and a run without it is still valid,
# it just cannot say where an undelivered message went.
BROKER_METRICS_URL = os.getenv("BROKER_METRICS_URL", "http://mosquitto:9234/metrics")

# TimescaleDB, for the storage figures. Optional: without it every other measurement still runs.
DB_HOST = os.getenv("DB_HOST", "")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

# The daemon's write queue. A step is saturated when the queue ends above this and is still
# climbing; at TELEMETRY_QUEUE_MAX_MESSAGES the daemon starts dropping DDATA outright.
QUEUE_SATURATED_DEPTH = int(os.getenv("LOADGEN_QUEUE_SATURATED_DEPTH", "500"))
# How far short of its target a step may publish before the generator is called the limit.
PUBLISH_SHORTFALL_TOLERANCE = 0.95
# How much backlog a publisher carries before abandoning it, in seconds of its own rate.
BACKLOG_LIMIT_SECONDS = 1.0


def pace(elapsed, rate, sent):
    """
    How many messages are due now, and how many are abandoned as too old to be worth sending.

    A backlog older than BACKLOG_LIMIT_SECONDS is given up rather than repaid: a burst catching up
    measures neither the target nor the limit, and the shortfall is itself the finding.
    """
    due = int(elapsed * rate) - sent
    if due <= rate * BACKLOG_LIMIT_SECONDS:
        return max(due, 0), 0
    abandoned = due - int(rate * BACKLOG_LIMIT_SECONDS)
    return due - abandoned, abandoned

# The metric set every synthetic device declares at birth. Names, not aliases: a name-carrying
# payload is the larger and slower of the two wire forms, so an envelope measured on it holds for
# an aliased fleet.
METRIC_NAMES = [
    "Systems/TEMPERATURE",
    "Systems/PRESSURE",
    "Systems/VIBRATION",
    "Controller/EXECUTION",
    "Controller/CYCLE_COUNT",
    "Controller/SPINDLE_SPEED",
    "Environmental/HUMIDITY_RELATIVE",
    "Environmental/AMBIENT_TEMPERATURE",
    "Power/ACTIVE_POWER",
    "Power/ENERGY_TOTAL",
    "Quality/GOOD_COUNT",
    "Quality/REJECT_COUNT",
    "Motion/AXIS_X_POSITION",
    "Motion/AXIS_Y_POSITION",
    "Motion/AXIS_Z_POSITION",
    "Tooling/TOOL_LIFE_REMAINING",
    "Tooling/TOOL_NUMBER",
    "Coolant/FLOW_RATE",
    "Coolant/LEVEL",
    "Hydraulics/PRESSURE",
]


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


# -------------------------------------------------------------------------------------------
# The fleet, read from the directory
# -------------------------------------------------------------------------------------------

def _rest(path):
    """One PostgREST GET as service_role. The secret key is both apikey and bearer at the gateway."""
    request = urllib.request.Request(
        f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}",
        headers={
            "apikey": SUPABASE_SECRET_KEY,
            "Authorization": f"Bearer {SUPABASE_SECRET_KEY}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def discover_fleet():
    """
    The synthetic gateways and their devices, as the generator will publish them.

    Read from the directory rather than from a manifest so the ids are the ones the database
    generated, which are the ids the daemon resolves and the broker roles are named after.
    """
    gateways = _rest(
        f"gateways?name=like.{LOADGEN_PREFIX}%25"
        "&select=id,name,sparkplug_id,sparkplug_group&order=name"
    )
    if not gateways:
        raise SystemExit(
            f"No gateway is named '{LOADGEN_PREFIX}%' in the directory.\n"
            "  The fleet is provisioned separately: node scripts/load-test.mjs up --gateways N "
            "--devices-per-gateway M"
        )

    by_gateway = {g["id"]: [] for g in gateways}
    # Paged on what came back, not on the page size asked for: PostgREST caps a response at its own
    # `max-rows`, which may be smaller than the page and would end the loop one page in.
    offset, page = 0, 1000
    while True:
        rows = _rest(
            "devices?select=id,name,sparkplug_id,gateway_id&order=id"
            f"&gateway_id=in.({','.join(by_gateway)})&limit={page}&offset={offset}"
        )
        if not rows:
            break
        for row in rows:
            by_gateway[row["gateway_id"]].append(row)
        offset += len(rows)

    fleet = []
    for gateway in gateways:
        devices = by_gateway[gateway["id"]]
        if devices:
            fleet.append((gateway, devices))
    if not any(devices for _, devices in fleet):
        raise SystemExit(f"The '{LOADGEN_PREFIX}' gateways hold no devices; nothing to publish.")
    return fleet


# -------------------------------------------------------------------------------------------
# Payloads
# -------------------------------------------------------------------------------------------

def _set_value(metric, value):
    if isinstance(value, bool):
        metric.boolean_value = value
        metric.datatype = 11
    elif isinstance(value, (int, float)):
        metric.double_value = float(value)
        metric.datatype = 10
    else:
        metric.string_value = str(value)
        metric.datatype = 12


REBIRTH_METRIC_NAME = "Node Control/Rebirth"


class SequenceCounter:
    """
    One edge node's Sparkplug `seq`, shared by its NBIRTH, DBIRTH and DDATA: an NBIRTH restarts it
    at 0, every other message takes the next value, and it wraps from 255 to 0. A value is
    committed only once its message was handed to the client, so a failed publish is not a gap.
    """

    def __init__(self):
        self.last = None

    def peek(self, msg_type):
        if msg_type == "NBIRTH" or self.last is None:
            return 0
        return (self.last + 1) % 256

    def commit(self, seq):
        self.last = seq


def asks_for_rebirth(payload):
    """Whether an NCMD payload carries `Node Control/Rebirth` = true."""
    return any(m.name == REBIRTH_METRIC_NAME and m.boolean_value for m in payload.metrics)


def device_birth(asset_id, asset_name, metric_names, timestamp_ms, seq):
    """A DBIRTH declaring the metric set. Asset_ID is the cross-check against the topic."""
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms
    payload.seq = seq
    identity = payload.metrics.add()
    identity.name = "Asset_ID"
    identity.string_value = asset_id
    identity.datatype = 12
    name_hint = payload.metrics.add()
    name_hint.name = "Asset_Name"
    name_hint.string_value = asset_name
    name_hint.datatype = 12
    for name in metric_names:
        metric = payload.metrics.add()
        metric.name = name
        metric.timestamp = timestamp_ms
        _set_value(metric, 0.0)
    return payload.SerializeToString()


def node_birth(timestamp_ms, seq):
    """An NBIRTH. Node topics carry no device, so there is no Asset_ID to declare."""
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms
    payload.seq = seq
    metric = payload.metrics.add()
    metric.name = "bdSeq"
    metric.timestamp = timestamp_ms
    metric.long_value = 0
    metric.datatype = 8
    return payload.SerializeToString()


def device_data(metric_names, timestamp_ms, rng, seq):
    """A DDATA carrying one value per declared metric. No Asset_ID: the topic is authoritative."""
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms
    payload.seq = seq
    for name in metric_names:
        metric = payload.metrics.add()
        metric.name = name
        metric.timestamp = timestamp_ms
        _set_value(metric, rng.uniform(0.0, 1000.0))
    return payload.SerializeToString()


# -------------------------------------------------------------------------------------------
# The daemon's metrics, sampled
# -------------------------------------------------------------------------------------------

def parse_exposition(text, at=None):
    """
    The exposition as {name: value} for plain series and {name: {labels: value}} for labelled ones.

    Labelled series are keyed by the label string as exposed, so a caller asks for
    `sample.labelled['aber_ingestion_messages_total']['msg_type="ddata"']` -- the daemon
    lowercases the type, so `Sample.received_of` is the way to ask rather than a literal.
    """
    plain, labelled = {}, defaultdict(dict)
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        head, _, value = line.rpartition(" ")
        try:
            number = float(value)
        except ValueError:
            continue
        name, brace, rest = head.partition("{")
        if brace:
            labelled[name][rest.rstrip("}")] = number
        else:
            plain[name] = number
    return Sample(plain, labelled, time.time() if at is None else at)


def scrape():
    """One reading of the daemon's metrics endpoint."""
    with urllib.request.urlopen(METRICS_URL, timeout=15) as response:
        return parse_exposition(response.read().decode("utf-8"))


def broker_dropped_total():
    """
    Messages the broker discarded rather than delivered, or None when it cannot be asked.

    Never fatal: this is corroboration for a gap the run can already see, not the measurement.
    """
    try:
        with urllib.request.urlopen(BROKER_METRICS_URL, timeout=10) as response:
            return parse_exposition(response.read().decode("utf-8")).get(
                "broker_publish_messages_dropped", None)
    except Exception:
        return None


class Sample:
    def __init__(self, plain, labelled, at):
        self.plain = plain
        self.labelled = labelled
        self.at = at

    def get(self, name, default=0.0):
        return self.plain.get(name, default)

    def dropped_total(self):
        return sum(self.labelled.get("aber_ingestion_messages_dropped_total", {}).values())

    def dropped_by_reason(self):
        out = {}
        for labels, value in self.labelled.get("aber_ingestion_messages_dropped_total", {}).items():
            out[labels.split('"')[1] if '"' in labels else labels] = value
        return out

    def received_ddata(self):
        return self.received_of("DDATA")

    def received_of(self, *types):
        """
        The daemon counts `messages_<msg_type.lower()>`, so its label reads `msg_type="ddata"`
        while the topic and the Sparkplug specification both say DDATA. Matching case-sensitively
        on the topic's spelling silently returns zero, which reads as "the daemon received
        nothing" -- indistinguishable from a broker that dropped the lot.
        """
        wanted = {f'msg_type="{t.lower()}"' for t in types}
        total = 0.0
        for labels, value in self.labelled.get("aber_ingestion_messages_total", {}).items():
            if labels.lower() in wanted:
                total += value
        return total

    def sequence_gaps(self, nodes=None):
        """`aber_ingestion_sequence_gaps_total` summed over its edge nodes, or over `nodes` only."""
        total = 0.0
        for labels, value in self.labelled.get("aber_ingestion_sequence_gaps_total", {}).items():
            node = labels.split('"')[1] if '"' in labels else labels
            if nodes is None or node in nodes:
                total += value
        return total

    def write_buckets(self):
        """The write histogram's cumulative buckets as {upper bound: count}."""
        out = {}
        for labels, value in self.labelled.get("aber_ingestion_write_seconds_bucket", {}).items():
            bound = labels.split('le="')[-1].split('"')[0]
            out[float("inf") if bound == "+Inf" else float(bound)] = value
        return out


def quantile_from_buckets(before, after, quantile):
    """
    The bucket in which the quantile of the writes made BETWEEN two samples falls, as its upper
    bound. Bucket resolution only -- the count is what is observed, so no interpolation is honest.
    """
    delta = {bound: after.get(bound, 0.0) - before.get(bound, 0.0) for bound in after}
    bounds = sorted(delta)
    total = delta[bounds[-1]] if bounds else 0.0
    if total <= 0:
        return None
    target = total * quantile
    for bound in bounds:
        if delta[bound] >= target:
            return bound
    return bounds[-1]


# -------------------------------------------------------------------------------------------
# Publishing
# -------------------------------------------------------------------------------------------

class Publisher(threading.Thread):
    """
    One MQTT connection, publishing for one gateway's devices.

    One connection per gateway because that is the unit the broker authorises: the per-gateway
    role confines an account to `spBv1.0/+/+/<its own id>/#`. It is also what keeps the generator
    off the critical path -- a single connection's socket writes would be measured instead of the
    stack.

    It behaves as an edge node towards the daemon: one `seq` across its births and data, and an
    NCMD `Node Control/Rebirth` answered with a fresh NBIRTH and DBIRTH set. Every publish happens
    on this thread (or before it starts), so `seq` reaches the wire in order.
    """

    def __init__(self, gateway, devices, metric_names, group_id):
        super().__init__(name=f"pub-{gateway['sparkplug_id']}", daemon=True)
        self.gateway = gateway
        self.devices = devices
        self.metric_names = metric_names
        self.group_id = group_id
        self.node_id = gateway["sparkplug_id"]
        self.client = mqtt.Client(
            client_id=f"loadgen-{self.node_id}", protocol=mqtt.MQTTv5, clean_session=None
        )
        self.connected = threading.Event()
        self.rng = random.Random(self.node_id)
        # The rate this publisher is currently holding, messages per second. Set by the driver.
        self.target_rate = 0.0
        self.published = 0
        self.publish_errors = 0
        # Messages the pacer gave up on rather than repaying as a burst. Non-zero means this
        # generator could not hold the step's rate.
        self.abandoned = 0
        self.sequence = SequenceCounter()
        # Set by an NCMD rebirth request on paho's thread, answered on this one.
        self._rebirth = threading.Event()
        self.rebirths = 0
        self._stop = threading.Event()
        self._cursor = 0
        self._epoch = time.perf_counter()
        self._sent_this_step = 0
        # One timestamp per device, never repeating: telemetry is keyed (time, asset_id,
        # metric_name) ON CONFLICT DO NOTHING, so a repeated millisecond silently loses its rows.
        self._last_ms = {}

    def connect(self):
        self.client.username_pw_set(self.node_id, LOADGEN_PASSWORD)
        if MQTT_TLS_ENABLED:
            if MQTT_TLS_CA_FILE and not os.path.isfile(MQTT_TLS_CA_FILE):
                raise SystemExit(
                    f"MQTT_TLS_ENABLED is set and MQTT_TLS_CA_FILE={MQTT_TLS_CA_FILE} does not "
                    "exist; the system trust store cannot verify the internal CA."
                )
            self.client.tls_set(
                ca_certs=MQTT_TLS_CA_FILE or None,
                cert_reqs=ssl.CERT_REQUIRED,
                tls_version=ssl.PROTOCOL_TLS_CLIENT,
            )
            self.client.tls_insecure_set(False)

        def on_connect(client, _userdata, _flags, reason_code, _properties=None):
            if getattr(reason_code, "value", reason_code) == 0:
                client.subscribe(f"spBv1.0/{self.group_id}/NCMD/{self.node_id}", qos=0)
                self.connected.set()

        self.client.on_connect = on_connect
        self.client.on_message = self._on_command
        self.client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
        self.client.loop_start()
        if not self.connected.wait(timeout=30):
            raise SystemExit(
                f"Gateway {self.node_id} did not connect to {MQTT_HOST}:{MQTT_PORT}. The account is "
                "issued by `scripts/load-test.mjs up`; a wrong LOADGEN_PASSWORD refuses here."
            )

    def _next_ms(self, asset_id):
        now = int(time.time() * 1000)
        previous = self._last_ms.get(asset_id)
        if previous is not None and now <= previous:
            now = previous + 1
        self._last_ms[asset_id] = now
        return now

    def _send(self, msg_type, topic, build):
        """Publish `build(seq)` with this node's next `seq`. Returns whether the client took it."""
        seq = self.sequence.peek(msg_type)
        info = self.client.publish(topic, build(seq))
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            return False
        self.sequence.commit(seq)
        return True

    def births(self):
        """NBIRTH, then a DBIRTH per device. Returns how many births were published."""
        stamp = int(time.time() * 1000)
        self._send("NBIRTH", f"spBv1.0/{self.group_id}/NBIRTH/{self.node_id}",
                   lambda seq: node_birth(stamp, seq))
        for device in self.devices:
            asset_id, name = device["sparkplug_id"], device["name"]
            self._send(
                "DBIRTH", f"spBv1.0/{self.group_id}/DBIRTH/{self.node_id}/{asset_id}",
                lambda seq, a=asset_id, n=name: device_birth(
                    a, n, self.metric_names, self._next_ms(a), seq),
            )
        return len(self.devices) + 1

    def _on_command(self, _client, _userdata, message):
        """An NCMD for this node, on paho's thread. Only a rebirth request is acted on."""
        try:
            payload = sparkplug_b_pb2.Payload()
            payload.ParseFromString(message.payload)
        except Exception:
            return
        if asks_for_rebirth(payload):
            self._rebirth.set()

    def answer_rebirth(self):
        """The births again, if a rebirth was asked for since the last call. Returns whether."""
        if not self._rebirth.is_set():
            return False
        self._rebirth.clear()
        self.births()
        self.rebirths += 1
        return True

    def publish_one(self):
        device = self.devices[self._cursor % len(self.devices)]
        self._cursor += 1
        asset_id = device["sparkplug_id"]
        sent = self._send(
            "DDATA", f"spBv1.0/{self.group_id}/DDATA/{self.node_id}/{asset_id}",
            lambda seq: device_data(self.metric_names, self._next_ms(asset_id), self.rng, seq),
        )
        if not sent:
            self.publish_errors += 1
            return False
        self.published += 1
        return True

    def run(self):
        """
        Hold `target_rate` by publishing whatever the elapsed time says is due.

        Due-count pacing rather than sleep-per-message: a 1 ms sleep cannot express 2000 messages
        per second. `pace()` decides what is due and what is too old to send.
        """
        while not self._stop.is_set():
            self.answer_rebirth()
            rate = self.target_rate
            if rate <= 0:
                time.sleep(0.005)
                continue
            due, abandoned = pace(time.perf_counter() - self._epoch, rate, self._sent_this_step)
            if abandoned:
                self._sent_this_step += abandoned
                self.abandoned += abandoned
            if due <= 0:
                time.sleep(0.001)
                continue
            for _ in range(min(due, 500)):
                if self._stop.is_set():
                    break
                self.publish_one()
                self._sent_this_step += 1

    def begin_step(self, rate):
        self._epoch = time.perf_counter()
        self._sent_this_step = 0
        self.target_rate = rate

    def end_step(self):
        self.target_rate = 0.0
        return self._sent_this_step

    def stop(self):
        self._stop.set()
        self.client.loop_stop()
        try:
            self.client.disconnect()
        except Exception:
            pass


# -------------------------------------------------------------------------------------------
# Storage
# -------------------------------------------------------------------------------------------

CHUNK_SIZE_SQL = """
SELECT coalesce(sum(total_bytes), 0)::bigint AS total,
       coalesce(sum(table_bytes), 0)::bigint AS heap,
       coalesce(sum(index_bytes), 0)::bigint AS indexes,
       count(*)::bigint AS chunks
  FROM chunks_detailed_size('telemetry')
"""


def _historian():
    """A connection to the historian, or None when none is configured or psycopg2 is absent."""
    if not DB_HOST:
        return None
    try:
        import psycopg2
    except ImportError:
        return None
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD,
        connect_timeout=15,
    )


def storage_snapshot():
    """Bytes and chunk count for the telemetry hypertable, or None when no historian is configured."""
    connection = None
    try:
        connection = _historian()
        if connection is None:
            return None
        with connection.cursor() as cursor:
            cursor.execute(CHUNK_SIZE_SQL)
            total, heap, indexes, chunks = cursor.fetchone()
            cursor.execute("SELECT count(*)::bigint FROM telemetry")
            (rows,) = cursor.fetchone()
        return {"total_bytes": total, "heap_bytes": heap, "index_bytes": indexes,
                "chunks": chunks, "rows": rows}
    except Exception as error:
        log(f"Storage snapshot unavailable: {error}")
        return None
    finally:
        if connection is not None:
            connection.close()


# The chunks a run wrote into: every telemetry chunk whose range ends after the run started.
RUN_CHUNKS_SQL = """
SELECT format('%%I.%%I', chunk_schema, chunk_name), range_start, range_end, is_compressed
  FROM timescaledb_information.chunks
 WHERE hypertable_name = 'telemetry' AND range_end > to_timestamp(%s)
 ORDER BY range_start
"""
CHUNKS_BYTES_SQL = """
SELECT coalesce(sum(total_bytes), 0)::bigint
  FROM chunks_detailed_size('telemetry')
 WHERE format('%%I.%%I', chunk_schema, chunk_name) = ANY(%s)
"""
COMPRESSION_STATS_SQL = """
SELECT coalesce(sum(before_compression_total_bytes), 0)::bigint,
       coalesce(sum(after_compression_total_bytes), 0)::bigint
  FROM chunk_compression_stats('telemetry')
 WHERE format('%%I.%%I', chunk_schema, chunk_name) = ANY(%s)
"""


def compress_run_chunks(since):
    """
    compress_chunk() on every chunk the run wrote into, with chunks_detailed_size read before and
    after. The chunks hold whatever else was written in their range, so the figures are the
    chunks', counted over all their rows. Returns None with no historian, {"error": ...} on failure.
    """
    connection = None
    try:
        connection = _historian()
        if connection is None:
            return None
        connection.autocommit = True
        with connection.cursor() as cursor:
            cursor.execute(RUN_CHUNKS_SQL, (since,))
            found = cursor.fetchall()
            if not found:
                return {"error": "the run wrote no telemetry chunk"}
            chunks = [row[0] for row in found]
            # compress_chunk(if_not_compressed) leaves a compressed chunk's newer rows as they are,
            # so a chunk an earlier --compress run compressed would give a figure that is not this run's.
            already = [row[0] for row in found if row[3]]
            if already:
                return {"error": f"{', '.join(already)} was already compressed before this run, so "
                                 "compress_chunk() would leave the run's rows as they are. Measure in a "
                                 "chunk the run starts: the next chunk interval, or a fresh stack."}
            cursor.execute("SELECT count(*)::bigint FROM telemetry WHERE time >= %s AND time < %s",
                           (found[0][1], found[-1][2]))
            (rows,) = cursor.fetchone()
            cursor.execute(CHUNKS_BYTES_SQL, (chunks,))
            (before,) = cursor.fetchone()
            started = time.time()
            for name in chunks:
                log(f"compress_chunk({name})...")
                cursor.execute("SELECT compress_chunk(%s::regclass, if_not_compressed => true)", (name,))
            seconds = time.time() - started
            cursor.execute(CHUNKS_BYTES_SQL, (chunks,))
            (after,) = cursor.fetchone()
            cursor.execute(COMPRESSION_STATS_SQL, (chunks,))
            stats_before, stats_after = cursor.fetchone()
        return {"chunks": chunks, "rows": rows, "before_bytes": before, "after_bytes": after,
                "seconds": round(seconds, 1),
                "compression_stats": {"before_bytes": stats_before, "after_bytes": stats_after}}
    except Exception as error:
        return {"error": str(error).strip()}
    finally:
        if connection is not None:
            connection.close()


# -------------------------------------------------------------------------------------------
# The run
# -------------------------------------------------------------------------------------------

def parse_plan(text):
    """`200x60,400x60` -> [(200.0, 60.0), (400.0, 60.0)]."""
    steps = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        rate, _, duration = part.partition("x")
        try:
            step = (float(rate), float(duration))
        except ValueError:
            raise SystemExit(f"--plan step '{part}' is not <rate>x<seconds>")
        if not (step[0] > 0 and step[1] > 0):
            raise SystemExit(f"--plan step '{part}' needs a rate and a duration above zero")
        steps.append(step)
    if not steps:
        raise SystemExit("--plan named no steps")
    return steps


def held(step):
    """A step the stack kept up with: no growing queue, no drops, and the generator kept its rate."""
    return not (step["saturated"] or step["dropped"] or step["generator_limited"])


def soak_target(steps):
    """The last step of the plan that held, which `--soak` holds again; None when none did."""
    candidates = [s for s in steps if held(s) and not s.get("soak")]
    return candidates[-1] if candidates else None


def soaked(step, steps):
    """Whether a soak that held ran at this step's rate or above it."""
    return any(s.get("soak") and held(s) and s["target_rate"] >= step["target_rate"] for s in steps)


def drain(timeout=300.0):
    """Wait, publishing nothing, until the writer's queue is empty. Returns the last depth read."""
    deadline = time.time() + timeout
    depth = None
    while time.time() < deadline:
        try:
            depth = scrape().get("aber_ingestion_write_queue_depth")
        except Exception:
            depth = None
        if depth is not None and depth < 1:
            break
        time.sleep(2)
    return depth


def run_step(publishers, rate, duration, settle):
    """
    Hold one rate and return what the daemon did with it.

    The sample is taken after `settle` seconds, not at the step boundary: the queue carries work
    over from the previous step, and counting that against this one would report the wrong step as
    the first to saturate.
    """
    per_publisher = rate / len(publishers)
    for publisher in publishers:
        publisher.begin_step(per_publisher)

    time.sleep(settle)
    before = scrape()
    broker_before = broker_dropped_total()
    sent_at_sample = sum(p.published for p in publishers)
    abandoned_at_sample = sum(p.abandoned for p in publishers)
    rebirths_at_sample = sum(p.rebirths for p in publishers)
    depths = []
    deadline = time.time() + max(duration - settle, 1.0)
    while time.time() < deadline:
        time.sleep(min(2.0, max(deadline - time.time(), 0.1)))
        try:
            depths.append(scrape().get("aber_ingestion_write_queue_depth"))
        except Exception:
            pass
    after = scrape()
    broker_after = broker_dropped_total()
    published = sum(p.published for p in publishers) - sent_at_sample
    abandoned = sum(p.abandoned for p in publishers) - abandoned_at_sample
    rebirths = sum(p.rebirths for p in publishers) - rebirths_at_sample
    for publisher in publishers:
        publisher.end_step()
    nodes = {p.node_id for p in publishers}

    window = after.at - before.at
    received = after.received_ddata() - before.received_ddata()
    written = after.get("aber_ingestion_messages_written_total") - \
        before.get("aber_ingestion_messages_written_total")
    metrics_written = after.get("aber_ingestion_metrics_written_total") - \
        before.get("aber_ingestion_metrics_written_total")
    write_count = after.get("aber_ingestion_write_seconds_count") - \
        before.get("aber_ingestion_write_seconds_count")
    write_sum = after.get("aber_ingestion_write_seconds_sum") - \
        before.get("aber_ingestion_write_seconds_sum")
    dropped_before = before.dropped_by_reason()
    dropped = {
        reason: value - dropped_before.get(reason, 0.0)
        for reason, value in after.dropped_by_reason().items()
        if value - dropped_before.get(reason, 0.0) > 0
    }

    achieved = published / window if window else 0.0
    # Saturation is the queue ending deep AND deeper than it started: a deep queue that is draining
    # is the previous step being paid off, not this step failing.
    depth_end = after.get("aber_ingestion_write_queue_depth")
    depth_start = before.get("aber_ingestion_write_queue_depth")
    saturated = depth_end > QUEUE_SATURATED_DEPTH and depth_end > depth_start
    generator_limited = achieved < rate * PUBLISH_SHORTFALL_TOLERANCE and not saturated

    return {
        "target_rate": rate,
        "held_seconds": duration,
        "soak": False,
        "duration_seconds": round(window, 1),
        "published": published,
        "published_per_second": round(achieved, 1),
        "abandoned": abandoned,
        "received_per_second": round(received / window, 1) if window else 0.0,
        "written_per_second": round(written / window, 1) if window else 0.0,
        "rows_per_second": round(metrics_written / window, 1) if window else 0.0,
        "undelivered": max(int(published - received), 0),
        "broker_dropped": (
            max(int(broker_after - broker_before), 0)
            if broker_before is not None and broker_after is not None else None),
        "queue_depth_start": int(depth_start),
        "queue_depth_end": int(depth_end),
        "queue_depth_max": int(max(depths + [depth_end, depth_start])),
        "messages_per_transaction": round(written / write_count, 1) if write_count else 0.0,
        "write_mean_ms": round(1000 * write_sum / write_count, 2) if write_count else None,
        "write_p95_bucket_ms": (
            lambda bound: round(1000 * bound, 1) if bound is not None else None
        )(quantile_from_buckets(before.write_buckets(), after.write_buckets(), 0.95)),
        "cache_evictions": sum(
            after.labelled.get("aber_ingestion_cache_evictions_total", {}).values()
        ) - sum(before.labelled.get("aber_ingestion_cache_evictions_total", {}).values()),
        "dropped": dropped,
        # Gaps the daemon saw in this fleet's `seq`, and the rebirths it asked for and was given.
        "sequence_gaps": int(after.sequence_gaps(nodes) - before.sequence_gaps(nodes)),
        "rebirths": rebirths,
        "saturated": saturated,
        "generator_limited": generator_limited,
    }


def verdict(steps):
    """The sentence the run exists to produce: what gave way first, and at what rate."""
    saturated = [s for s in steps if s["saturated"]]
    dropped = [s for s in steps if s["dropped"]]
    limited = [s for s in steps if s["generator_limited"]]
    kept = [s for s in steps if held(s)]
    highest = max((s["written_per_second"] for s in kept), default=None)

    if saturated:
        # The lowest rate, not the first in the plan: a soak runs last, below the ramp's knee.
        first = min(saturated, key=lambda s: s["target_rate"])
        where = f", in the {_held_for(first):.0f} s soak" if first.get("soak") else ""
        return (
            f"The historian writer's queue grew at {first['target_rate']:.0f} msg/s{where} "
            f"(depth {first['queue_depth_start']} -> {first['queue_depth_end']}). "
            f"{highest_held(steps)}."
        )
    if dropped:
        first = dropped[0]
        reasons = ", ".join(f"{r} x{int(v)}" for r, v in first["dropped"].items())
        return (
            f"Messages were dropped at {first['target_rate']:.0f} msg/s ({reasons}). "
            f"{highest_held(steps)}."
        )
    if limited:
        first = limited[0]
        return (
            f"The stack kept up with every step. This generator could not reach "
            f"{first['target_rate']:.0f} msg/s (published {first['published_per_second']:.0f}), so "
            f"the limit above {highest or 0:.0f} msg/s is the generator's and not the stack's. "
            f"{highest_held(steps)}."
        )
    if all(s.get("soak") or soaked(s, steps) for s in steps):
        return f"The stack sustained every step in the plan. {highest_held(steps)}."
    return f"The stack kept up with every step in the plan. {highest_held(steps)}."


def _held_for(step):
    """How long a step held its rate: its planned duration, or the sample window in an old report."""
    return step.get("held_seconds") or step.get("duration_seconds") or 0


def highest_held(steps):
    """
    The highest rate the stack kept, and on what evidence. Only a soak that held makes a rate
    sustained; a step that held for its own duration alone is reported as that. A plan whose every
    step gave way names none, rather than "0 msg/s", which would read as a stack that wrote nothing.
    """
    kept = [s for s in steps if held(s)]
    if not kept:
        return "Highest sustained rate: none in this plan held"
    confirmed = [s for s in kept if s.get("soak") or soaked(s, steps)]
    if confirmed:
        soak = max((s for s in kept if s.get("soak")), key=lambda s: s["target_rate"])
        best = max(s["written_per_second"] for s in confirmed)
        return (f"Highest sustained rate: {best:.0f} msg/s written, "
                f"through a {_held_for(soak):.0f} s soak at {soak['target_rate']:.0f} msg/s")
    best = max(kept, key=lambda s: s["written_per_second"])
    failed = [s for s in steps if s.get("soak") and not held(s)]
    why = (f"the {failed[0]['target_rate']:.0f} msg/s soak did not hold" if failed
           else "not soaked (--soak)")
    return (f"Highest rate held: {best['written_per_second']:.0f} msg/s written, "
            f"for {_held_for(best):.0f} s only; {why}")


def step_note(step, steps):
    """The table's verdict column for one step, read against the whole run for the soak."""
    # Saturation and drops are reported together where both happened: a full queue is what
    # produces `write_queue_full`, and a note carrying only one of them loses the other.
    if step["saturated"]:
        note = "queue growing"
        if step["dropped"]:
            note += "; dropped " + ", ".join(step["dropped"])
    elif step["dropped"]:
        note = "dropped: " + ", ".join(step["dropped"])
    elif step["generator_limited"]:
        note = f"generator-limited ({step['abandoned']} abandoned)"
    elif step.get("soak") or soaked(step, steps):
        note = "sustained"
    elif any(s.get("soak") and s["target_rate"] == step["target_rate"] for s in steps):
        note = f"held {_held_for(step):.0f} s; the soak did not"
    else:
        note = f"held {_held_for(step):.0f} s, not soaked"
    if step.get("soak"):
        note = f"{_held_for(step):.0f} s soak: {note}"
    # An undelivered message is the one loss the daemon cannot see, so say who dropped it
    # where the broker was able to confirm it.
    if step["undelivered"] and step.get("broker_dropped"):
        note += f"; broker shed {step['broker_dropped']:,}"
    if step.get("sequence_gaps") or step.get("rebirths"):
        note += f"; seq gaps {step.get('sequence_gaps', 0)}, rebirths {step.get('rebirths', 0)}"
    return note


def render(report):
    lines = []
    lines.append("")
    lines.append(f"Fleet: {report['gateways']} gateways, {report['devices']} devices, "
                 f"{report['metrics_per_message']} metrics per message")
    lines.append("")
    header = ("| target | published/s | received/s | written/s | rows/s | undelivered | queue end "
              "| msg/txn | write mean | p95 | verdict |")
    lines.append(header)
    lines.append("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |")
    for step in report["steps"]:
        note = step_note(step, report["steps"])
        lines.append(
            f"| {step['target_rate']:.0f} | {step['published_per_second']:.0f} "
            f"| {step['received_per_second']:.0f} | {step['written_per_second']:.0f} "
            f"| {step['rows_per_second']:.0f} | {step['undelivered']:,} "
            f"| {step['queue_depth_end']} "
            f"| {step['messages_per_transaction']:.0f} "
            f"| {step['write_mean_ms'] if step['write_mean_ms'] is not None else '-'} ms "
            f"| {step['write_p95_bucket_ms'] if step['write_p95_bucket_ms'] is not None else '-'} ms "
            f"| {note} |"
        )
    lines.append("")
    storage = report.get("storage")
    if storage and storage.get("after"):
        after, before = storage["after"], storage["before"]
        grown = after["total_bytes"] - before["total_bytes"]
        rows = after["rows"] - before["rows"]
        lines.append(
            f"Historian: {rows:,} rows written, {grown / 1048576:.1f} MiB "
            f"({(after['index_bytes'] - before['index_bytes']) / 1048576:.1f} MiB of it index), "
            f"{after['chunks']} chunks."
        )
        if rows:
            per_row = grown / rows
            # The one figure that sizes a disk, on a stated basis rather than a guessed one: the
            # bytes are measured, the fleet and the rate are arithmetic the reader can redo.
            metrics = report["metrics_per_message"]
            rows_per_day = 1000 * metrics * 86400
            lines.append(f"Per row: {per_row:.1f} bytes on disk, heap and index together.")
            lines.append(
                f"So a thousand devices at one message per second, {metrics} metrics each, write "
                f"{rows_per_day:,} rows a day = {rows_per_day * per_row / 1073741824:.1f} GiB/day "
                "before compression and retention."
            )
        lines.append("")
    lines.extend(compression_lines(report.get("compression"), report["metrics_per_message"]))
    lines.append(f"VERDICT: {report['verdict']}")
    lines.append("")
    return "\n".join(lines)


def compression_lines(compression, metrics):
    """The report's compressed-storage paragraph: nothing without --compress, the error on failure."""
    if not compression:
        return []
    if compression.get("error"):
        return [f"Compressed: not measured. {compression['error']}", ""]
    rows, before, after = compression["rows"], compression["before_bytes"], compression["after_bytes"]
    if not rows or not after:
        return [f"Compressed: not measured. {len(compression['chunks'])} chunk(s) held "
                f"{rows:,} rows and {after:,} bytes after compress_chunk().", ""]
    rows_per_day = 1000 * metrics * 86400
    lines = [
        f"Compressed (compress_chunk on the {len(compression['chunks'])} chunk(s) the run wrote, "
        f"{rows:,} rows, {compression['seconds']:.0f} s): {before / 1048576:.1f} MiB -> "
        f"{after / 1048576:.1f} MiB, {before / after:.1f}x; {before / rows:.1f} -> "
        f"{after / rows:.1f} bytes a row.",
        f"So the same thousand devices' day takes "
        f"{rows_per_day * after / rows / 1073741824:.1f} GiB compressed, before retention.",
    ]
    # chunk_compression_stats is TimescaleDB's own account of the same compression: a second
    # reading, shown only when it disagrees with chunks_detailed_size by more than a tenth.
    stats_after = (compression.get("compression_stats") or {}).get("after_bytes") or 0
    if stats_after and abs(stats_after - after) > after / 10:
        lines.append(f"chunk_compression_stats reads {stats_after / 1048576:.1f} MiB after "
                     "compression; the two disagree, so neither figure is settled.")
    return lines + [""]


def _log_step(result):
    log(
        f"  published {result['published_per_second']:.0f}/s, "
        f"written {result['written_per_second']:.0f}/s, "
        f"queue {result['queue_depth_start']} -> {result['queue_depth_end']}, "
        f"write mean {result['write_mean_ms']} ms, "
        f"seq gaps {result['sequence_gaps']}, rebirths {result['rebirths']}"
    )
    if result["saturated"]:
        log("  the writer's queue is growing; the knee is here.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--plan", default="100x90,250x90,500x90,1000x90,2000x90",
        help="steps as <rate>x<seconds>, comma separated",
    )
    parser.add_argument(
        "--metrics-per-message", type=int, default=10,
        help=f"how many of the {len(METRIC_NAMES)} declared metrics each DDATA carries",
    )
    parser.add_argument(
        "--settle", type=float, default=15.0,
        help="seconds at the step's rate before the sample window opens",
    )
    parser.add_argument(
        "--birth-timeout", type=float, default=300.0,
        help="seconds to wait for the daemon to consume every DBIRTH",
    )
    parser.add_argument(
        "--soak", type=float, default=0.0,
        help="after the plan, hold the last step that held for this many seconds; 0 runs no soak",
    )
    parser.add_argument(
        "--compress", action="store_true",
        help="compress_chunk() the chunks the run wrote and report compressed bytes a row",
    )
    parser.add_argument("--report", default="", help="write the report as JSON to this path")
    arguments = parser.parse_args()

    if arguments.soak < 0:
        raise SystemExit("--soak is a number of seconds, 0 or more")
    if not LOADGEN_PASSWORD:
        raise SystemExit(
            "LOADGEN_PASSWORD is not set. The fixture accounts are issued by "
            "`node scripts/load-test.mjs up`, which stores it in the load-test Secret."
        )
    if arguments.metrics_per_message > len(METRIC_NAMES):
        raise SystemExit(
            f"--metrics-per-message is at most {len(METRIC_NAMES)}; METRIC_NAMES declares that many."
        )

    steps = parse_plan(arguments.plan)
    metric_names = METRIC_NAMES[:arguments.metrics_per_message]

    log(f"Discovering the '{LOADGEN_PREFIX}' fleet in the directory...")
    fleet = discover_fleet()
    device_count = sum(len(devices) for _, devices in fleet)
    log(f"{len(fleet)} gateways, {device_count} devices.")

    publishers = []
    for gateway, devices in fleet:
        group = gateway.get("sparkplug_group") or DEFAULT_SPARKPLUG_GROUP
        publisher = Publisher(gateway, devices, metric_names, group)
        publisher.connect()
        publishers.append(publisher)
    log(f"{len(publishers)} publishers connected to {MQTT_HOST}:{MQTT_PORT}.")

    before_storage = storage_snapshot()

    # Births first, and waited for: a DDATA whose device has not birthed still writes, but the
    # birth path is what a real fleet pays on connection and it is one of the things being measured.
    birth_before = scrape()
    birth_started = run_started = time.time()
    births = sum(publisher.births() for publisher in publishers)
    consumed = 0
    while time.time() - birth_started < arguments.birth_timeout:
        time.sleep(2)
        sample = scrape()
        consumed = sum(
            value - birth_before.labelled.get("aber_ingestion_messages_total", {}).get(labels, 0.0)
            for labels, value in sample.labelled.get("aber_ingestion_messages_total", {}).items()
            if labels.lower() in ('msg_type="dbirth"', 'msg_type="nbirth"')
        )
        if consumed >= births:
            break
    birth_seconds = time.time() - birth_started
    log(f"{births} births published, {int(consumed)} consumed in {birth_seconds:.1f}s "
        f"({births / birth_seconds:.0f}/s).")

    for publisher in publishers:
        publisher.start()

    results = []
    try:
        for rate, duration in steps:
            log(f"Step: {rate:.0f} msg/s for {duration:.0f}s...")
            results.append(run_step(publishers, rate, duration, arguments.settle))
            _log_step(results[-1])
        target = soak_target(results) if arguments.soak else None
        if arguments.soak and target is None:
            log("Soak: no step held, so there is nothing to soak.")
        if target is not None:
            # From an empty queue, so a backlog the ramp left is not counted against the soak.
            depth = drain()
            log(f"Soak: {target['target_rate']:.0f} msg/s, the last step that held, for "
                f"{arguments.soak:.0f}s (the writer's queue at {depth}).")
            results.append(dict(run_step(publishers, target["target_rate"], arguments.soak,
                                         arguments.settle), soak=True))
            _log_step(results[-1])
    finally:
        for publisher in publishers:
            publisher.stop()

    # After the publishers stop: the queue drains into chunks that are only then written.
    time.sleep(10)
    after_storage = storage_snapshot()
    compression = compress_run_chunks(run_started) if arguments.compress else None
    if arguments.compress and compression is None:
        compression = {"error": "no historian is configured (DB_HOST)."}

    report = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gateways": len(fleet),
        "devices": device_count,
        "metrics_per_message": len(metric_names),
        "births": {"published": births, "consumed": int(consumed),
                   "seconds": round(birth_seconds, 1)},
        "steps": results,
        "storage": {"before": before_storage, "after": after_storage},
        "compression": compression,
        "verdict": verdict(results),
    }
    print(render(report))
    if arguments.report:
        with open(arguments.report, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        log(f"Report written to {arguments.report}")


if __name__ == "__main__":
    main()
