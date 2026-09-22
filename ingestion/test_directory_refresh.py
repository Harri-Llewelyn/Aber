"""
The directory refresher: one request per table per pass, instead of one per entity per cache TTL.

WHAT WAS WRONG. resolve_device() and _resolve_gateway_row() cache for CACHE_TTL_SECONDS (5s), so
every device cost a PostgREST round trip on the callback thread every five seconds: with N devices
that is N/5 lookups a second, each one occupying the thread every other device shares. The write
was measured at about 2.5ms; a directory lookup is longer than that. The refresher reads the whole
directory in one request per table and re-fills both caches, so the hot path misses only for an id
the directory does not hold.

WHAT THIS SUITE PINS. The request count is independent of the fleet size; the keys and identity
sources are the ones the per-entity path would have produced (so nothing downstream can tell the
difference); a failed pass changes nothing; and the thread is off when asked to be.

Same stubbing approach as the sibling suites: the daemon's heavy imports are replaced before
ingestion.py is loaded.
"""
import os
import sys
import threading
import time
import types
import unittest
from types import SimpleNamespace

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

GROUP = "Aber"


def device(n, **extra):
    row = {
        "id": "20000000-0000-4000-8000-%012d" % n,
        "name": "Device %d" % n,
        "sparkplug_id": "dev" + ("%021x" % n),
        "reported_identity": None,
        "gateway_id": None,
        "is_quarantined": False,
        "status": "ONLINE",
        "conformance_policy": "audit",
    }
    row.update(extra)
    return row


def gateway(n, **extra):
    row = {
        "id": "30000000-0000-4000-8000-%012d" % n,
        "name": "Gateway %d" % n,
        "sparkplug_id": "gwy" + ("%021x" % n),
        "sparkplug_group": GROUP,
        "status": "ONLINE",
        "is_archived": False,
    }
    row.update(extra)
    return row


class FakeQuery:
    """The four PostgREST builder calls the daemon uses: select, eq, range, execute."""

    def __init__(self, store, table):
        self.store = store
        self.table = table
        self.filters = []
        self.window = None

    def select(self, columns):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def in_(self, column, values):
        self.filters.append((column, tuple(values)))
        return self

    def range(self, start, end):
        self.window = (start, end)
        return self

    def execute(self):
        if self.store.failing:
            raise RuntimeError("PostgREST unavailable")
        self.store.calls.append((self.table, self.window, tuple(self.filters)))
        rows = self.store.rows.get(self.table, [])
        for column, value in self.filters:
            rows = [r for r in rows if r.get(column) == value]
        if self.window is not None:
            start, end = self.window
            rows = rows[start:end + 1]
        return SimpleNamespace(data=[dict(r) for r in rows])


class FakeSupabase:
    def __init__(self, devices=(), gateways=()):
        self.rows = {"devices": list(devices), "gateways": list(gateways)}
        self.calls = []
        self.failing = False

    def table(self, name):
        return FakeQuery(self, name)

    def requests_for(self, table):
        return [c for c in self.calls if c[0] == table]


class RefreshTestCase(unittest.TestCase):

    def setUp(self):
        ingestion._device_cache.clear()
        ingestion._gateway_cache.clear()
        self._real = {
            "supabase_client": ingestion.supabase_client,
            "DIRECTORY_PAGE_SIZE": ingestion.DIRECTORY_PAGE_SIZE,
            "DIRECTORY_REFRESH_SECONDS": ingestion.DIRECTORY_REFRESH_SECONDS,
        }

    def tearDown(self):
        for name, value in self._real.items():
            setattr(ingestion, name, value)
        ingestion._device_cache.clear()
        ingestion._gateway_cache.clear()

    def use(self, fake):
        ingestion.supabase_client = fake
        return fake


