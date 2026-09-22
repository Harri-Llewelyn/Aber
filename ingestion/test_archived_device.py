"""
Unit tests for refusing traffic for an ARCHIVED device (`resolve_device` in ingestion.py).

WHY A DEVICE NEEDS ITS OWN REFUSAL, WHEN THE GATEWAY ALREADY HAS ONE. Archiving a gateway rotates
its broker credential, so the appliance eventually cannot connect at all and
test_archived_gateway.py covers the window before that lands. A device has no broker account: its
gateway holds the only credential in play and goes on publishing for the machines still in
service. Nothing between the broker and the historian knew that one of the devices behind it had
been retired, so its readings kept being written -- keyed by `sparkplug_id` in a database that
holds no `devices` table and cannot say the asset was decommissioned.

THE DBIRTH PATH IS THE ONE A NAIVE FIX GETS WRONG. `resolve_device()` answering None means
"unregistered", and process_dbirth() turns that into a quarantined INSERT. Refusing an archived
device by returning None would therefore mint a SECOND row for a machine this stack already holds
archived -- destroying the identity that archiving rather than deleting exists to keep. The three
message paths pass `include_archived=True` and describe the refusal themselves.

Same stubbing approach as test_archived_gateway.py: the daemon's heavy imports are replaced before
ingestion.py is loaded, so this stays pure logic.
"""
import os
import sys
import types
import unittest
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

import ingestion  # noqa: E402  (must follow the stubs above)

GROUP = "Aber"
NODE = "gwy130000000000400080000"
DEVICE = "dev230000000000400080000"


def _row(**overrides):
    row = {
        "id": "23000000-0000-4000-8000-000000000001",
        "name": "Retired Mill",
        "sparkplug_id": DEVICE,
        "gateway_id": "13000000-0000-4000-8000-000000000001",
        "is_quarantined": False,
        "status": "ONLINE",
        "is_archived": False,
    }
    row.update(overrides)
    return row


class _ServesOneDevice(unittest.TestCase):
    """Shared fixture: a directory whose device lookup returns exactly one row, or none."""

    def setUp(self):
        ingestion._device_cache.clear()
        ingestion._archived_device_warned.clear()
        self._real_client = ingestion.supabase_client

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion._device_cache.clear()
        ingestion._archived_device_warned.clear()

    def _serve(self, row):
        table = MagicMock()
        chain = table.select.return_value
        chain.eq.return_value = chain
        chain.execute.return_value = types.SimpleNamespace(data=[row] if row else [])
        client = MagicMock()
        client.table.return_value = table
        ingestion.supabase_client = client
        return client


class ArchivedDeviceTests(_ServesOneDevice):
    def test_a_live_device_resolves(self):
        self._serve(_row())
        got = ingestion.resolve_device(DEVICE)
        self.assertIsNotNone(got)
        self.assertEqual(got["sparkplug_id"], DEVICE)

    def test_an_archived_device_is_refused(self):
        self._serve(_row(is_archived=True))
        self.assertIsNone(ingestion.resolve_device(DEVICE))

    def test_the_refusal_is_counted_under_its_own_reason(self):
        before = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        self._serve(_row(is_archived=True))
        ingestion.resolve_device(DEVICE)
        after = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        self.assertEqual(after, before + 1)

    def test_the_log_names_archival_rather_than_registration(self):
        # "Unregistered" sends an operator to provision a device that is already provisioned. The
        # fix here is Restore, and the line has to say so.
        self._serve(_row(is_archived=True))
        with self.assertLogs("ingestion", level="WARNING") as captured:
            ingestion.resolve_device(DEVICE)
        joined = "\n".join(captured.output)
        self.assertIn("ARCHIVED", joined)
        self.assertIn("Retired Mill", joined)
        self.assertNotIn("unregistered", joined.lower())

    def test_the_warning_is_throttled(self):
        # A retired machine that was never unplugged publishes on its own cadence. One line per
        # reading would be the whole log.
        self._serve(_row(is_archived=True))
        with self.assertLogs("ingestion", level="WARNING") as captured:
            for _ in range(5):
                ingestion._device_cache.clear()
                ingestion.resolve_device(DEVICE)
        archived_lines = [line for line in captured.output if "ARCHIVED" in line]
        self.assertEqual(len(archived_lines), 1)

    def test_the_counter_fires_per_message_while_the_log_is_throttled(self):
        # The asymmetry test_structured_logging.py asserts structurally, asserted here as
        # behaviour: five refusals are five drops even though they are one line.
        before = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        self._serve(_row(is_archived=True))
        for _ in range(5):
            ingestion._device_cache.clear()
            ingestion.resolve_device(DEVICE)
        after = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        self.assertEqual(after, before + 5)

    def test_an_unregistered_device_still_answers_None_without_the_archived_reason(self):
        before = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        self._serve(None)
        self.assertIsNone(ingestion.resolve_device("dev" + "f" * 21))
        # Absent is not archived, and conflating the two would make the reason useless for
        # telling the fixes apart.
        self.assertEqual(
            ingestion.counter_snapshot().get("dropped_device_archived", 0), before)

    def test_include_archived_hands_the_row_back_for_a_caller_that_describes_it(self):
        before = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        self._serve(_row(is_archived=True))
        got = ingestion.resolve_device(DEVICE, include_archived=True)
        self.assertIsNotNone(got)
        self.assertTrue(got["is_archived"])
        # Not counted here either: the caller that asked for the row counts its own refusal, and
        # counting both would report two dropped messages for one.
        self.assertEqual(
            ingestion.counter_snapshot().get("dropped_device_archived", 0), before)


