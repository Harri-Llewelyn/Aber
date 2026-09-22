"""
Unit tests for the Sparkplug primary-host STATE certificates (`ingestion/primary_host.py`).

NO BROKER: a fake MQTT client records the will it was given and every publish. What is guarded:

  * THE BIRTH AND DEATH TIMESTAMPS MATCH. Sparkplug 3.0.0 requires both certificates of one
    connection to carry the time that connection was established, so a subscriber can pair them.
    That is the whole reason register_will() returns a value instead of each half reading a clock.
  * THE WILL IS REGISTERED, RETAINED, AT QoS 1 -- the one place this daemon departs from QoS 0,
    because a gateway connecting later must learn the current state without waiting for a
    transition it already missed.
  * AN UNSET OR UNUSABLE HOST ID IS REFUSED, not defaulted and not published somewhere narrower
    than intended: the broker grants write on one literal topic, so a `/`, `+` or `#` in the id
    publishes where nothing is granted.
  * A CLEAN SHUTDOWN PUBLISHES THE DEATH CERTIFICATE ITSELF, because a client that sends
    DISCONNECT has its will discarded by the broker -- the retained message would otherwise say
    `online: true` for as long as the daemon stayed down.
  * announce_offline() NEVER RAISES. It runs on the signal path, where the accepted telemetry is
    the thing worth protecting.
"""
import json
import os
import sys
import unittest

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import primary_host  # noqa: E402

HOST_ID = "Aber"
TOPIC = "spBv1.0/STATE/Aber"


class FakePublishInfo:
    def __init__(self):
        self.waited = False

    def wait_for_publish(self, timeout=None):  # noqa: ARG002
        self.waited = True


class FakeClient:
    """Records what a real paho client would have sent."""

    def __init__(self, publish_raises=None):
        self.will = None
        self.published = []
        self._publish_raises = publish_raises

    def will_set(self, topic, payload=None, qos=0, retain=False):
        self.will = {"topic": topic, "payload": payload, "qos": qos, "retain": retain}

    def publish(self, topic, payload=None, qos=0, retain=False):
        if self._publish_raises is not None:
            raise self._publish_raises
        self.published.append({"topic": topic, "payload": payload, "qos": qos, "retain": retain})
        return FakePublishInfo()


class PrimaryHostStateTests(unittest.TestCase):
    def test_will_is_the_death_certificate_retained_at_qos_1(self):
        client = FakeClient()
        ts = primary_host.register_will(client, host_id=HOST_ID, now_ms=1_700_000_000_000)

        self.assertEqual(ts, 1_700_000_000_000)
        self.assertEqual(client.will["topic"], TOPIC)
        self.assertEqual(client.will["qos"], 1)
        self.assertTrue(client.will["retain"])
        self.assertEqual(
            json.loads(client.will["payload"]),
            {"online": False, "timestamp": 1_700_000_000_000},
        )

    def test_birth_carries_the_will_timestamp(self):
        """The pairing rule: one connection, one timestamp, in both certificates."""
        client = FakeClient()
        ts = primary_host.register_will(client, host_id=HOST_ID, now_ms=1_700_000_000_000)
        primary_host.announce_online(client, ts, host_id=HOST_ID)

        self.assertEqual(len(client.published), 1)
        birth = client.published[0]
        self.assertEqual(birth["topic"], TOPIC)
        self.assertEqual(birth["qos"], 1)
        self.assertTrue(birth["retain"])
        self.assertEqual(json.loads(birth["payload"]), {"online": True, "timestamp": ts})
        self.assertEqual(
            json.loads(client.will["payload"])["timestamp"],
            json.loads(birth["payload"])["timestamp"],
        )

    def test_clean_shutdown_publishes_the_death_certificate(self):
        client = FakeClient()
        ts = primary_host.register_will(client, host_id=HOST_ID, now_ms=1_700_000_000_000)
        primary_host.announce_online(client, ts, host_id=HOST_ID)
        primary_host.announce_offline(client, ts, host_id=HOST_ID)

        death = client.published[-1]
        self.assertEqual(death["topic"], TOPIC)
        self.assertTrue(death["retain"])
        self.assertEqual(death["qos"], 1)
        self.assertEqual(json.loads(death["payload"]), {"online": False, "timestamp": ts})

    def test_offline_never_raises(self):
        """On the signal path a broker that has already gone must not stop the drain."""
        client = FakeClient(publish_raises=OSError("broker gone"))
        primary_host.announce_offline(client, 1_700_000_000_000, host_id=HOST_ID)

    def test_unset_host_id_is_refused(self):
        with self.assertRaises(primary_host.PrimaryHostIdError) as caught:
            primary_host.state_topic("")
        self.assertIn("PRIMARY_HOST_ID", str(caught.exception))

    def test_a_host_id_that_is_not_one_topic_level_is_refused(self):
        for bad in ("site/one", "site+", "site#", "a/b/c"):
            with self.subTest(host_id=bad):
                with self.assertRaises(primary_host.PrimaryHostIdError):
                    primary_host.state_topic(bad)

    def test_a_bad_host_id_registers_no_will(self):
        """Refused BEFORE the client is touched, so a daemon never connects half-configured."""
        client = FakeClient()
        with self.assertRaises(primary_host.PrimaryHostIdError):
            primary_host.register_will(client, host_id="site/one")
        self.assertIsNone(client.will)

    def test_topic_is_the_subtree_the_gateway_role_grants_read_on(self):
        """`spBv1.0/STATE/#` is what mosquitto/dynsec-roles.json gives every gateway."""
        self.assertTrue(primary_host.state_topic("anything").startswith("spBv1.0/STATE/"))
        self.assertEqual(primary_host.state_topic("anything").count("/"), 2)

    def test_payload_is_the_3_0_0_json_shape(self):
        """Two keys, a JSON boolean and a JSON number of UTC milliseconds. No protobuf."""
        payload = json.loads(primary_host.state_payload(True, 1_700_000_000_000))
        self.assertEqual(set(payload), {"online", "timestamp"})
        self.assertIsInstance(payload["online"], bool)
        self.assertIsInstance(payload["timestamp"], int)


if __name__ == "__main__":
    unittest.main()
