# suite:
#   lanes: unit
#   why: aber_ingestion_messages_total counts messages for each edge node and type. A message is
#     counted under the edge node its topic names, the labelled series sum back to the flat total
#     the STATS line reports, a node's two loss series exist at zero from its first message so its
#     first gap shows as an increase, and a topic with no edge node level counts under "". Runs
#     the real on_message with its dispatch stubbed.

"""
The edge_node label on aber_ingestion_messages_total.

    python ingestion/test_messages_by_edge_node.py

What is held here. on_message counts a message under the edge node its topic names and the type it
is, a host's STATE message is not counted at all (its topic has no edge node level and is refused
before the count), and a command topic is not counted. The series sum back to the flat
`messages_total` that the STATS line reads, so the label adds no second way to count. An edge node's
two loss series exist at zero once its first message is counted. The exposition carries the label
and the HELP says to sum it.

NO STACK AND NO BROKER. ingestion.py is imported with its I/O dependencies stubbed, as
test_metrics_endpoint.py does, and the dispatch after the count is replaced by no-ops.
"""
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics  # noqa: E402
import registry  # noqa: E402


def _load_ingestion():
    """ingestion.py with psycopg2, paho and the generated protobuf stubbed."""
    for name in ("psycopg2", "psycopg2.extras", "paho", "paho.mqtt", "paho.mqtt.client"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["psycopg2"].extras = sys.modules["psycopg2.extras"]
    sys.modules["psycopg2.extras"].execute_values = lambda *a, **k: None
    sys.modules["psycopg2"].connect = lambda *a, **k: None
    sys.modules["paho.mqtt.client"].Client = object
    if "sparkplug_b_pb2" not in sys.modules:
        sys.modules["sparkplug_b_pb2"] = types.ModuleType("sparkplug_b_pb2")
    os.environ.setdefault("SUPABASE_URL", "http://localhost")
    os.environ.setdefault("SUPABASE_PUBLISHABLE_KEY", "test")
    os.environ.setdefault("SUPABASE_INGESTION_KEY", "test")
    import ingestion
    return ingestion


class _Message:
    def __init__(self, topic, payload=b"x"):
        self.topic = topic
        self.payload = payload


def _series(metric="aber_ingestion_messages_total"):
    """{(edge_node, msg_type): value} for one counter family, read from the exposition."""
    out = {}
    for line in registry.render().splitlines():
        if not line.startswith(metric + "{"):
            continue
        head, value = line.rsplit(" ", 1)
        labels = dict(part.split("=", 1) for part in head[len(metric) + 1:-1].split(","))
        out[(labels["edge_node"].strip('"'), labels.get("msg_type", "").strip('"'))] = float(value)
    return out


class OnMessageCounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ing = _load_ingestion()

    def setUp(self):
        registry.reset()
        self.patches = [
            mock.patch.object(self.ing, "parse_sparkplug_payload", lambda msg: object()),
            mock.patch.object(self.ing, "check_message_sequence", lambda *a, **k: True),
            mock.patch.object(self.ing, "process_node_message", lambda *a, **k: None),
            mock.patch.object(self.ing, "process_dbirth", lambda *a, **k: None),
            mock.patch.object(self.ing, "process_ddata", lambda *a, **k: None),
            mock.patch.object(self.ing, "process_ddeath", lambda *a, **k: None),
            mock.patch.object(self.ing, "resolve_wire_identity", lambda parts, payload: ("devA", None)),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def receive(self, topic):
        self.ing.on_message(None, None, _Message(topic))

    def test_a_message_is_counted_under_the_edge_node_its_topic_names(self):
        self.receive("spBv1.0/Plant/NDATA/gwyA")
        self.receive("spBv1.0/Plant/DDATA/gwyA/devA")
        self.receive("spBv1.0/Plant/DDATA/gwyA/devA")
        self.receive("spBv1.0/Plant/DDATA/gwyB/devB")
        self.assertEqual({
            ("gwyA", "ndata"): 1.0, ("gwyA", "ddata"): 2.0, ("gwyB", "ddata"): 1.0,
        }, _series())

    def test_summing_over_the_edge_node_gives_the_stack_s_count_by_type(self):
        for topic in ("spBv1.0/P/DDATA/gwyA/d", "spBv1.0/P/DDATA/gwyB/d", "spBv1.0/P/NBIRTH/gwyA"):
            self.receive(topic)
        snapshot = registry.counter_snapshot()
        self.assertEqual(2, snapshot["messages_ddata"])
        self.assertEqual(1, snapshot["messages_nbirth"])
        self.assertEqual(3, snapshot["messages_total"])
        self.assertEqual(3.0, sum(_series().values()))

    def test_a_command_topic_is_not_counted(self):
        self.receive("spBv1.0/Plant/NCMD/gwyA")
        self.receive("spBv1.0/Plant/DCMD/gwyA/devA")
        self.assertEqual({}, _series())

    def test_a_host_state_message_has_no_edge_node_and_is_not_counted(self):
        """STATE is spBv1.0/STATE/<host id>, three levels: refused before the count."""
        self.receive("spBv1.0/STATE/primary-host")
        self.assertEqual({}, _series())

    def test_a_topic_with_an_empty_edge_node_level_counts_under_the_empty_edge_node(self):
        self.receive("spBv1.0/Plant/NDATA/")
        self.assertEqual({("", "ndata"): 1.0}, _series())
        self.assertNotIn("", registry._started_nodes)

    def test_a_count_with_no_edge_node_is_the_empty_one(self):
        registry.count("messages_ddata", 4)
        registry.count("messages_ddata", 1, edge_node=None)
        registry.count("messages_ddata", 2, edge_node="")
        self.assertEqual({("", "ddata"): 7.0}, _series())


class LossSeriesStartAtZero(unittest.TestCase):
    def setUp(self):
        registry.reset()

    def test_an_edge_node_s_first_message_makes_both_loss_series_at_zero(self):
        self.assertEqual({}, _series("aber_ingestion_sequence_gaps_total"))
        registry.count("messages_ddata", edge_node="gwyA")
        self.assertEqual({("gwyA", ""): 0.0}, _series("aber_ingestion_sequence_gaps_total"))
        self.assertEqual({("gwyA", ""): 0.0}, _series("aber_ingestion_sequence_messages_missed_total"))

    def test_the_first_gap_adds_to_the_series_the_message_made(self):
        registry.count("messages_ddata", edge_node="gwyA")
        registry.count_labelled("aber_ingestion_sequence_gaps_total", {"edge_node": "gwyA"})
        registry.count_labelled("aber_ingestion_sequence_messages_missed_total", {"edge_node": "gwyA"}, 5)
        self.assertEqual(1.0, _series("aber_ingestion_sequence_gaps_total")[("gwyA", "")])
        self.assertEqual(5.0, _series("aber_ingestion_sequence_messages_missed_total")[("gwyA", "")])

    def test_a_second_message_changes_nothing_about_them(self):
        registry.count("messages_ddata", edge_node="gwyA")
        registry.count_labelled("aber_ingestion_sequence_gaps_total", {"edge_node": "gwyA"}, 2)
        registry.count("messages_ndata", edge_node="gwyA")
        self.assertEqual(2.0, _series("aber_ingestion_sequence_gaps_total")[("gwyA", "")])

    def test_each_edge_node_gets_its_own_pair_and_the_empty_one_gets_none(self):
        registry.count("messages_ddata", edge_node="gwyA")
        registry.count("messages_ddata", edge_node="gwyB")
        registry.count("messages_ddata")
        self.assertEqual({"gwyA", "gwyB"}, {node for node, _ in _series("aber_ingestion_sequence_gaps_total")})

    def test_a_reset_forgets_which_nodes_were_started(self):
        registry.count("messages_ddata", edge_node="gwyA")
        registry.reset()
        registry.count("messages_ddata", edge_node="gwyA")
        self.assertEqual({("gwyA", ""): 0.0}, _series("aber_ingestion_sequence_gaps_total"))


class WhatTheLabelSays(unittest.TestCase):
    def test_the_help_names_the_label_and_says_to_sum(self):
        text = metrics.HELP["aber_ingestion_messages_total"]
        self.assertIn("edge node", text)
        self.assertIn("sum()", text)

    def test_the_flat_total_is_still_exported_by_the_labelled_series(self):
        _, why = metrics.EXPORTED_LABELLED_INSTEAD["messages_total"]
        self.assertIn("edge_node=", why)

    def test_the_exposition_has_one_family_with_both_labels(self):
        registry.reset()
        registry.count("messages_ddata", edge_node="gwyA")
        body = registry.render()
        self.assertEqual(1, body.count("# TYPE aber_ingestion_messages_total"))
        self.assertIn('aber_ingestion_messages_total{edge_node="gwyA",msg_type="ddata"} 1.0', body)


if __name__ == "__main__":
    unittest.main()
