"""
The historian writer: the queue between the paho callback thread and TimescaleDB, and the thread
that drains it.

WHAT MOVED THE CEILING. process_ddata() used to write each message in its own transaction on the
callback thread, so every message paid the fixed cost of a commit and every other device waited
behind it. Now the callback thread decides and hands the rows to the writer, which writes
whatever has accumulated as ONE transaction. The contract this suite pins is that batching
changes the number of transactions and nothing else: row order, the per-asset upsert, the
counters, and what happens to the other messages when one of them is bad.

The writer is driven directly with PendingWrite items and drained with flush(), so every
assertion is synchronous. The thread is started once, to prove stop() drains it.

Same stubbing approach as the sibling suites: the daemon's heavy imports are replaced before
ingestion.py is loaded.
"""
import os
import sys
import types
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)


def _stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)
    if "." in name:
        parent, _, leaf = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], leaf, sys.modules[name])
    return module


_stub("psycopg2", connect=lambda *a, **k: None)
_stub("psycopg2.extras", execute_values=lambda *a, **k: None)
_stub("sparkplug_b_pb2", Payload=object)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object)

import ingestion  # noqa: E402
import registry  # noqa: E402
import metrics  # noqa: E402

NOW = datetime.now(timezone.utc)


def pending(wire_id, metrics, asset_name="Sim_CNC_Mill_01"):
    """One decided DDATA: `metrics` is a list of (name, double) pairs."""
    rows = [(NOW, wire_id, name, value, None, None) for name, value in metrics]
    return ingestion.PendingWrite(
        wire_id=wire_id,
        device={"id": "20000000-0000-4000-8000-0000000000%s" % wire_id[-2:],
                "name": asset_name, "sparkplug_id": wire_id},
        asset_id=wire_id,
        asset_name=asset_name,
        rows=rows,
        observed=[(name, "double", value) for name, value in metrics],
        dropped=[],
        modelled=None,
        payload_dt=NOW,
        group_id="ACS-Cymru",
        client=MagicMock(),
    )


DEV_A = "dev" + "a" * 19 + "01"
DEV_B = "dev" + "b" * 19 + "02"
DEV_C = "dev" + "c" * 19 + "03"


class WriterTestCase(unittest.TestCase):

    def setUp(self):
        registry.reset()
        self._real = {
            "get_timescaledb_connection": ingestion.get_timescaledb_connection,
            "execute_values": ingestion.execute_values,
            "record_payload_violations": ingestion.record_payload_violations,
            "TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS": ingestion.TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS,
        }
        self._real_publish = ingestion.uns_publish.publish_ddata

        self.cursor = MagicMock()
        self.cursor.__enter__ = MagicMock(return_value=self.cursor)
        self.cursor.__exit__ = MagicMock(return_value=False)
        self.conn = MagicMock()
        self.conn.__enter__ = MagicMock(return_value=self.conn)
        self.conn.__exit__ = MagicMock(return_value=False)
        self.conn.cursor = MagicMock(return_value=self.cursor)
        ingestion.get_timescaledb_connection = lambda: self.conn

        self.execute_values = MagicMock()
        ingestion.execute_values = self.execute_values
        self.record_violations = MagicMock()
        ingestion.record_payload_violations = self.record_violations
        self.publish = MagicMock(return_value=0)
        ingestion.uns_publish.publish_ddata = self.publish

        self.writer = ingestion.TelemetryWriter(maxsize=8, max_batch=4)

    def tearDown(self):
        for name, value in self._real.items():
            setattr(ingestion, name, value)
        ingestion.uns_publish.publish_ddata = self._real_publish

    def transactions(self):
        return self.conn.__enter__.call_count

    def telemetry_calls(self):
        return [c for c in self.execute_values.call_args_list if "INSERT INTO telemetry" in c[0][1]]

    def asset_calls(self):
        return [c for c in self.execute_values.call_args_list if "INSERT INTO assets" in c[0][1]]

    def written(self):
        """(asset_id, metric_name) of every row handed to the historian, in order."""
        return [(r[1], r[2]) for c in self.telemetry_calls() for r in c[0][2]]


