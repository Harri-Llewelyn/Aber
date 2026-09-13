"""
The startup recovery loop: the work a dependency that was not up yet prevented, retried.

WHY THIS IS WORTH A SUITE. The fault it guards is one this stack reached, and both of its
consequences were silent in opposite directions.

    acs-cymru_ingestion    started 20:08:52.370   restarts=0   policy=always
    acs-cymru_timescaledb  started 20:08:52.823   restarts=0   policy=always

Nothing orders a whole-host restart, so when the stack came back it started ingestion 453ms
before the historian and the dependency graph had no say.
The daemon then entered its MQTT loop having done none of the startup work that needed a database,
and NOTHING RETRIED ANY OF IT:

  1. `_ts_conn` was never set, and only a WRITE sets it -- so on a stack with nothing publishing it
     stayed None, `acs_ingestion_db_connected` read 0 for ever, and `Historian Unreachable From
     Ingestion` fired against a historian that was reachable throughout and dropping nothing,
     because there was nothing to drop. A false alarm that never clears is worse than no alarm: it
     is the one an operator learns to close.

  2. capture_worker.reconcile() ran once and lost. Its own docstring calls that failure total
     rather than cosmetic -- a job left at RECORDING still matches the single-flight index, so
     every subsequent capture on the stack is refused with nothing to point at. That one is worse
     than the alert and is invisible until somebody presses the button.

THE INTERESTING BEHAVIOUR IS ALL IN THE EDGES, which is why _heal_pass() is a function rather than
a closure inside a thread: the race with the callback thread, the checks that must happen exactly
once, and the counter that must NOT move. Testing those through a sleeping thread would make the
suite a timing experiment.
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

import capture_worker  # noqa: E402
import ingestion  # noqa: E402


class FakeConn:
    """A psycopg2 connection as far as the healer is concerned: `closed` and `close()`."""

    def __init__(self, closed=0):
        self.closed = closed
        self.close_calls = 0

    def close(self):
        self.close_calls += 1
        self.closed = 1


class HealerTestCase(unittest.TestCase):
    """Shared isolation: the connection global is module-level and process-wide."""

    def setUp(self):
        self.addCleanup(setattr, ingestion, "_ts_conn", ingestion._ts_conn)
        ingestion._ts_conn = None

    def counter(self, name):
        """By INTERNAL name -- counter_snapshot() is the daemon's registry, pre-mapping."""
        return ingestion.counter_snapshot().get(name, 0)

    def patch(self, attr, value):
        original = getattr(ingestion, attr)
        self.addCleanup(setattr, ingestion, attr, original)
        setattr(ingestion, attr, value)

    def patch_reconcile(self, value):
        """
        THROUGH `ingestion.capture_worker`, NOT THE ONE THIS FILE IMPORTED. test_capture_worker.py
        drops capture_worker from sys.modules and re-imports it to get the real generated protobuf,
        so under a full run the two names can be different module objects and a patch applied here
        would land on the one nothing calls. _heal_pass() resolves it through ingestion's global;
        that is the object to patch.
        """
        module = ingestion.capture_worker
        original = module.reconcile
        self.addCleanup(setattr, module, "reconcile", original)
        module.reconcile = value

    def refuse_to_connect(self, **kwargs):
        raise OSError("connection refused")


class ConnectionRecovery(HealerTestCase):
    """The half that makes acs_ingestion_db_connected tell the truth."""

    def test_opens_the_connection_the_daemon_should_already_have_held(self):
        fresh = FakeConn()
        self.patch("_connect_timescaledb", lambda **kw: fresh)
        self.assertIsNone(ingestion._ts_conn)

        conn = ingestion._heal_pass(ingestion._HealState())

        self.assertIs(conn, fresh)
        self.assertIs(ingestion._ts_conn, fresh)

    def test_the_gauge_reads_one_after_a_heal_and_zero_before(self):
        """
        The whole point, asserted through the expression the metrics endpoint actually exports
        rather than through the variable behind it.
        """
        def gauge():
            conn = ingestion._ts_conn
            return 1 if (conn is not None and not conn.closed) else 0

        self.assertEqual(gauge(), 0)
        self.patch("_connect_timescaledb", lambda **kw: FakeConn())
        ingestion._heal_pass(ingestion._HealState())
        self.assertEqual(gauge(), 1)

    def test_it_bounds_its_own_connect_attempt(self):
        """
        Unbounded, one dead TCP peer would stretch the loop's period to whatever the kernel decides
        a half-open socket is worth -- minutes -- and the recovery would arrive long after the
        thing it was recovering from.
        """
        seen = {}

        def connect(**kwargs):
            seen.update(kwargs)
            return FakeConn()

        self.patch("_connect_timescaledb", connect)
        ingestion._heal_pass(ingestion._HealState())

        self.assertEqual(
            seen.get("connect_timeout"), ingestion.DB_HEAL_CONNECT_TIMEOUT_SECONDS
        )

    def test_a_healthy_connection_is_left_alone(self):
        """No reconnect churn on a stack that came up cleanly -- the loop is resident for life."""
        held = FakeConn()
        ingestion._ts_conn = held
        self.patch("_connect_timescaledb", self._must_not_connect)

        conn = ingestion._heal_pass(ingestion._HealState())

        self.assertIs(conn, held)
        self.assertIs(ingestion._ts_conn, held)

    def test_a_connection_closed_on_this_side_is_replaced(self):
        """
        `_ts_conn` is also cleared by a write that failed, so a database restart on a quiet stack
        is the same false alarm arriving by a different road. This is why the thread does not exit
        once the deferred work is settled.
        """
        ingestion._ts_conn = FakeConn(closed=1)
        fresh = FakeConn()
        self.patch("_connect_timescaledb", lambda **kw: fresh)

        self.assertIs(ingestion._heal_pass(ingestion._HealState()), fresh)
        self.assertIs(ingestion._ts_conn, fresh)

    def _must_not_connect(self, **kwargs):
        self.fail("the healer connected while already holding a usable connection")


