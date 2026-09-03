"""
Unit tests for the gateway<->device binding check (audit blocker B1).

THE ATTACK THIS CLOSES. A Sparkplug `sparkplug_id` is an identifier, not a secret: it is derived
from the row's UUID, displayed in the dashboard and present in every topic. Before this check,
the device segment of the topic was the ONLY thing consulted, so any edge node authenticated to
the broker could publish under any device's id. Three consequences, in ascending severity:

  1. forge another machine's telemetry into the historian;
  2. flip another machine ONLINE with a fabricated DBIRTH;
  3. publish a contradictory Asset_ID for a device you do not own, forcing it into quarantine --
     which silently stops its real telemetry being stored. A denial of service against a
     production asset, triggered by one message.

`mosquitto.acl` closes the same hole at the broker tier. Both are needed: the broker cannot know
which device belongs to which gateway (that lives in Supabase), and the daemon cannot stop a
forged message being delivered to other subscribers.

Same stubbing approach as test_declared_metrics.py -- the daemon's heavy imports are replaced
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


GATEWAY_A = {"id": "aaaaaaaa-0000-4000-8000-000000000001", "name": "Gateway_A",
             "sparkplug_id": "gwyaaaaaaaaaaaaaaaaaaaaa"}
GATEWAY_B = {"id": "bbbbbbbb-0000-4000-8000-000000000002", "name": "Gateway_B",
             "sparkplug_id": "gwybbbbbbbbbbbbbbbbbbbbb"}


def device_bound_to(gateway, identity_source=ingestion.SOURCE_SPARKPLUG_ID):
    return {
        "id": "dddddddd-0000-4000-8000-000000000003",
        "name": "Press_01",
        "sparkplug_id": "dev111111111111111111111",
        "gateway_id": gateway["id"] if gateway else None,
        "is_quarantined": False,
        "_identity_source": identity_source,
    }


class GatewayBindingTest(unittest.TestCase):
    """verify_gateway_binding() decides whether a publisher may speak for a device."""

    def setUp(self):
        self._real_resolve = ingestion.resolve_gateway
        ingestion._gateway_cache.clear()

    def tearDown(self):
        ingestion.resolve_gateway = self._real_resolve
        ingestion._gateway_cache.clear()

    def _resolve_returns(self, gateway):
        ingestion.resolve_gateway = MagicMock(return_value=gateway)

    def test_the_bound_gateway_is_accepted(self):
        """The ordinary case: a device's own gateway publishes for it."""
        self._resolve_returns(GATEWAY_A)
        self.assertIsNone(
            ingestion.verify_gateway_binding(device_bound_to(GATEWAY_A), GATEWAY_A["sparkplug_id"])
        )

    def test_another_gateway_is_rejected(self):
        """THE SPOOFING CASE. Gateway B must not be able to speak for a device bound to A."""
        self._resolve_returns(GATEWAY_B)
        reason = ingestion.verify_gateway_binding(
            device_bound_to(GATEWAY_A), GATEWAY_B["sparkplug_id"]
        )
        self.assertIsNotNone(reason, "a device announced by a foreign gateway must be rejected")
        self.assertTrue(reason.startswith(ingestion.REASON_GATEWAY_MISMATCH))

    def test_an_unregistered_edge_node_is_rejected_for_a_bound_device(self):
        """
        resolve_gateway()'s docstring has always said unregistered edge nodes are dropped. That
        was only ever enforced on the node-level path, so a device message arriving via an
        unknown edge node was accepted.
        """
        self._resolve_returns(None)
        reason = ingestion.verify_gateway_binding(
            device_bound_to(GATEWAY_A), "gwy999999999999999999999"
        )
        self.assertIsNotNone(reason)
        self.assertTrue(reason.startswith(ingestion.REASON_GATEWAY_MISMATCH))

    def test_a_device_with_no_gateway_is_not_a_mismatch(self):
        """
        Binding is established by an operator at approval, not by ingestion. An unbound device
        is unbound, not mis-bound -- rejecting it would strand every device awaiting approval.
        """
        self._resolve_returns(GATEWAY_B)
        self.assertIsNone(
            ingestion.verify_gateway_binding(device_bound_to(None), GATEWAY_B["sparkplug_id"])
        )

    def test_a_legacy_name_matched_device_is_still_bound(self):
        """
        THE SPOOFING CASE AGAIN, BY THE ROUTE THAT USED TO WORK. This was an explicit exemption:
        a device resolved by legacy `name` skipped the binding check outright.

        The exemption's stated reason was that such a row "may predate any gateway assignment"
        -- but an unassigned row is caught by the `gateway_id` branch, which returns before the
        exemption is reached (see test_an_unbound_legacy_device_is_still_not_a_mismatch). So it
        only ever fired for a device that IS bound, and resolve_device() falls back to a `name`
        lookup for any wire id that is not a platform-issued `dev` id -- making the topic's
        device segment, which the broker ACL does not constrain, enough to reach any device on
        the site and be believed.
        """
        self._resolve_returns(GATEWAY_B)
        device = device_bound_to(GATEWAY_A, identity_source=ingestion.SOURCE_LEGACY_NAME)
        reason = ingestion.verify_gateway_binding(device, GATEWAY_B["sparkplug_id"])
        self.assertIsNotNone(
            reason,
            "how a device was resolved must not decide whether its binding is enforced"
        )
        self.assertTrue(reason.startswith(ingestion.REASON_GATEWAY_MISMATCH))

    def test_a_legacy_name_matched_device_on_its_own_gateway_is_accepted(self):
        """
        The migration window is not closed by the above: a legacy-addressed device publishing
        via the gateway it is actually bound to still passes. Only the mismatch is refused.
        """
        self._resolve_returns(GATEWAY_A)
        device = device_bound_to(GATEWAY_A, identity_source=ingestion.SOURCE_LEGACY_NAME)
        self.assertIsNone(
            ingestion.verify_gateway_binding(device, GATEWAY_A["sparkplug_id"])
        )

    def test_an_unbound_legacy_device_is_still_not_a_mismatch(self):
        """
        The case the removed exemption claimed to protect, shown to be covered without it: a
        legacy-addressed row with no gateway assignment is unbound, and unbound is not
        mis-bound. This is what keeps a pre-0014 fleet ingesting while it is reconfigured.
        """
        self._resolve_returns(GATEWAY_B)
        device = device_bound_to(None, identity_source=ingestion.SOURCE_LEGACY_NAME)
        self.assertIsNone(
            ingestion.verify_gateway_binding(device, GATEWAY_B["sparkplug_id"])
        )

    def test_no_device_is_not_a_mismatch(self):
        """An unresolved device is handled by the quarantine path, not by this check."""
        self._resolve_returns(GATEWAY_A)
        self.assertIsNone(ingestion.verify_gateway_binding(None, GATEWAY_A["sparkplug_id"]))


