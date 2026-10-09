"""
Unit tests for how the daemon connects to the broker and how it leaves, as a Sparkplug 3.0.0 host
application.

NO BROKER. The CONNECT packet is read off a local socket as raw bytes, from the pinned paho,
because what the broker acts on is the wire:

  * A CLEAN SESSION. tck-id-message-flow-phid-sparkplug-clean-session-50: Clean Start true and no
    Session Expiry Interval. A broker-assigned client id, since nothing is kept between connections.
  * THE DEATH CERTIFICATE IS PROMPT: the will is QoS 1, retained, and carries NO Will Delay Interval
    (property 0x18), so the broker publishes it the moment the connection closes.
    scripts/check-broker-config.mjs asserts the broker's half on the pinned Mosquitto.
  * THE SUBSCRIPTION IS QoS 1, which the specification leaves open for a host application.
  * THE SHUTDOWN publishes the death certificate FIRST, keeps receiving until the stream goes quiet
    (what edge nodes sent before they heard it), then stops the network loop with no DISCONNECT,
    then drains the writer. A shutdown that stopped reading first lost what was already on its way:
    96 messages at 50 msg/s on the dev cluster, the two seconds the old signal handler spent
    blocking the loop while it waited for an acknowledgement that loop had to deliver.
"""
import os
import socket
import sys
import threading
import time
import unittest
from unittest import mock

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import ingestion  # noqa: E402
import primary_host  # noqa: E402

HOST_ID = "Check-Site"
STATE_TOPIC = "spBv1.0/STATE/Check-Site"

PROP_SESSION_EXPIRY = 0x11
PROP_WILL_DELAY = 0x18
# Property id -> encoded width, for the ids paho 1.6.1 can put in a CONNECT or a will; -1 is a
# length-prefixed string or binary, -2 a string pair.
PROP_WIDTH = {
    0x01: 1, 0x02: 4, 0x03: -1, 0x08: -1, 0x09: -1, 0x11: 4, 0x15: -1, 0x16: -1, 0x17: 1,
    0x18: 4, 0x19: 1, 0x21: 2, 0x22: 2, 0x26: -2, 0x27: 4,
}


def _varint(buf, i):
    value, shift = 0, 0
    while True:
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, i


def _properties(buf, i):
    """{id: value} for one properties block starting at i, and the offset after it."""
    length, i = _varint(buf, i)
    end, props = i + length, {}
    while i < end:
        prop, i = _varint(buf, i)
        width = PROP_WIDTH[prop]
        if width > 0:
            props[prop] = int.from_bytes(buf[i:i + width], "big")
            i += width
        else:
            for _ in range(-width):
                n = int.from_bytes(buf[i:i + 2], "big")
                props.setdefault(prop, b"")
                i += 2 + n
    return props, end


def _string(buf, i):
    n = int.from_bytes(buf[i:i + 2], "big")
    return buf[i + 2:i + 2 + n], i + 2 + n


def parse_connect(packet):
    """The fields of an MQTT 5 CONNECT this suite asserts on."""
    assert packet[0] == 0x10, "not a CONNECT: %r" % packet[:4]
    _, i = _varint(packet, 1)
    name, i = _string(packet, i)
    assert name == b"MQTT" and packet[i] == 5, "not MQTT 5"
    flags = packet[i + 1]
    i += 4  # level, flags, keepalive
    connect_props, i = _properties(packet, i)
    client_id, i = _string(packet, i)
    out = {
        "clean_start": bool(flags & 0x02),
        "will": bool(flags & 0x04),
        "will_qos": (flags >> 3) & 0x03,
        "will_retain": bool(flags & 0x20),
        "properties": connect_props,
        "client_id": client_id.decode(),
    }
    if out["will"]:
        out["will_properties"], i = _properties(packet, i)
        topic, i = _string(packet, i)
        out["will_topic"] = topic.decode()
    return out


