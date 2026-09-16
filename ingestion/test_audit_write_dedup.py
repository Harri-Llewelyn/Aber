"""
Unit tests for ingestion's write deduplication on the DBIRTH and node-heartbeat paths.

WHAT THIS PROTECTS, AND WHY IT IS NOT THE SAME THING AS THE AUDIT GUARD.

archived migration 0005 already stops an unchanged UPDATE from writing a `digital_thread` row, and stops a
heartbeat-only UPDATE from writing one either. That is the DATABASE half, and
`supabase/migrations/test_digital_thread_guard.py` covers it.

This suite covers the DAEMON half, which 0005 cannot reach: the UPDATE statement itself. A write
that changes nothing still costs a PostgREST round trip, still produces a WAL record, and -- because
`devices` and `gateways` are both REPLICA IDENTITY FULL and published to `supabase_realtime` -- still
broadcasts a FULL-ROW change event to every connected dashboard. A birth certificate is repeated on
a timer, so without the comparison in process_dbirth that is one broadcast per device per rebirth,
forever, carrying no news.

The two halves are deliberately independent. Neither substitutes for the other, and a regression in
either one is silent.

THE HEARTBEAT PATH IS TESTED FOR THE OPPOSITE PROPERTY. `last_heartbeat` MUST be written on every
heartbeat -- `public.gateway_status` derives staleness from it at read time, so suppressing that
write would make a live gateway report STALE. The tests below assert the write still happens and
that only the LOG distinguishes a transition. A test asserting heartbeat deduplication would
enshrine a staleness bug, which is why it is called out here rather than left to be inferred.

Follows the same stubbing approach as test_declared_metrics.py: the daemon's heavy imports are
replaced before ingestion.py is loaded, since none of them are reachable from the code under test.
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
import registry  # noqa: E402


GROUP = "ACS-Cymru"
GATEWAY_ID = "gwy" + "1" * 21
DEVICE_ID = "dev" + "2" * 21


class FakeMetric:
    def __init__(self, name, string_value=None):
        self.name = name
        self.alias = 0
        self.string_value = string_value
        self._present = set()
        if string_value is not None:
            self._present.add("string_value")

    def HasField(self, field):
        return field in self._present


class FakePayload:
    def __init__(self, *names):
        self.metrics = [FakeMetric(n) for n in names]


def registered_device(**overrides):
    """
    A device row as resolve_device() returns it -- including `status` and `identity_source`, which
    are in _DEVICE_COLUMNS precisely so process_dbirth can compare against them.
    """
    row = {
        "id": "device-uuid",
        "name": "Sim_CNC_Mill_01",
        "sparkplug_id": DEVICE_ID,
        "reported_identity": None,
        "gateway_id": "gateway-uuid",
        "is_quarantined": False,
        "first_dbirth_at": "2026-08-01T09:00:00+00:00",
        "last_birth_metrics": ["Systems/TEMPERATURE"],
        "status": "ONLINE",
        "identity_source": ingestion.SOURCE_SPARKPLUG_ID,
        "_identity_source": ingestion.SOURCE_SPARKPLUG_ID,
    }
    row.update(overrides)
    return row


class DBirthDedupTestCase(unittest.TestCase):
    """
    Drives process_dbirth() with a resolvable, bound, unquarantined device and inspects what it
    asked Supabase to write.
    """

    def setUp(self):
        self._real_client = ingestion.supabase_client
        self.client = MagicMock()
        ingestion.supabase_client = self.client

        ingestion._device_cache.clear()
        ingestion._gateway_cache.clear()
        ingestion._device_seen.clear()
        ingestion._alias_map.clear()
        registry.reset()

        self.device = registered_device()

        # Stub out everything process_dbirth does around the write under test. Each of these has
        # its own suite; re-exercising them here would couple this test to their behaviour.
        self._patched = {}
        for name, replacement in (
            ("resolve_device", lambda wire_id, use_cache=True, include_archived=False: self.device),
            ("verify_gateway_binding", lambda device, gw, group=None: None),
            ("store_birth_parameters", lambda sparkplug_id, payload: None),
            ("record_declared_metrics", lambda device, payload: None),
            ("mark_device_seen", lambda device: None),
            ("register_birth_aliases", lambda *a, **k: 0),
        ):
            self._patched[name] = getattr(ingestion, name)
            setattr(ingestion, name, replacement)

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        for name, original in self._patched.items():
            setattr(ingestion, name, original)

    def birth(self):
        ingestion.process_dbirth(DEVICE_ID, GATEWAY_ID, FakePayload("Systems/TEMPERATURE"),
                                 None, group_id=GROUP)

    def device_updates(self):
        """
        The fields each ingest_set_device_state() call actually changes.

        The write goes through a gate now (Machine Identities in supabase/README.md, archived migration 0047). Its signature is
        fixed and NULL means "leave alone", so the changed-field set that used to be the UPDATE
        payload is now the non-NULL parameters -- normalised back to column names here so the
        assertions keep saying what they said. The property is unchanged: a steady-state rebirth
        must produce no call at all, because log_digital_thread_event() fires on every UPDATE to
        `devices` and a birth certificate is repeated on a timer.
        """
        columns = (("status", "p_status"),
                   ("identity_source", "p_identity_source"),
                   ("first_dbirth_at", "p_first_dbirth_at"))
        out = []
        for c in self.client.rpc.call_args_list:
            if not c.args or c.args[0] != "ingest_set_device_state":
                continue
            params = c.args[1]
            out.append({col: params[key] for col, key in columns
                        if params.get(key) is not None})
        return out


class TestDBirthWriteDeduplication(DBirthDedupTestCase):

    def test_a_steady_state_device_writes_nothing_at_all(self):
        """
        The strongest form of the property, and the steady state on a running stack: a device
        already ONLINE, with its identity_source current and first_dbirth_at set, has nothing to
        write on ANY birth -- including the first one this process sees. Every rebirth is silent.
        """
        self.birth()
        self.birth()
        self.birth()
        self.assertEqual(self.device_updates(), [])

    def test_two_identical_births_issue_exactly_one_update(self):
        """
        The headline case. Starting from OFFLINE so the first birth has something real to say:
        it writes once, and the identical rebirth behind it writes nothing.

        The shipped simulator rebirths on a timer, so without this the second write -- and every
        one after it -- broadcasts a full-row Realtime event carrying no news.
        """
        self.device = registered_device(status="OFFLINE")
        self.birth()
        self.birth()
        self.assertEqual(len(self.device_updates()), 1)

    def test_first_birth_of_an_offline_device_writes_status(self):
        self.device = registered_device(status="OFFLINE")
        self.birth()

        updates = self.device_updates()
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["status"], "ONLINE")

    def test_status_change_after_a_quiet_period_writes_again(self):
        """
        A device swept OFFLINE by the watchdog and then re-birthing is a real transition and must
        reach the database -- the audit row for it is what an operator looks for afterwards.
        """
        self.birth()
        self.assertEqual(self.device_updates(), [], "steady state should be silent")

        # The watchdog flipped it OFFLINE in the database and dropped it from the cache; the next
        # resolve returns the new state.
        self.device["status"] = "OFFLINE"
        self.birth()

        updates = self.device_updates()
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["status"], "ONLINE")

    def test_identity_source_change_writes_even_when_status_matches(self):
        """
        Both fields are compared, not just status. A device that moves from legacy name matching
        onto its issued sparkplug_id has changed something worth recording.
        """
        self.device = registered_device(identity_source=ingestion.SOURCE_LEGACY_NAME)
        self.device["_identity_source"] = ingestion.SOURCE_SPARKPLUG_ID
        self.birth()

        updates = self.device_updates()
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["identity_source"], ingestion.SOURCE_SPARKPLUG_ID)
        self.assertNotIn("status", updates[0])

    def test_unchanged_fields_are_not_included_in_the_write(self):
        """
        Only what moved is sent. A payload carrying an unchanged column would make the UPDATE
        write it again -- harmless for the value, but it defeats the point of the comparison.
        """
        self.device = registered_device(status="OFFLINE")
        self.birth()
        self.assertEqual(set(self.device_updates()[0]), {"status"})


class TestFirstDbirthAtIsWriteOnce(DBirthDedupTestCase):

    def test_written_once_when_absent(self):
        self.device = registered_device(first_dbirth_at=None)
        self.birth()

        updates = self.device_updates()
        self.assertEqual(len(updates), 1)
        self.assertIn("first_dbirth_at", updates[0])

    def test_not_rewritten_on_a_later_birth(self):
        """
        Write-once. A later rebirth must never overwrite the original commissioning timestamp --
        and with the dedup in place the second birth issues no write at all.
        """
        self.device = registered_device(first_dbirth_at=None)
        self.birth()
        first = self.device_updates()[0]["first_dbirth_at"]

        self.birth()
        updates = self.device_updates()
        self.assertEqual(len(updates), 1, "the second birth wrote when nothing had changed")
        self.assertEqual(self.device["first_dbirth_at"], first)

    def test_write_once_survives_a_later_status_transition(self):
        """
        The regression that matters: a device with no first_dbirth_at that later transitions must
        get the timestamp on the FIRST birth and never again, even though the second write happens.
        """
        self.device = registered_device(first_dbirth_at=None)
        self.birth()
        first = self.device_updates()[0]["first_dbirth_at"]

        self.device["status"] = "OFFLINE"
        self.birth()

        updates = self.device_updates()
        self.assertEqual(len(updates), 2)
        self.assertNotIn("first_dbirth_at", updates[1])
        self.assertEqual(self.device["first_dbirth_at"], first)


class TestCachedRowIsUpdatedInPlace(DBirthDedupTestCase):
    """
    resolve_device() caches the same dict this code mutates. Without the in-place update, a second
    birth inside CACHE_TTL_SECONDS re-reads the stale row, re-detects the same change and writes
    again -- which is the exact defect the comparison exists to remove.
    """

    def test_status_is_reflected_on_the_row_after_a_write(self):
        self.device = registered_device(status="OFFLINE")
        self.birth()
        self.assertEqual(self.device["status"], "ONLINE")

    def test_identity_source_is_reflected_on_the_row_after_a_write(self):
        self.device = registered_device(identity_source=ingestion.SOURCE_LEGACY_NAME)
        self.device["_identity_source"] = ingestion.SOURCE_SPARKPLUG_ID
        self.birth()
        self.assertEqual(self.device["identity_source"], ingestion.SOURCE_SPARKPLUG_ID)

    def test_a_failed_write_does_not_mark_the_row_as_written(self):
        """
        If the UPDATE raises, the cached row must keep its old value so the next birth retries.
        Mutating before the write would make a lost update look applied.
        """
        self.device = registered_device(status="OFFLINE")
        self.client.rpc.return_value.execute.side_effect = RuntimeError("supabase down")

        ingestion.process_dbirth(DEVICE_ID, GATEWAY_ID, FakePayload("Systems/TEMPERATURE"),
                                 None, group_id=GROUP)

        self.assertEqual(self.device["status"], "OFFLINE")


class TestCounters(DBirthDedupTestCase):

    def test_a_skipped_write_is_counted_separately_from_a_real_one(self):
        self.device = registered_device(status="OFFLINE")
        self.birth()     # writes
        self.birth()     # skipped

        snapshot = ingestion.counter_snapshot()
        self.assertEqual(snapshot.get("device_state_writes"), 1)
        self.assertEqual(snapshot.get("device_state_writes_skipped"), 1)


class TestHeartbeatStillWritesEveryTime(unittest.TestCase):
    """
    The deliberate NON-deduplication. `last_heartbeat` has to move on every heartbeat because
    public.gateway_status derives staleness from it at read time. archived migration 0005 keeps these out
    of the audit trail by subtracting `last_heartbeat` before comparing; the daemon's job is only
    to tell a transition from a routine beat IN THE LOG.
    """

    def setUp(self):
        self._real_client = ingestion.supabase_client
        self.client = MagicMock()
        ingestion.supabase_client = self.client

        ingestion._gateway_cache.clear()
        ingestion._unknown_gateway_warned.clear()
        registry.reset()

        self.gateway = {
            "id": "gateway-uuid",
            "name": "Sim_Gateway_Cell1_Machining",
            "sparkplug_id": GATEWAY_ID,
            "sparkplug_group": GROUP,
            "status": "ONLINE",
        }

        self._real_resolve = ingestion.resolve_gateway
        ingestion.resolve_gateway = lambda wire_id, group_id=None: self.gateway
        self._real_aliases = ingestion.register_birth_aliases
        ingestion.register_birth_aliases = lambda *a, **k: 0

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        ingestion.resolve_gateway = self._real_resolve
        ingestion.register_birth_aliases = self._real_aliases

    def heartbeat(self, msg_type="NDATA"):
        ingestion.process_node_message(GATEWAY_ID, msg_type, FakePayload(), group_id=GROUP)

    def gateway_updates(self):
        """
        The ingest_record_gateway_health() calls, flattened into the column view.

        `last_heartbeat` is the parameter `p_heartbeat_at`; it is still sent on every single
        heartbeat, which is the property this class exists to protect -- gateway_status derives
        staleness from it at read time, so a suppressed write reports a live gateway as STALE.
        """
        out = []
        for c in self.client.rpc.call_args_list:
            if not c.args or c.args[0] != "ingest_record_gateway_health":
                continue
            params = c.args[1]
            flat = {"status": params["p_status"], "last_heartbeat": params["p_heartbeat_at"]}
            flat.update(params.get("p_health") or {})
            out.append(flat)
        return out

    def test_every_heartbeat_writes_last_heartbeat(self):
        self.heartbeat()
        self.heartbeat()
        self.heartbeat()

        updates = self.gateway_updates()
        self.assertEqual(len(updates), 3, "a heartbeat write was suppressed; gateway_status "
                                          "derives staleness from last_heartbeat and would "
                                          "report a live gateway as STALE")
        for payload in updates:
            self.assertIn("last_heartbeat", payload)

    def test_status_is_always_written_alongside(self):
        self.heartbeat()
        self.assertEqual(self.gateway_updates()[0]["status"], "ONLINE")

    def test_a_real_transition_is_counted(self):
        self.heartbeat("NDATA")            # ONLINE, no transition
        self.heartbeat("NDEATH")           # ONLINE -> OFFLINE

        snapshot = ingestion.counter_snapshot()
        self.assertEqual(snapshot.get("gateway_heartbeats"), 2)
        self.assertEqual(snapshot.get("gateway_status_transitions"), 1)

    def test_routine_beats_are_not_counted_as_transitions(self):
        self.heartbeat()
        self.heartbeat()
        self.heartbeat()

        snapshot = ingestion.counter_snapshot()
        self.assertEqual(snapshot.get("gateway_heartbeats"), 3)
        self.assertEqual(0, snapshot["gateway_status_transitions"])

    def test_cached_status_tracks_the_write(self):
        """
        Without this the same transition is re-reported on every heartbeat inside the cache TTL,
        turning a one-off operational event into a repeating log line.
        """
        self.heartbeat("NDEATH")
        self.assertEqual(self.gateway["status"], "OFFLINE")

        self.heartbeat("NDEATH")
        snapshot = ingestion.counter_snapshot()
        self.assertEqual(snapshot.get("gateway_status_transitions"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
