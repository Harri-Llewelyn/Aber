"""
The load generator's Sparkplug payloads, built with the real protobuf module and read back.

test_load_generator.py stubs the protobuf module, so it cannot see what reaches the wire. These are
the Sparkplug 3.0.0 rules the generator must keep to stand in for a conformant edge node:

  * NBIRTH carries bdSeq as an Int64 equal to the CONNECT's (tck-id-message-flow-edge-node-birth-
    publish-nbirth-payload-bdSeq) and `Node Control/Rebirth` = false (tck-id-topics-nbirth-rebirth-metric).
  * NDEATH carries bdSeq and NO seq (tck-id-payloads-ndeath-seq, tck-id-payloads-ndeath-bdseq).
  * Every metric in a birth or a data message carries a timestamp (tck-id-payloads-metric-timestamp-
    in-dataset... the payloads chapter: "timestamp MUST be included with every metric").
  * A replayed DDATA flags every metric is_historical; a live one flags none.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "ingestion"))

import sparkplug_b_pb2  # noqa: E402
import load_generator  # noqa: E402

STAMP = 1_791_500_000_000


def read(raw):
    payload = sparkplug_b_pb2.Payload()
    payload.ParseFromString(raw)
    return payload


class NodeCertificateTest(unittest.TestCase):
    def test_the_nbirth_carries_the_connect_s_bdseq_and_node_control_rebirth(self):
        birth = read(load_generator.node_birth(STAMP, 0, 7))
        metrics = {m.name: m for m in birth.metrics}
        self.assertEqual((metrics["bdSeq"].datatype, metrics["bdSeq"].long_value), (4, 7))
        self.assertEqual((metrics["Node Control/Rebirth"].datatype,
                          metrics["Node Control/Rebirth"].boolean_value), (11, False))
        self.assertEqual(birth.seq, 0)

    def test_the_ndeath_carries_bdseq_and_no_seq(self):
        death = read(load_generator.node_death(7, STAMP))
        self.assertFalse(death.HasField("seq"))
        self.assertEqual([(m.name, m.datatype, m.long_value) for m in death.metrics], [("bdSeq", 4, 7)])


class TimestampTest(unittest.TestCase):
    def test_every_metric_in_a_birth_or_data_message_has_a_timestamp(self):
        for raw in (
            load_generator.node_birth(STAMP, 0, 0),
            load_generator.device_birth("dev" + "1" * 21, "Press 1", ["A", "B"], STAMP, 1),
            load_generator.device_data(["A", "B"], STAMP, [1.0, 2.0], 2),
        ):
            with self.subTest(raw=raw[:12]):
                self.assertTrue(all(m.HasField("timestamp") for m in read(raw).metrics))


class HistoricalTest(unittest.TestCase):
    def test_a_replay_flags_every_metric_and_live_data_none(self):
        replay = read(load_generator.device_data(["A", "B"], STAMP, [1.0, 2.0], 5, historical=True))
        live = read(load_generator.device_data(["A", "B"], STAMP, [1.0, 2.0], 6))
        self.assertTrue(all(m.is_historical for m in replay.metrics))
        self.assertFalse(any(m.HasField("is_historical") for m in live.metrics))
        self.assertEqual([m.double_value for m in replay.metrics], [1.0, 2.0])


if __name__ == "__main__":
    unittest.main()