class Wire:
    """One accepted connection on a local socket, read as raw bytes."""

    def __init__(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.port = self.server.getsockname()[1]
        self.conn = None

    def accept(self):
        self.server.settimeout(5)
        self.conn, _ = self.server.accept()
        self.conn.settimeout(5)

    def _exactly(self, n):
        out = bytearray()
        while len(out) < n:
            chunk = self.conn.recv(n - len(out))
            if not chunk:
                raise ConnectionError("the client closed after %d of %d bytes" % (len(out), n))
            out.extend(chunk)
        return bytes(out)

    def packet(self):
        """One whole MQTT packet: the fixed header, the remaining length, then that many bytes."""
        raw = bytearray(self._exactly(1))
        length, shift = 0, 0
        while True:
            byte = self._exactly(1)[0]
            raw.append(byte)
            length |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        return bytes(raw) + self._exactly(length)

    def close(self):
        for s in (self.conn, self.server):
            if s is not None:
                s.close()


class ConnectOnTheWireTest(unittest.TestCase):
    """The CONNECT main() sends: build_mqtt_client(), the will, and HOST_SESSION."""

    def setUp(self):
        self.wire = Wire()
        self.addCleanup(self.wire.close)
        client = ingestion.build_mqtt_client()
        primary_host.register_will(client, host_id=HOST_ID, now_ms=1_700_000_000_000)
        client.connect("127.0.0.1", self.wire.port, 60, **ingestion.HOST_SESSION)
        self.wire.accept()
        self.connect = parse_connect(self.wire.packet())

    def test_it_is_a_clean_session_with_no_expiry(self):
        self.assertTrue(self.connect["clean_start"])
        self.assertNotIn(PROP_SESSION_EXPIRY, self.connect["properties"])

    def test_the_client_id_is_left_to_the_broker(self):
        self.assertEqual(self.connect["client_id"], "")

    def test_the_death_certificate_is_a_retained_qos1_will_with_no_delay(self):
        self.assertTrue(self.connect["will"])
        self.assertEqual(self.connect["will_topic"], STATE_TOPIC)
        self.assertEqual(self.connect["will_qos"], 1)
        self.assertTrue(self.connect["will_retain"])
        self.assertNotIn(PROP_WILL_DELAY, self.connect["will_properties"])


class SubscriptionTest(unittest.TestCase):
    def test_the_subscription_is_qos1(self):
        client = mock.MagicMock()
        with mock.patch.object(ingestion, "_primary_host_timestamp_ms", None):
            ingestion.on_connect(client, None, {"session present": 0}, 0)
        client.subscribe.assert_called_once_with("spBv1.0/#", qos=1)


class ShutdownTest(unittest.TestCase):
    def run_shutdown(self, client, events):
        writer = mock.MagicMock()
        writer.stop.side_effect = lambda *_: events.append(("drain",)) or True
        writer.depth.return_value = 0
        # announce_offline's host id is a default bound at import, empty in a test environment.
        with mock.patch.object(ingestion, "_primary_host_timestamp_ms", 1), \
                mock.patch.object(primary_host.announce_offline, "__defaults__", (HOST_ID, None)), \
                mock.patch.object(ingestion, "_writer", writer), \
                mock.patch.object(ingestion, "TELEMETRY_SHUTDOWN_RECEIVE_SECONDS", 2.0), \
                mock.patch.object(ingestion, "TELEMETRY_SHUTDOWN_QUIET_SECONDS", 0.2), \
                mock.patch.object(ingestion.logging, "shutdown"), \
                mock.patch.object(ingestion.os, "_exit", side_effect=SystemExit), \
                self.assertRaises(SystemExit):
            ingestion._drain_and_exit(client, 15)

    def test_the_death_certificate_goes_first_then_receiving_stops_then_the_drain_with_no_disconnect(self):
        events = []
        client = mock.MagicMock()
        client.publish.side_effect = lambda *a, **k: events.append(("publish", a[0])) or mock.MagicMock()
        client.loop_stop.side_effect = lambda: events.append(("loop_stop",))
        with mock.patch.object(ingestion, "_last_message_at", 0.0):
            self.run_shutdown(client, events)
        self.assertEqual(events, [("publish", STATE_TOPIC), ("loop_stop",), ("drain",)])
        client.disconnect.assert_not_called()

    def test_messages_still_arriving_after_the_death_certificate_are_received(self):
        """The loop keeps running until the stream has been quiet for the quiet window."""
        events = []
        client = mock.MagicMock()
        client.publish.side_effect = lambda *a, **k: events.append(("publish", a[0])) or mock.MagicMock()
        stopped_at = []
        client.loop_stop.side_effect = lambda: stopped_at.append(time.monotonic())

        def arriving():
            # Edge nodes' last messages, still landing for 0.5 s after the death certificate.
            end = time.monotonic() + 0.5
            while time.monotonic() < end:
                ingestion._last_message_at = time.monotonic()
                time.sleep(0.02)

        started = time.monotonic()
        feeder = threading.Thread(target=arriving)
        feeder.start()
        try:
            self.run_shutdown(client, events)
        finally:
            feeder.join()
        self.assertGreaterEqual(stopped_at[0] - started, 0.5)
        self.assertLess(stopped_at[0] - started, 2.0)

    def test_receiving_is_bounded_for_a_publisher_that_never_stops(self):
        with mock.patch.object(ingestion.time, "monotonic", side_effect=[100.0, 100.0, 101.0, 106.0]), \
                mock.patch.object(ingestion, "_last_message_at", 1e9), \
                mock.patch.object(ingestion.time, "sleep"):
            self.assertFalse(ingestion._receive_until_quiet(max_seconds=5, quiet_seconds=0.5))

    def test_a_signal_only_asks_for_the_shutdown(self):
        with mock.patch.object(ingestion, "_shutdown_requested", threading.Event()) as requested:
            ingestion._request_shutdown(15, None)
            self.assertTrue(requested.is_set())
            self.assertEqual(ingestion._shutdown_signum, 15)


if __name__ == "__main__":
    unittest.main()