class TestCoalescing(WriterTestCase):

    def test_several_queued_messages_are_one_transaction(self):
        """The headline: three messages, one commit, one telemetry statement."""
        for item in (pending(DEV_A, [("T", 1.0)]),
                     pending(DEV_B, [("T", 2.0)]),
                     pending(DEV_C, [("T", 3.0)])):
            self.writer.submit(item)
        self.writer.flush()

        self.assertEqual(self.transactions(), 1)
        self.assertEqual(len(self.telemetry_calls()), 1)
        self.assertEqual(self.written(), [(DEV_A, "T"), (DEV_B, "T"), (DEV_C, "T")])

    def test_a_lone_message_is_its_own_transaction(self):
        """Nothing waits for company: under light traffic the latency is one commit, as before."""
        self.writer.submit(pending(DEV_A, [("T", 1.0)]))
        self.writer.flush()
        self.assertEqual(self.transactions(), 1)
        self.assertEqual(self.written(), [(DEV_A, "T")])

    def test_row_order_follows_submission_order_across_messages(self):
        self.writer.submit(pending(DEV_A, [("X", 1.0), ("Y", 2.0)]))
        self.writer.submit(pending(DEV_B, [("Z", 3.0)]))
        self.writer.flush()
        self.assertEqual(self.written(), [(DEV_A, "X"), (DEV_A, "Y"), (DEV_B, "Z")])

    def test_max_batch_bounds_a_transaction(self):
        for i in range(6):
            self.writer.submit(pending(DEV_A, [("M%d" % i, float(i))]))
        self.writer.flush()
        self.assertEqual(self.transactions(), 2)
        sizes = [len(c[0][2]) for c in self.telemetry_calls()]
        self.assertEqual(sizes, [4, 2])

    def test_one_histogram_observation_per_transaction(self):
        """rate(_sum) is the writer's occupancy only if a batch is observed once, not per message."""
        before = registry.histogram_snapshot()["acs_ingestion_write_seconds"]["count"]
        for i in range(3):
            self.writer.submit(pending(DEV_A, [("M%d" % i, float(i))]))
        self.writer.flush()
        after = registry.histogram_snapshot()["acs_ingestion_write_seconds"]["count"]
        self.assertEqual(after - before, 1)

    def test_messages_and_metrics_are_counted_after_the_commit(self):
        self.writer.submit(pending(DEV_A, [("X", 1.0), ("Y", 2.0)]))
        self.writer.submit(pending(DEV_B, [("Z", 3.0)]))
        self.writer.flush()
        snapshot = registry.counter_snapshot()
        self.assertEqual(snapshot.get("written_messages"), 2)
        self.assertEqual(snapshot.get("metrics_written"), 3)

    def test_a_message_with_no_rows_still_upserts_its_asset_and_counts(self):
        self.writer.submit(pending(DEV_A, []))
        self.writer.flush()
        self.assertEqual(len(self.asset_calls()), 1)
        self.assertEqual(self.telemetry_calls(), [])
        self.assertEqual(registry.counter_snapshot().get("written_messages"), 1)


class TestAssetUpsert(WriterTestCase):

    def test_the_upsert_carries_each_asset_once_with_its_latest_name(self):
        """
        `ON CONFLICT DO UPDATE` cannot touch one row twice in a statement -- PostgreSQL raises --
        so two messages from one asset must collapse to one tuple, and the later name must win.
        """
        self.writer.submit(pending(DEV_A, [("T", 1.0)], asset_name="Old name"))
        self.writer.submit(pending(DEV_B, [("T", 2.0)]))
        self.writer.submit(pending(DEV_A, [("T", 3.0)], asset_name="New name"))
        self.writer.flush()

        self.assertEqual(len(self.asset_calls()), 1)
        self.assertEqual(self.asset_calls()[0][0][2],
                         [(DEV_A, "New name"), (DEV_B, "Sim_CNC_Mill_01")])

    def test_the_upsert_precedes_the_telemetry_statement(self):
        """The foreign key: telemetry references assets, so the asset row lands first."""
        self.writer.submit(pending(DEV_A, [("T", 1.0)]))
        self.writer.flush()
        statements = [c[0][1] for c in self.execute_values.call_args_list]
        self.assertIn("INSERT INTO assets", statements[0])
        self.assertIn("INSERT INTO telemetry", statements[1])


