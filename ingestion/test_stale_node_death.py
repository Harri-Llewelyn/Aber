"""
Unit tests for an NDEATH from an earlier session of the same edge node, in ingestion.py.

Sparkplug 3.0.0 numbers each MQTT session with bdSeq: the NDEATH registered as the CONNECT's Last
Will carries it, and the NBIRTH that follows repeats it. A Last Will can arrive after the node has
connected again and been born, when it reconnected under a new client id and the broker only noticed
the old connection at its keepalive timeout. What this suite holds:

  * A DEATH WHOSE bdSeq IS NOT THE OPEN SESSION'S CHANGES NOTHING: no status write, no device
    marked OFFLINE, and none of the session's state reset -- aliases, device births, the seq run.
    It is counted by edge node and logged at INFO.
  * A DEATH THAT MATCHES, ONE WITHOUT A bdSeq, AND ONE FOR A NODE WITH NO BIRTH SEEN since the
    daemon started are applied as before: the gateway and its devices go OFFLINE.
  * AN APPLIED DEATH CLOSES THE SESSION, so a later death without a newer birth is applied too.

Uses the real protobuf module, as test_historical_replay.py does, so `HasField` on the value
fields is the shipped behaviour rather than a fake's.
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import capture  # noqa: E402
import ingestion  # noqa: E402
import registry  # noqa: E402
import sparkplug_b_pb2  # noqa: E402

GROUP = "Aber"
NODE = "gwy" + "5" * 21
DEVICE_ID = "d5000000-0000-4000-8000-000000000005"
GATEWAY_ID = "a5000000-0000-4000-8000-000000000005"


def certificate(bdseq=None, field="long_value", aliases=None):
    """An NBIRTH or NDEATH payload carrying `bdseq` in `field` (none when None), and NBIRTH aliases."""
    out = sparkplug_b_pb2.Payload()
    out.timestamp = 1
    if bdseq is not None:
        m = out.metrics.add()
        m.name = "bdSeq"
        m.datatype = 4
        setattr(m, field, bdseq)
    for alias, name in (aliases or {}).items():
        m = out.metrics.add()
        m.name = name
        m.alias = alias
        m.datatype = 10
        m.double_value = 1.0
    return out


def stale_samples():
    return [line for line in registry.render().split("\n")
            if line.startswith("aber_ingestion_stale_deaths_total{")]


class NodeSessionTestCase(unittest.TestCase):
    def setUp(self):
        registry.reset()
        for store in (ingestion._session_bdseq, ingestion._alias_map, ingestion._alias_datatypes,
                      ingestion._name_datatypes, ingestion._last_seq, ingestion._device_seen,
                      ingestion._device_offline, ingestion._node_epoch):
            store.clear()

        self._real_client = ingestion.supabase_client
        self.client = MagicMock()
        self.client.rpc.return_value.execute.return_value = MagicMock(data=[])
        ingestion.supabase_client = self.client

        self.gateway = {"id": GATEWAY_ID, "name": "Session_Gateway", "sparkplug_id": NODE,
                        "sparkplug_group": GROUP, "status": "ONLINE", "is_archived": False}
        self._real_resolve = ingestion.resolve_gateway
        ingestion.resolve_gateway = lambda wire_id, group_id=None, include_archived=False: self.gateway

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion.resolve_gateway = self._real_resolve
        ingestion._session_bdseq.clear()

    def send(self, msg_type, payload, group=GROUP):
        ingestion.process_node_message(NODE, msg_type, payload, group_id=group)

    def calls(self, name):
        return [c.args[1] for c in self.client.rpc.call_args_list if c.args and c.args[0] == name]

    def written_statuses(self):
        return [params["p_status"] for params in self.calls("ingest_record_gateway_health")]

    def assert_applied(self):
        self.assertEqual(self.written_statuses()[-1], "OFFLINE")
        self.assertEqual(len(self.calls("ingest_mark_gateway_devices_offline")), 1)
        self.assertEqual(stale_samples(), [])

    def assert_ignored(self, birth_writes=1):
        self.assertEqual(self.written_statuses(), ["ONLINE"] * birth_writes,
                         "an earlier session's NDEATH wrote the gateway's status")
        self.assertEqual(self.calls("ingest_mark_gateway_devices_offline"), [],
                         "an earlier session's NDEATH marked the gateway's devices OFFLINE")
        self.assertEqual(self.gateway["status"], "ONLINE")


class TestAnEarlierSessionsDeath(NodeSessionTestCase):
    def test_birth_1_then_death_0_is_ignored(self):
        self.send("NBIRTH", certificate(1))
        with self.assertLogs("ingestion", level="INFO") as captured:
            self.send("NDEATH", certificate(0))
        self.assert_ignored()
        line = next(line for line in captured.output if "STALE NDEATH" in line)
        self.assertIn("bdSeq 0", line)
        self.assertIn("born with bdSeq 1", line)
        self.assertTrue(line.startswith("INFO:"), line)

    def test_it_is_counted_by_edge_node(self):
        self.send("NBIRTH", certificate(1))
        self.send("NDEATH", certificate(0))
        self.send("NDEATH", certificate(250))
        self.assertEqual(stale_samples(), ['aber_ingestion_stale_deaths_total{edge_node="%s"} 2.0' % NODE])

    def test_a_death_numerically_ahead_is_still_stale(self):
        """
        An edge node that starts its bdSeq at 0 again after a reboot, under a new client id, makes
        the old session's Last Will the larger number. Only equality says which session it ends.
        """
        self.send("NBIRTH", certificate(0))
        self.send("NDEATH", certificate(5))
        self.assert_ignored()

    def test_the_wrap_from_255_to_0(self):
        self.send("NBIRTH", certificate(0))
        self.send("NDEATH", certificate(255))
        self.assert_ignored()

    def test_the_bdseq_is_read_from_int_value_and_from_json(self):
        self.send("NBIRTH", certificate(1, field="int_value"))
        self.send("NDEATH", capture.json_payload({"metrics": [{"name": "bdSeq", "value": 0}]}))
        self.assert_ignored()

    def test_the_session_survives_it(self):
        """Aliases, device births and the seq run belong to the open session; the old death ends none."""
        self.send("NBIRTH", certificate(1, aliases={7: "Node/Temperature"}))
        ingestion.check_message_sequence(GROUP, NODE, "NBIRTH", sparkplug_b_pb2.Payload(seq=0))
        ingestion.check_message_sequence(GROUP, NODE, "NDATA", sparkplug_b_pb2.Payload(seq=1))
        device = {"id": DEVICE_ID, "name": "Session_Device"}
        ingestion.mark_device_seen(device, GROUP, NODE)
        epoch = dict(ingestion._node_epoch)
        seen = dict(ingestion._device_seen)

        self.send("NDEATH", certificate(0))

        aliased = sparkplug_b_pb2.Payload().metrics.add()
        aliased.alias = 7
        self.assertEqual(ingestion.resolve_metric_name(GROUP, NODE, aliased), "Node/Temperature")
        self.assertEqual(ingestion._node_epoch, epoch, "the old death ended the node's device births")
        self.assertEqual(ingestion._device_seen, seen, "the old death stopped tracking a live device")
        self.assertNotIn(DEVICE_ID, ingestion._device_offline)
        self.assertEqual(ingestion._last_seq[ingestion.alias_key(GROUP, NODE)], 1)
        # The DDATA that follows is the open session's and sets nothing back.
        self.assertTrue(ingestion.accept_device_data(device, GROUP, NODE))
        self.assertEqual(ingestion._session_bdseq[ingestion.alias_key(GROUP, NODE)], 1)


class TestADeathThatIsApplied(NodeSessionTestCase):
    def test_birth_1_then_death_1_marks_it_offline(self):
        self.send("NBIRTH", certificate(1))
        self.send("NDEATH", certificate(1))
        self.assert_applied()

    def test_a_death_without_a_bdseq(self):
        self.send("NBIRTH", certificate(1))
        self.send("NDEATH", certificate())
        self.assert_applied()

    def test_a_node_with_no_birth_seen(self):
        """After a restart nothing is known about the session, so the death is applied as before."""
        self.send("NDEATH", certificate(0))
        self.assert_applied()

    def test_a_birth_without_a_bdseq(self):
        self.send("NBIRTH", certificate())
        self.send("NDEATH", certificate(0))
        self.assert_applied()

    def test_the_session_is_keyed_by_group_and_node(self):
        self.send("NBIRTH", certificate(1), group="Other-Group")
        self.send("NDEATH", certificate(0))
        self.assert_applied()

    def test_an_applied_death_closes_the_session(self):
        """A birth missed after a death must not leave the dead session's number to ignore the next death by."""
        self.send("NBIRTH", certificate(1))
        self.send("NDEATH", certificate(1))
        self.send("NDEATH", certificate(2))
        self.assertEqual(self.written_statuses(), ["ONLINE", "OFFLINE", "OFFLINE"])
        self.assertEqual(stale_samples(), [])
        self.assertNotIn(ingestion.alias_key(GROUP, NODE), ingestion._session_bdseq)

    def test_a_new_birth_opens_the_next_session(self):
        self.send("NBIRTH", certificate(1))
        self.send("NDEATH", certificate(1))
        self.send("NBIRTH", certificate(2))
        self.send("NDEATH", certificate(1))
        self.assertEqual(self.written_statuses(), ["ONLINE", "OFFLINE", "ONLINE"])
        self.assertEqual(len(stale_samples()), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
