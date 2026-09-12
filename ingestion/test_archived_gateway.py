"""
Unit tests for refusing traffic from an ARCHIVED edge node (`resolve_gateway` in ingestion.py).

WHY THIS IS THE APPLICATION TIER OF SOMETHING ELSE'S JOB. archived migration 0038 revokes a gateway's broker
credential when it is archived, so an archived appliance should not be able to connect at all. Two
things stop that being sufficient on its own:

  * REVOCATION IS ASYNCHRONOUS. `net.http_post` queues the call and the transaction commits
    regardless, so there is a window in which a decommissioned appliance still holds a working
    credential.
  * REVOCATION CAN BE INERT. A deployment that never set GATEWAY_REVOKE_SECRET does not revoke at
    all, and says so only in a db-init log line nobody re-reads.

In both cases this is the only thing standing between a retired gateway and a row that quietly
returns to ONLINE on the dashboard. Same two-tier arrangement mosquitto/README.md describes for the ACL
and `verify_gateway_binding()`.

THE DISTINCT LOG LINE IS PART OF THE BEHAVIOUR, not decoration. Filtering archived rows inside the
query would have been fewer lines and would make an archived gateway indistinguishable from an
unregistered one -- sending an operator to hunt a provisioning fault when the answer is that
somebody archived it.

Same stubbing approach as test_declared_metrics.py: the daemon's heavy imports are replaced before
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

GROUP = "ACS-Cymru"
NODE = "gwy110000000000400080000"


def _row(**overrides):
    row = {
        "id": "11000000-0000-4000-8000-000000000001",
        "name": "Retired Appliance",
        "sparkplug_id": NODE,
        "sparkplug_group": GROUP,
        "status": "ONLINE",
        "is_archived": False,
    }
    row.update(overrides)
    return row


class ArchivedGatewayTests(unittest.TestCase):
    def setUp(self):
        ingestion._gateway_cache.clear()
        ingestion._archived_gateway_warned.clear()
        self._real_client = ingestion.supabase_client

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion._gateway_cache.clear()

    def _serve(self, row):
        """A Supabase client whose gateway lookup returns exactly this row."""
        table = MagicMock()
        chain = table.select.return_value
        chain.eq.return_value = chain
        chain.execute.return_value = types.SimpleNamespace(data=[row] if row else [])
        client = MagicMock()
        client.table.return_value = table
        ingestion.supabase_client = client
        return client

    def test_a_live_gateway_resolves(self):
        self._serve(_row())
        got = ingestion.resolve_gateway(NODE, GROUP)
        self.assertIsNotNone(got)
        self.assertEqual(got["sparkplug_id"], NODE)

    def test_an_archived_gateway_is_refused(self):
        # THE CASE THIS EXISTS FOR. Without it, process_node_message() writes `status` and
        # `last_heartbeat` to a row an operator retired, and the gateway reappears as ONLINE.
        self._serve(_row(is_archived=True))
        self.assertIsNone(ingestion.resolve_gateway(NODE, GROUP))

    def test_the_refusal_is_counted_under_its_own_reason(self):
        before = ingestion.counter_snapshot().get("dropped_gateway_archived", 0)
        self._serve(_row(is_archived=True))
        ingestion.resolve_gateway(NODE, GROUP)
        after = ingestion.counter_snapshot().get("dropped_gateway_archived", 0)
        self.assertEqual(after, before + 1)

    def test_the_log_names_archival_rather_than_registration(self):
        # An operator reading "unregistered edge node" goes looking for a provisioning fault. The
        # truth is that somebody archived it, which is a different fix, so the two must not share
        # a message.
        self._serve(_row(is_archived=True))
        with self.assertLogs("ingestion", level="WARNING") as captured:
            ingestion.resolve_gateway(NODE, GROUP)
        joined = "\n".join(captured.output)
        self.assertIn("ARCHIVED", joined)
        self.assertIn("Retired Appliance", joined)
        self.assertNotIn("unregistered", joined.lower())

    def test_the_warning_is_throttled(self):
        # An archived appliance that has not been switched off beats every 30s and publishes its
        # devices besides. One line per refusal would be the whole log.
        self._serve(_row(is_archived=True))
        with self.assertLogs("ingestion", level="WARNING") as captured:
            for _ in range(5):
                ingestion._gateway_cache.clear()
                ingestion.resolve_gateway(NODE, GROUP)
        archived_lines = [line for line in captured.output if "ARCHIVED" in line]
        self.assertEqual(len(archived_lines), 1)

    def test_an_unregistered_node_still_answers_None_without_the_archived_reason(self):
        before = ingestion.counter_snapshot().get("dropped_gateway_archived", 0)
        self._serve(None)
        self.assertIsNone(ingestion.resolve_gateway("gwy999999999999999999999", GROUP))
        # Not counted as archived: it is not archived, it is absent, and conflating the two would
        # make the drop reason useless for telling the fixes apart.
        self.assertEqual(
            ingestion.counter_snapshot().get("dropped_gateway_archived", 0), before)


class ArchivedGatewayBindingTests(unittest.TestCase):
    """
    The DEVICE path, which resolve_gateway()'s refusal alone would have got subtly wrong.

    verify_gateway_binding() turns a None gateway into a quarantine REASON, written to
    `devices.quarantine_reason` and read by an operator deciding what to do. If archived and
    unregistered both arrived as None, a device from a gateway somebody had just retired would be
    held with "the publishing edge node is not registered" -- sending them to hunt a provisioning
    fault for a decision they made themselves.
    """

    def setUp(self):
        ingestion._gateway_cache.clear()
        ingestion._archived_gateway_warned.clear()
        self._real_client = ingestion.supabase_client

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion._gateway_cache.clear()

    def _serve(self, row):
        table = MagicMock()
        chain = table.select.return_value
        chain.eq.return_value = chain
        chain.execute.return_value = types.SimpleNamespace(data=[row] if row else [])
        client = MagicMock()
        client.table.return_value = table
        ingestion.supabase_client = client

    DEVICE = {"id": "dev-1", "gateway_id": "11000000-0000-4000-8000-000000000001"}

    def test_a_correctly_bound_device_on_a_live_gateway_passes(self):
        self._serve(_row())
        self.assertIsNone(ingestion.verify_gateway_binding(self.DEVICE, NODE, GROUP))

    def test_a_correctly_bound_device_on_an_ARCHIVED_gateway_is_refused(self):
        # THE ONE A NAIVE FIX GETS WRONG. The device is bound to the very gateway publishing for
        # it, so the id comparison matches by construction -- the archival check has to come first
        # or a decommissioned appliance's telemetry is accepted for being correctly bound.
        self._serve(_row(is_archived=True))
        reason = ingestion.verify_gateway_binding(self.DEVICE, NODE, GROUP)
        self.assertIsNotNone(reason)
        self.assertIn("ARCHIVED", reason)

    def test_the_reason_does_not_claim_the_gateway_is_unregistered(self):
        self._serve(_row(is_archived=True))
        reason = ingestion.verify_gateway_binding(self.DEVICE, NODE, GROUP)
        self.assertNotIn("not registered", reason)

    def test_an_unregistered_edge_node_still_says_so(self):
        self._serve(None)
        reason = ingestion.verify_gateway_binding(self.DEVICE, "gwy999999999999999999999", GROUP)
        self.assertIn("not registered", reason)
        self.assertNotIn("ARCHIVED", reason)


if __name__ == "__main__":
    unittest.main(verbosity=2)