class TestRequestCount(RefreshTestCase):

    def test_one_request_per_table_regardless_of_fleet_size(self):
        """The property that makes the thread worth having: 300 devices, two requests."""
        fake = self.use(FakeSupabase([device(n) for n in range(300)], [gateway(n) for n in range(20)]))
        counts = ingestion.refresh_directory_caches()
        self.assertEqual(counts, (300, 20))
        self.assertEqual(len(fake.requests_for("devices")), 1)
        self.assertEqual(len(fake.requests_for("gateways")), 1)

    def test_every_device_then_resolves_without_a_request(self):
        fake = self.use(FakeSupabase([device(n) for n in range(300)]))
        ingestion.refresh_directory_caches()
        before = len(fake.calls)
        for n in range(300):
            row = ingestion.resolve_device(device(n)["sparkplug_id"])
            self.assertEqual(row["id"], device(n)["id"])
        self.assertEqual(len(fake.calls), before)

    def test_every_gateway_then_resolves_without_a_request(self):
        fake = self.use(FakeSupabase(gateways=[gateway(n) for n in range(20)]))
        ingestion.refresh_directory_caches()
        before = len(fake.calls)
        for n in range(20):
            row = ingestion.resolve_gateway(gateway(n)["sparkplug_id"], GROUP)
            self.assertEqual(row["id"], gateway(n)["id"])
        self.assertEqual(len(fake.calls), before)

    def test_a_fleet_larger_than_a_page_arrives_whole(self):
        """PostgREST caps a response at max-rows (1000 by default); the pass pages past it."""
        ingestion.DIRECTORY_PAGE_SIZE = 100
        fake = self.use(FakeSupabase([device(n) for n in range(250)]))
        counts = ingestion.refresh_directory_caches()
        self.assertEqual(counts[0], 250)
        self.assertEqual([c[1] for c in fake.requests_for("devices")],
                         [(0, 99), (100, 199), (200, 299)])

    def test_an_exact_page_stops_after_one_short_page(self):
        ingestion.DIRECTORY_PAGE_SIZE = 100
        fake = self.use(FakeSupabase([device(n) for n in range(100)]))
        ingestion.refresh_directory_caches()
        self.assertEqual(len(fake.requests_for("devices")), 2)

    def test_an_unknown_id_still_takes_the_per_entity_path(self):
        """The pass fills positive entries only; an id the directory lacks costs what it always did."""
        fake = self.use(FakeSupabase([device(1)]))
        ingestion.refresh_directory_caches()
        before = len(fake.calls)
        self.assertIsNone(ingestion.resolve_device("dev" + "f" * 21))
        self.assertGreater(len(fake.calls), before)


class TestKeysAndSources(RefreshTestCase):

    def test_a_sparkplug_id_entry_carries_the_sparkplug_id_source(self):
        self.use(FakeSupabase([device(1)]))
        ingestion.refresh_directory_caches()
        row = ingestion.resolve_device(device(1)["sparkplug_id"])
        self.assertEqual(row["_identity_source"], ingestion.SOURCE_SPARKPLUG_ID)

    def test_a_reported_identity_resolves_with_its_own_source(self):
        """A third-party device's factory id: the per-entity path would say reported_identity."""
        self.use(FakeSupabase([device(1, reported_identity="PLC-7")]))
        ingestion.refresh_directory_caches()
        row = ingestion.resolve_device("PLC-7")
        self.assertEqual(row["id"], device(1)["id"])
        self.assertEqual(row["_identity_source"], ingestion.SOURCE_REPORTED_IDENTITY)

    def test_sparkplug_id_wins_over_another_devices_reported_identity(self):
        """resolve_device() tries sparkplug_id first; a pre-filled cache must agree with it."""
        a = device(1)
        b = device(2, reported_identity=a["sparkplug_id"])
        self.use(FakeSupabase([b, a]))
        ingestion.refresh_directory_caches()
        row = ingestion.resolve_device(a["sparkplug_id"])
        self.assertEqual(row["id"], a["id"])
        self.assertEqual(row["_identity_source"], ingestion.SOURCE_SPARKPLUG_ID)

    def test_each_key_holds_its_own_row_object(self):
        """
        The DBIRTH path mutates the cached row in place. Two keys sharing one dict would let a
        mutation through one wire id change the identity source reported through the other.
        """
        self.use(FakeSupabase([device(1, reported_identity="PLC-7")]))
        ingestion.refresh_directory_caches()
        by_sid = ingestion.resolve_device(device(1)["sparkplug_id"])
        by_rid = ingestion.resolve_device("PLC-7")
        self.assertIsNot(by_sid, by_rid)

    def test_gateways_are_keyed_by_group_and_node(self):
        """The same (group, node) pair _resolve_gateway_row() keys on; another group is a miss."""
        fake = self.use(FakeSupabase(gateways=[gateway(1)]))
        ingestion.refresh_directory_caches()
        before = len(fake.calls)
        ingestion.resolve_gateway(gateway(1)["sparkplug_id"], GROUP)
        self.assertEqual(len(fake.calls), before)
        ingestion.resolve_gateway(gateway(1)["sparkplug_id"], "Other-Group")
        self.assertGreater(len(fake.calls), before)

    def test_a_gateway_without_a_group_is_keyed_on_the_empty_group(self):
        fake = self.use(FakeSupabase(gateways=[gateway(1, sparkplug_group=None)]))
        ingestion.refresh_directory_caches()
        before = len(fake.calls)
        ingestion.resolve_gateway(gateway(1)["sparkplug_id"], None)
        self.assertEqual(len(fake.calls), before)