class _Payload:
    """A payload as register_birth_aliases() and the refusals see it: no metrics."""

    metrics = []

    def HasField(self, field):  # noqa: N802 - protobuf's spelling
        return False


class ArchivedDeviceMessagePathTests(_ServesOneDevice):
    """The three message paths, each of which refuses for itself so the message kind is named."""

    def setUp(self):
        super().setUp()
        self._real_quarantine = ingestion.quarantine_new_device
        self._real_connection = ingestion.get_timescaledb_connection
        self.quarantine = MagicMock()
        self.connection = MagicMock()
        ingestion.quarantine_new_device = self.quarantine
        ingestion.get_timescaledb_connection = self.connection

    def tearDown(self):
        ingestion.quarantine_new_device = self._real_quarantine
        ingestion.get_timescaledb_connection = self._real_connection
        super().tearDown()

    def test_a_dbirth_from_an_archived_device_is_not_quarantined(self):
        # THE CASE THE WHOLE `include_archived` ARGUMENT EXISTS FOR. A second row for a machine
        # the stack already holds archived is exactly what archiving rather than deleting was
        # meant to prevent.
        self._serve(_row(is_archived=True))
        ingestion.process_dbirth(DEVICE, NODE, _Payload(), group_id=GROUP)
        self.quarantine.assert_not_called()

    def test_the_dbirth_refusal_is_counted_and_names_the_device(self):
        before = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        self._serve(_row(is_archived=True))
        with self.assertLogs("ingestion", level="WARNING") as captured:
            ingestion.process_dbirth(DEVICE, NODE, _Payload(), group_id=GROUP)
        joined = "\n".join(captured.output)
        self.assertIn("DBIRTH", joined)
        self.assertIn("ARCHIVED", joined)
        self.assertEqual(
            ingestion.counter_snapshot().get("dropped_device_archived", 0), before + 1)

    def test_a_ddata_from_an_archived_device_writes_no_telemetry(self):
        # The bug in one assertion: before this refusal the readings of a decommissioned machine
        # went on being written to the historian.
        self._serve(_row(is_archived=True))
        ingestion.process_ddata(DEVICE, NODE, _Payload(), group_id=GROUP, client=MagicMock())
        self.connection.assert_not_called()

    def test_the_ddata_refusal_is_counted_once_and_not_as_unregistered(self):
        # Two counters for one message would double the drop rate a dashboard reads, and the
        # wrong one would send an operator to the quarantine queue for a device that is not in it.
        before_archived = ingestion.counter_snapshot().get("dropped_device_archived", 0)
        before_unknown = ingestion.counter_snapshot().get(
            "dropped_quarantined_or_unregistered", 0)
        self._serve(_row(is_archived=True))
        ingestion.process_ddata(DEVICE, NODE, _Payload(), group_id=GROUP, client=MagicMock())
        self.assertEqual(
            ingestion.counter_snapshot().get("dropped_device_archived", 0), before_archived + 1)
        self.assertEqual(
            ingestion.counter_snapshot().get("dropped_quarantined_or_unregistered", 0),
            before_unknown)

    def test_a_ddeath_from_an_archived_device_updates_no_status(self):
        client = self._serve(_row(is_archived=True))
        ingestion.process_ddeath(DEVICE, NODE)
        client.rpc.assert_not_called()

    def test_a_live_device_still_walks_the_rest_of_the_path(self):
        # The guard against a refusal that refuses everything. `verify_gateway_binding()` is the
        # first step after the two drop gates, so calling it is the evidence that a live device
        # is unaffected -- and an empty payload writes no telemetry either way, which is what the
        # historian assertion above would really have been measuring.
        real_verify = ingestion.verify_gateway_binding
        verify = MagicMock(return_value=None)
        ingestion.verify_gateway_binding = verify
        try:
            self._serve(_row(is_archived=True))
            ingestion.process_ddata(DEVICE, NODE, _Payload(), group_id=GROUP, client=MagicMock())
            verify.assert_not_called()

            ingestion._device_cache.clear()
            self._serve(_row())
            ingestion.process_ddata(DEVICE, NODE, _Payload(), group_id=GROUP, client=MagicMock())
            verify.assert_called_once()
        finally:
            ingestion.verify_gateway_binding = real_verify


if __name__ == "__main__":
    unittest.main(verbosity=2)