class TelemetrySanityWindowTest(unittest.TestCase):
    """
    Device-supplied metric timestamps are trusted for ordering, but not unconditionally.

    Asymmetric by design: late data is normal (a gateway buffers through an outage and flushes on
    reconnect), whereas data from the future is always a clock fault.
    """

    def _at(self, offset_seconds):
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        return ingestion._timestamp_is_sane(now + timedelta(seconds=offset_seconds), now)

    def test_now_is_accepted(self):
        self.assertTrue(self._at(0))

    def test_recent_past_is_accepted(self):
        self.assertTrue(self._at(-3600))

    def test_data_just_inside_the_backward_edge_is_accepted(self):
        self.assertTrue(self._at(-(ingestion.TELEMETRY_MAX_AGE_SECONDS - 60)))

    def test_data_older_than_the_window_is_rejected(self):
        self.assertFalse(self._at(-(ingestion.TELEMETRY_MAX_AGE_SECONDS + 60)))

    def test_small_forward_skew_is_accepted(self):
        """Ordinary NTP skew must not cost a reading."""
        self.assertTrue(self._at(60))

    def test_far_future_is_rejected(self):
        self.assertFalse(self._at(ingestion.TELEMETRY_MAX_FUTURE_SECONDS + 60))

    def test_the_forward_tolerance_is_much_tighter_than_the_backward_one(self):
        """Pins the asymmetry itself, so a later 'tidy-up' cannot quietly symmetrise it."""
        self.assertLess(
            ingestion.TELEMETRY_MAX_FUTURE_SECONDS,
            ingestion.TELEMETRY_MAX_AGE_SECONDS,
        )