class TestStaleness(RefreshTestCase):

    def test_a_pass_replaces_a_stale_row(self):
        """Approval in the dashboard reaches the hot path on the next pass, as the TTL let it."""
        fake = self.use(FakeSupabase([device(1, is_quarantined=True)]))
        ingestion.refresh_directory_caches()
        self.assertTrue(ingestion.resolve_device(device(1)["sparkplug_id"])["is_quarantined"])
        fake.rows["devices"] = [device(1, is_quarantined=False)]
        ingestion.refresh_directory_caches()
        self.assertFalse(ingestion.resolve_device(device(1)["sparkplug_id"])["is_quarantined"])

    def test_a_failed_pass_leaves_the_cache_alone(self):
        """Entries expire on their TTL and the per-entity path takes over; nothing is evicted early."""
        fake = self.use(FakeSupabase([device(1)]))
        ingestion.refresh_directory_caches()
        fake.failing = True
        with self.assertRaises(RuntimeError):
            ingestion.refresh_directory_caches()
        self.assertEqual(len(ingestion._device_cache), 1)
        self.assertEqual(ingestion.resolve_device(device(1)["sparkplug_id"])["id"], device(1)["id"])

    def test_the_period_matches_the_cache_ttl_by_default(self):
        """Longer, and an entry would expire between passes; the hot path would miss for the gap."""
        self.assertLessEqual(ingestion.DIRECTORY_REFRESH_SECONDS, ingestion.CACHE_TTL_SECONDS)


class TestThread(RefreshTestCase):

    def running(self):
        return [t for t in threading.enumerate() if t.name == "directory-refresher"]

    def test_zero_disables_the_thread(self):
        ingestion.DIRECTORY_REFRESH_SECONDS = 0
        self.use(FakeSupabase([device(1)]))
        before = len(self.running())
        ingestion.start_directory_refresher()
        self.assertEqual(len(self.running()), before)

    def test_no_directory_client_starts_no_thread(self):
        ingestion.supabase_client = None
        before = len(self.running())
        ingestion.start_directory_refresher()
        self.assertEqual(len(self.running()), before)

    def test_the_thread_warms_the_cache_and_survives_a_failure(self):
        ingestion.DIRECTORY_REFRESH_SECONDS = 0.05
        fake = self.use(FakeSupabase([device(1)]))
        fake.failing = True
        ingestion.start_directory_refresher()
        time.sleep(0.15)  # at least one pass has raised inside the thread by now
        fake.failing = False
        deadline = time.time() + 2
        while time.time() < deadline and len(ingestion._device_cache) == 0:
            time.sleep(0.02)
        self.assertEqual(len(ingestion._device_cache), 1)
        self.assertTrue(self.running())


if __name__ == "__main__":
    unittest.main(verbosity=2)
