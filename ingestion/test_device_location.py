"""
Unit tests pinning ONE invariant: the ingestion daemon never writes an asset's location.

`devices.cell_id` (archived migration 0036) is NULL-means-inherit, and it has no column default precisely
so that inheritance stays reachable. That only holds if nothing writes a value on an operator's
behalf -- and the daemon is the one writer with no operator present. A quarantined device must
therefore arrive with no cell and no scope assertion, so that approving it onto a gateway lets it
inherit that gateway's cell, and so that a device nobody has filed yet shows up in the Unassigned
queue rather than looking as though someone had already answered.

This is an invariant test rather than a behaviour test: there is no `cell_id` in ingestion.py at
all, and the point is that there never is one. A future change that starts defaulting a location
here would be silent -- devices would simply stop inheriting, and the queue would stop filling.

Same stubbing approach as test_declared_metrics.py: the daemon's heavy imports are replaced
before ingestion.py is loaded, since none of them are reachable from the code under test.
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

# Every column that carries location. No ingestion write may name any of them.
LOCATION_COLUMNS = ("cell_id", "location_scope")


class FakeMetric:
    def __init__(self, name, string_value=None):
        self.name = name
        self.string_value = string_value

    def HasField(self, field):
        return field == "string_value" and self.string_value is not None


class FakePayload:
    def __init__(self, *metrics):
        self.metrics = list(metrics)
        self.timestamp = 0


class FakeResponse:
    def __init__(self, data):
        self.data = data


class DeviceLocationInvariantTest(unittest.TestCase):

    def setUp(self):
        self._real_client = ingestion.supabase_client
        self._real_resolve_gateway = ingestion.resolve_gateway
        self._real_resolve_device = ingestion.resolve_device

        self.client = MagicMock()
        self.client.rpc.return_value.execute.return_value = FakeResponse(
            [{"id": "dev-uuid", "name": "Unknown_Robot", "sparkplug_id": "dev000000000000000000abc"}]
        )
        ingestion.supabase_client = self.client
        ingestion.resolve_gateway = MagicMock(return_value={"id": "gw-uuid", "name": "GW One"})
        ingestion._device_cache.clear()

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion.resolve_gateway = self._real_resolve_gateway
        ingestion.resolve_device = self._real_resolve_device
        ingestion._device_cache.clear()

    def _inserted(self):
        """
        The parameters of each ingest_register_quarantined_device() call.

        The write goes through a gate now (Machine Identities in supabase/README.md, migration 0047), which strengthens
        what this file asserts rather than merely relocating it: the gate HAS NO location
        parameter, so a location is not something the daemon declines to send -- it is something
        the call cannot express.
        """
        return [
            c.args[1] for c in self.client.rpc.call_args_list
            if c.args and c.args[0] == "ingest_register_quarantined_device"
        ]

    def _updated(self):
        """The parameters of every other ingestion write gate."""
        return [
            c.args[1] for c in self.client.rpc.call_args_list
            if c.args and c.args[0] != "ingest_register_quarantined_device"
        ]

    # -- quarantine_new_device -------------------------------------------------------------

    def test_quarantined_device_has_no_cell(self):
        """
        The load-bearing case. An auto-discovered device is inserted with no operator present,
        so it must express no opinion about where it is: NULL cell_id means "inherit", and
        approve-quarantine sets gateway_id, so the device lands in its gateway's cell the moment
        it is approved. A value written here would win the COALESCE and pin the device wherever
        ingestion guessed, forever.
        """
        ingestion.quarantine_new_device(
            "dev000000000000000000abc", "gwy000000000000000000abc",
            ingestion.REASON_UNKNOWN_DEVICE, FakePayload(FakeMetric("temperature"))
        )
        record = self._inserted()[0]
        self.assertIsNone(record.get("cell_id"))

    def test_quarantined_device_is_not_asserted_site_wide(self):
        """
        Site-Wide is an operator's assertion that an asset has no single cell. The daemon is not
        in a position to make it -- and asserting it would hide the device from the Unassigned
        queue, which is the one place anybody would notice it needed filing.
        """
        ingestion.quarantine_new_device(
            "dev000000000000000000abc", "gwy000000000000000000abc",
            ingestion.REASON_UNKNOWN_DEVICE, FakePayload(FakeMetric("temperature"))
        )
        record = self._inserted()[0]
        self.assertEqual(record.get("location_scope", "cell"), "cell")

    def test_quarantined_device_still_records_its_edge_node(self):
        """
        Regression guard on the surrounding behaviour: the arriving gateway is what an approved
        device inherits its cell FROM, so dropping it would make the NULL above unrecoverable
        rather than merely undecided.
        """
        ingestion.quarantine_new_device(
            "dev000000000000000000abc", "gwy000000000000000000abc",
            ingestion.REASON_UNKNOWN_DEVICE, FakePayload(FakeMetric("temperature"))
        )
        self.assertEqual(self._inserted()[0]["p_gateway_id"], "gw-uuid")

    def test_unregistered_edge_node_still_leaves_the_cell_null(self):
        """A device with no resolvable gateway is unassigned, not assigned to a guess."""
        ingestion.resolve_gateway = MagicMock(return_value=None)
        ingestion.quarantine_new_device(
            "dev000000000000000000abc", "gwy999999999999999999999",
            ingestion.REASON_UNKNOWN_DEVICE, FakePayload(FakeMetric("temperature"))
        )
        record = self._inserted()[0]
        self.assertIsNone(record.get("p_gateway_id"))
        self.assertIsNone(record.get("cell_id"))

    # -- every other write path ------------------------------------------------------------

    def test_dbirth_for_a_registered_device_never_touches_location(self):
        ingestion.resolve_device = MagicMock(return_value={
            "id": "dev-uuid", "name": "Robot_01", "sparkplug_id": "dev000000000000000000abc",
            "is_quarantined": False, "first_dbirth_at": None, "last_birth_metrics": None,
            "_identity_source": ingestion.SOURCE_SPARKPLUG_ID
        })
        ingestion.process_dbirth(
            "dev000000000000000000abc", "gwy000000000000000000abc",
            FakePayload(FakeMetric("temperature"), FakeMetric("Asset_Name", "Robot One"))
        )
        self._assert_no_location_written()

    def test_re_quarantining_a_faulty_identity_never_touches_location(self):
        """
        A device that starts publishing a broken id is re-quarantined. Its location is unrelated
        to its identity and must survive that -- an asset does not move because its gateway was
        misconfigured.
        """
        ingestion.resolve_device = MagicMock(return_value={
            "id": "dev-uuid", "name": "Robot_01", "sparkplug_id": "dev000000000000000000abc",
            "is_quarantined": False, "first_dbirth_at": "2026-01-01T00:00:00Z",
            "last_birth_metrics": [], "_identity_source": ingestion.SOURCE_SPARKPLUG_ID
        })
        ingestion.process_dbirth(
            "dev000000000000000000abc", "gwy000000000000000000abc",
            FakePayload(FakeMetric("temperature")),
            quarantine_reason=ingestion.REASON_IDENTITY_MISMATCH
        )
        self._assert_no_location_written()

    def test_ddeath_never_touches_location(self):
        ingestion.resolve_device = MagicMock(return_value={
            "id": "dev-uuid", "name": "Robot_01", "sparkplug_id": "dev000000000000000000abc",
            "is_quarantined": False
        })
        ingestion.process_ddeath("dev000000000000000000abc", "gwy000000000000000000abc")
        self._assert_no_location_written()

    def test_gateway_heartbeat_never_touches_location(self):
        """
        The gateway side of the same rule. A heartbeat arrives every 30s; if it wrote
        location_scope it would also be appending to digital_thread on every beat.
        """
        ingestion.process_node_message(
            "gwy000000000000000000abc", "NDATA",
            FakePayload(FakeMetric("Gateway_Status", "ONLINE"))
        )
        self._assert_no_location_written()

    def _assert_no_location_written(self):
        for payload in self._inserted() + self._updated():
            for column in LOCATION_COLUMNS:
                self.assertNotIn(
                    column, payload,
                    "ingestion wrote %s -- location is the operator's to set, and a value "
                    "written here defeats NULL-means-inherit" % column
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