class TestFailure(WriterTestCase):

    def poison(self, metric_name):
        """execute_values that refuses any telemetry batch carrying `metric_name`."""
        def raise_on_poison(cur, sql, rows, **kwargs):
            if "INSERT INTO telemetry" in sql and any(r[2] == metric_name for r in rows):
                raise RuntimeError("bad row")
        self.execute_values.side_effect = raise_on_poison

    def test_a_poisoned_batch_loses_only_the_poison(self):
        """
        Batching must not widen the blast radius: one bad message used to lose one message, and
        still does. The batch is retried one message at a time.
        """
        self.poison("POISON")
        self.writer.submit(pending(DEV_A, [("T", 1.0)]))
        self.writer.submit(pending(DEV_B, [("POISON", 2.0)]))
        self.writer.submit(pending(DEV_C, [("T", 3.0)]))
        self.writer.flush()

        snapshot = registry.counter_snapshot()
        self.assertEqual(snapshot.get("write_batch_failures"), 1)
        self.assertEqual(snapshot.get("write_failures"), 1)
        self.assertEqual(snapshot.get("written_messages"), 2)
        self.assertEqual(snapshot.get("metrics_written"), 2)
        # The batch, then one transaction per message on the retry.
        self.assertEqual(self.transactions(), 4)

    def test_post_commit_work_is_skipped_for_the_message_that_failed(self):
        self.poison("POISON")
        self.writer.submit(pending(DEV_A, [("T", 1.0)]))
        self.writer.submit(pending(DEV_B, [("POISON", 2.0)]))
        self.writer.flush()
        published_for = [c[0][2]["sparkplug_id"] for c in self.publish.call_args_list]
        self.assertEqual(published_for, [DEV_A])

    def test_a_lone_failing_message_is_counted_and_does_not_raise(self):
        self.poison("POISON")
        self.writer.submit(pending(DEV_A, [("POISON", 1.0)]))
        self.writer.flush()
        snapshot = registry.counter_snapshot()
        self.assertEqual(snapshot.get("write_failures"), 1)
        # Declared, and still zero. Every counter COUNTER_MAP names is present from startup, so
        # this asserts the value rather than the key's absence -- which would also have passed on
        # a misspelling.
        self.assertEqual(0, snapshot["write_batch_failures"])
        self.assertEqual(0, snapshot["metrics_written"])

    def test_an_unavailable_database_drops_every_queued_message(self):
        ingestion.get_timescaledb_connection = lambda: None
        for wire_id in (DEV_A, DEV_B, DEV_C):
            self.writer.submit(pending(wire_id, [("T", 1.0)]))
        self.writer.flush()
        self.assertEqual(registry.counter_snapshot().get("dropped_db_unavailable"), 3)
        self.assertEqual(self.execute_values.call_args_list, [])


class TestQueue(WriterTestCase):

    def test_depth_reports_what_is_waiting(self):
        self.writer.submit(pending(DEV_A, [("T", 1.0)]))
        self.writer.submit(pending(DEV_B, [("T", 2.0)]))
        self.assertEqual(self.writer.depth(), 2)
        self.writer.flush()
        self.assertEqual(self.writer.depth(), 0)

    def test_a_full_queue_drops_with_its_own_reason(self):
        """
        The put blocks for the timeout first -- that is backpressure onto the broker -- and only
        then drops, so a writer that is merely slow costs latency and a writer that is stuck
        costs a counted, named drop rather than a hung daemon.
        """
        ingestion.TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS = 0.01
        writer = ingestion.TelemetryWriter(maxsize=1, max_batch=4)
        self.assertTrue(writer.submit(pending(DEV_A, [("T", 1.0)])))
        self.assertFalse(writer.submit(pending(DEV_B, [("T", 2.0)])))
        self.assertEqual(registry.counter_snapshot().get("dropped_write_queue_full"), 1)
        self.assertEqual(writer.depth(), 1)

    def test_flush_with_nothing_queued_writes_nothing(self):
        self.writer.flush()
        self.assertEqual(self.transactions(), 0)