class TheRaceWithTheCallbackThread(HealerTestCase):
    """
    The healer connects with the lock RELEASED, which is what keeps the fleet off a network round
    trip -- and is exactly what opens this window. Losing the race must cost a closed connection,
    never a leaked one and never a swapped one.
    """

    def test_the_callback_threads_connection_wins_and_the_healers_is_closed(self):
        winner = FakeConn()
        loser = FakeConn()

        def connect(**kwargs):
            # Stands in for the callback thread connecting while the lock is not held.
            ingestion._ts_conn = winner
            return loser

        self.patch("_connect_timescaledb", connect)

        conn = ingestion._heal_pass(ingestion._HealState())

        self.assertIs(conn, winner, "the connection in use must not be swapped out from under it")
        self.assertIs(ingestion._ts_conn, winner)
        self.assertEqual(
            loser.close_calls, 1, "the redundant connection must be closed, not leaked"
        )

    def test_losing_the_race_does_not_count_as_a_heal(self):
        before = self.counter("db_heals")
        self.patch("_connect_timescaledb", self._connect_after_someone_else)
        ingestion._heal_pass(ingestion._HealState())
        self.assertEqual(self.counter("db_heals"), before)

    def _connect_after_someone_else(self, **kwargs):
        ingestion._ts_conn = FakeConn()
        return FakeConn()


class WhatAFailedAttemptCounts(HealerTestCase):
    """
    THE COUNTER SEPARATION IS LOAD-BEARING. `acs_ingestion_db_connect_failures_total` means a
    message needed the historian and did not get it -- telemetry dropped -- and the alert rules
    read it that way. A healer attempt drops nothing: it is a daemon with no traffic waiting for a
    database. Counting them together would make an idle stack indistinguishable from a lossy one.
    """

    def setUp(self):
        super().setUp()
        self.patch("_connect_timescaledb", self.refuse_to_connect)

    def test_a_failed_heal_moves_only_the_heal_counter(self):
        drops_before = self.counter("db_connect_failures")
        heals_before = self.counter("db_heal_failures")

        self.assertIsNone(ingestion._heal_pass(ingestion._HealState()))

        self.assertEqual(
            self.counter("db_connect_failures"), drops_before,
            "a healer attempt dropped no telemetry and must not be counted as though it had",
        )
        self.assertEqual(self.counter("db_heal_failures"), heals_before + 1)

    def test_an_outage_is_reported_once_rather_than_once_per_attempt(self):
        state = ingestion._HealState()
        ingestion._heal_pass(state)
        self.assertTrue(state.reported_down)
        ingestion._heal_pass(state)
        self.assertTrue(state.reported_down, "still one outage, not two")

    def test_the_report_arms_again_once_the_historian_returns(self):
        state = ingestion._HealState()
        ingestion._heal_pass(state)
        self.assertTrue(state.reported_down)

        self.patch("_connect_timescaledb", lambda **kw: FakeConn())
        ingestion._heal_pass(state)
        self.assertFalse(state.reported_down, "the NEXT outage must be reported")