class TelemetryIsNotUpsertableTest(unittest.TestCase):
    """
    The historian records what was observed; it is not a mutable store.

    An `ON CONFLICT ... DO UPDATE` let any publisher rewrite history at a timestamp of its
    choosing, which combined with device-supplied timestamps meant arbitrary retroactive edits.
    Asserted against the source because the statement is a string literal with no seam to test
    through -- the same approach test_aas_export.py uses for the XSD mapper.
    """

    def test_the_telemetry_insert_does_not_update_on_conflict(self):
        source = open(
            os.path.join(INGESTION_DIR, "ingestion.py"), encoding="utf-8"
        ).read()
        insert_start = source.index("INSERT INTO telemetry")
        statement = source[insert_start:insert_start + 600]
        self.assertIn("ON CONFLICT (time, asset_id, metric_name) DO NOTHING", statement)
        self.assertNotIn("DO UPDATE", statement)


class ReportedGatewayStatusTest(unittest.TestCase):
    """
    A gateway names its own operating states; it does not name the platform's.

    `gateways.status` is unconstrained text on purpose (archived migration 0025) -- a `Gateway_Status`
    metric overrides the status the message type implies, so the vocabulary belongs to the
    fleet. That was read as "any string, any length", and the payload value went to the column
    verbatim. The three reserved values are written by code that knows something the gateway
    does not, and all three short-circuit ahead of the staleness arm in public.gateway_status --
    so a gateway asserting one goes on reporting healthy after it stops publishing.
    """

    def setUp(self):
        ingestion._status_rejected_warned.clear()

    def test_an_ordinary_status_is_accepted(self):
        self.assertEqual(ingestion.accept_reported_status("MAINTENANCE", "gwya"), "MAINTENANCE")

    def test_surrounding_whitespace_is_trimmed(self):
        self.assertEqual(ingestion.accept_reported_status("  DEGRADED \n", "gwya"), "DEGRADED")

    def test_every_reserved_status_is_refused(self):
        for reserved in ingestion.RESERVED_GATEWAY_STATUSES:
            with self.subTest(reserved=reserved):
                ingestion._status_rejected_warned.clear()
                self.assertIsNone(ingestion.accept_reported_status(reserved, "gwya"))

    def test_a_reserved_status_cannot_be_smuggled_in_a_different_case(self):
        """Compared upper-cased, or `awaiting_birth` walks past a check on `AWAITING_BIRTH`."""
        self.assertIsNone(ingestion.accept_reported_status("awaiting_birth", "gwya"))
        self.assertIsNone(ingestion.accept_reported_status("Stale", "gwya"))

    def test_an_over_length_status_is_refused_rather_than_truncated(self):
        """
        A truncated status is a DIFFERENT status. Refusing keeps the one the message type
        implies, which is at least true.
        """
        self.assertIsNone(
            ingestion.accept_reported_status("X" * (ingestion.MAX_GATEWAY_STATUS_LENGTH + 1), "gwya")
        )

    def test_a_status_at_exactly_the_cap_is_accepted(self):
        at_cap = "X" * ingestion.MAX_GATEWAY_STATUS_LENGTH
        self.assertEqual(ingestion.accept_reported_status(at_cap, "gwya"), at_cap)

    def test_empty_and_non_string_values_are_refused(self):
        for value in ("", "   ", None, 123, [], {}):
            with self.subTest(value=value):
                self.assertIsNone(ingestion.accept_reported_status(value, "gwya"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