class TestPostCommit(WriterTestCase):

    def test_the_uns_bridge_and_the_conformance_record_run_per_message(self):
        self.writer.submit(pending(DEV_A, [("T", 1.0)]))
        self.writer.submit(pending(DEV_B, [("T", 2.0)]))
        self.writer.flush()
        self.assertEqual(self.publish.call_count, 2)
        self.assertEqual(self.record_violations.call_count, 2)

    def test_each_message_publishes_its_own_rows(self):
        a = pending(DEV_A, [("X", 1.0), ("Y", 2.0)])
        b = pending(DEV_B, [("Z", 3.0)])
        self.writer.submit(a)
        self.writer.submit(b)
        self.writer.flush()
        published = [c[0][4] for c in self.publish.call_args_list]
        self.assertEqual(published, [a.rows, b.rows])


class TestThread(WriterTestCase):

    def test_stop_drains_what_was_queued(self):
        """A restart under load must not lose what the daemon already accepted."""
        self.writer.start()
        for wire_id in (DEV_A, DEV_B, DEV_C):
            self.writer.submit(pending(wire_id, [("T", 1.0)]))
        self.assertTrue(self.writer.stop(timeout=5))
        self.assertEqual(sorted(a for a, _ in self.written()), sorted([DEV_A, DEV_B, DEV_C]))
        self.assertEqual(self.writer.depth(), 0)

    def test_the_writer_thread_survives_a_failing_batch(self):
        def explode(cur, sql, rows, **kwargs):
            if "INSERT INTO telemetry" in sql and any(r[2] == "POISON" for r in rows):
                raise RuntimeError("bad row")
        self.execute_values.side_effect = explode
        self.writer.start()
        self.writer.submit(pending(DEV_A, [("POISON", 1.0)]))
        self.writer.submit(pending(DEV_B, [("T", 2.0)]))
        self.assertTrue(self.writer.stop(timeout=5))
        self.assertIn((DEV_B, "T"), self.written())


class TestShutdownDefaults(unittest.TestCase):

    def test_the_drain_fits_inside_the_shortest_grace_period(self):
        """The shortest grace period a runtime gives is 10s; the drain must give up before that."""
        self.assertLess(ingestion.TELEMETRY_SHUTDOWN_DRAIN_SECONDS, 10)

    def test_the_daemon_holds_one_writer(self):
        self.assertIsInstance(ingestion._writer, ingestion.TelemetryWriter)


class TestExposition(unittest.TestCase):
    """
    `count()` reads every `messages_<x>` flat name as a message TYPE and never consults the table
    for it, so a writer counter spelled that way would surface as
    acs_ingestion_messages_total{msg_type="written"}. It did, on the live endpoint, before this
    test existed.
    """

    def setUp(self):
        registry.reset()

    def test_the_commit_counter_is_exported_under_its_own_name(self):
        registry.count("written_messages", 2)
        out = registry.render()
        self.assertIn("acs_ingestion_messages_written_total 2.0", out)
        self.assertNotIn('msg_type="written"', out)

    def test_no_mapped_counter_is_shadowed_by_the_message_type_convention(self):
        shadowed = [name for name in metrics.COUNTER_MAP if name.startswith("messages_")]
        self.assertEqual(shadowed, [], "these names never reach COUNTER_MAP in registry.count()")

    def test_the_writer_counters_are_mapped(self):
        for name in ("written_messages", "write_batch_failures", "dropped_write_queue_full"):
            self.assertIn(name, metrics.COUNTER_MAP)
        self.assertEqual(metrics.TYPES.get("acs_ingestion_write_queue_depth"), "gauge")


if __name__ == "__main__":
    unittest.main(verbosity=2)