class DeferredCaptureReconciliation(HealerTestCase):
    """The consequence that is worse than the alert. Retried until it runs, then never again."""

    def test_it_retries_until_the_sweep_runs(self):
        attempts = []

        def reconcile(client):
            attempts.append(client)
            return len(attempts) > 2

        self.patch_reconcile(reconcile)
        self.patch("_connect_timescaledb", lambda **kw: FakeConn())

        state = ingestion._HealState(reconcile_capture=True)
        for _ in range(5):
            ingestion._heal_pass(state, MagicMock())

        self.assertEqual(len(attempts), 3, "it must stop asking once the sweep has run")
        self.assertTrue(state.capture_reconciled)

    def test_a_stack_that_reconciled_at_startup_is_never_asked_again(self):
        self.patch_reconcile(lambda client: self.fail("reconciliation was already done"))
        self.patch("_connect_timescaledb", lambda **kw: FakeConn())

        ingestion._heal_pass(ingestion._HealState(), MagicMock())

    def test_it_is_retried_even_while_the_historian_is_still_down(self):
        """
        The two deferred steps have DIFFERENT dependencies -- Supabase and the historian -- so
        tying them to one flag would leave capture broken for as long as the historian stayed down,
        which has nothing to do with it.
        """
        self.patch("_connect_timescaledb", self.refuse_to_connect)
        ran = []
        self.patch_reconcile(lambda client: ran.append(client) or True)

        state = ingestion._HealState(reconcile_capture=True)
        ingestion._heal_pass(state, MagicMock())

        self.assertEqual(len(ran), 1)
        self.assertTrue(state.capture_reconciled)

    def test_it_is_not_attempted_without_a_supabase_client(self):
        self.patch_reconcile(lambda client: self.fail("reconciled with no client"))
        self.patch("_connect_timescaledb", lambda **kw: FakeConn())

        state = ingestion._HealState(reconcile_capture=True)
        ingestion._heal_pass(state, None)
        self.assertFalse(state.capture_reconciled, "still owed")


class DeferredPrivilegeCheck(HealerTestCase):
    """
    main() skips the superuser check when the startup connect fails, so without this a daemon that
    lost the ordering race runs unverified -- and "append-only historian writes" goes back to being
    a claim nothing enforces.
    """

    def test_it_runs_once_on_the_healed_connection(self):
        fresh = FakeConn()
        self.patch("_connect_timescaledb", lambda **kw: fresh)
        checked = []
        self.patch("_assert_historian_is_least_privilege", checked.append)

        state = ingestion._HealState(check_privileges=True)
        ingestion._heal_pass(state, None)
        ingestion._heal_pass(state, None)

        self.assertEqual(checked, [fresh], "the check is a startup step, not a periodic one")
        self.assertTrue(state.privileges_checked)

    def test_it_is_not_run_on_a_stack_that_checked_at_startup(self):
        self.patch("_connect_timescaledb", lambda **kw: FakeConn())
        self.patch(
            "_assert_historian_is_least_privilege",
            lambda conn: self.fail("the privilege check already ran in main()"),
        )
        ingestion._heal_pass(ingestion._HealState(), None)

    def test_it_is_not_attempted_while_there_is_no_connection(self):
        self.patch("_connect_timescaledb", self.refuse_to_connect)
        self.patch(
            "_assert_historian_is_least_privilege",
            lambda conn: self.fail("checked privileges without a connection"),
        )
        state = ingestion._HealState(check_privileges=True)
        ingestion._heal_pass(state, None)
        self.assertFalse(state.privileges_checked, "still owed")

    def test_a_superuser_historian_halts_the_process_rather_than_the_thread(self):
        """
        SystemExit RAISED IN A DAEMON THREAD UNWINDS THAT THREAD AND LEAVES THE PROCESS RUNNING,
        which would turn _assert_historian_is_least_privilege()'s deliberate refusal to start into
        a warning nobody sees. The refusal has to reach the process.
        """
        def refuse_to_run(conn):
            raise SystemExit(1)

        self.patch("_connect_timescaledb", lambda **kw: FakeConn())
        self.patch("_assert_historian_is_least_privilege", refuse_to_run)

        exits = []
        original = os._exit
        os._exit = exits.append
        self.addCleanup(setattr, os, "_exit", original)

        ingestion._heal_pass(ingestion._HealState(check_privileges=True), None)

        self.assertEqual(exits, [1], "a superuser historian must stop the daemon, not one thread")


class WhatTheLoopIsToldToOwe(unittest.TestCase):
    """
    The flags come from what main() managed, so a clean boot must arm neither of the one-shot
    steps -- otherwise every stack pays for a race almost none of them lost.
    """

    def test_a_clean_boot_owes_nothing(self):
        self.assertTrue(ingestion._HealState().settled)

    def test_a_lost_race_owes_both(self):
        state = ingestion._HealState(check_privileges=True, reconcile_capture=True)
        self.assertFalse(state.settled)


class ReconcileReportsItsOutcome(unittest.TestCase):
    """
    The boolean is how the healer knows whether it still owes the sweep. It used to be swallowed,
    which is precisely why a Supabase that was not up yet left capture dead for the life of the
    process with one ERROR line to show for it.
    """

    def test_true_when_the_sweep_ran(self):
        supabase = MagicMock()
        supabase.rpc.return_value.execute.return_value.data = 0
        self.assertTrue(capture_worker.reconcile(supabase))

    def test_true_even_when_it_swept_something(self):
        supabase = MagicMock()
        supabase.rpc.return_value.execute.return_value.data = 3
        self.assertTrue(capture_worker.reconcile(supabase))

    def test_false_when_it_could_not_reach_supabase(self):
        supabase = MagicMock()
        supabase.rpc.side_effect = OSError("[Errno 111] Connection refused")
        self.assertFalse(capture_worker.reconcile(supabase))


if __name__ == "__main__":
    unittest.main()
