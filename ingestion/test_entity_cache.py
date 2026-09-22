"""
Unit tests for TTLCache -- the bounded LRU that replaced the unbounded resolution dicts (#23).

WHAT WAS WRONG. `_device_cache` and `_gateway_cache` had a TTL and no size limit, and expiry was
checked only on READ -- so an entry nobody looks at again is never evicted however stale it is. Any
publisher emitting varied device ids therefore grew both dicts forever: a misconfigured gateway
cycling ids, a fault loop, or an enumeration attempt against the broker. On Kubernetes that ends in
an OOMKill and a restart loop, which also drops the in-memory alias table and triggers a rebirth
storm. The same exposure had already been recognised and closed for the alias table
(`MAX_ALIASES_PER_NODE`, "it is fed by whatever the broker delivers"); these two caches are fed by
exactly the same source and were missed.

THE TESTS THAT MATTER MOST HERE ARE NOT THE EVICTION ONES. Bounding a cache is easy; bounding it
without breaking two contracts that nothing else in the file states out loud is the work:

  1. THE CACHED ROW IS MUTATED IN PLACE. process_dbirth() does `device.update(...)` and
     record_declared_metrics() does `device["last_birth_metrics"] = ...` on the object
     resolve_device() cached, precisely so the next lookup inside the TTL sees the new state and
     does not re-detect the same change. A cache returning copies breaks that SILENTLY -- the
     symptom is a duplicate UPDATE and a duplicate digital_thread row on every rebirth, not an
     error anyone would trace back to here.
  2. `None` IS A VALUE, NOT AN ABSENCE. The negative entry -- "this wire id resolved to nothing" --
     is what stops an unregistered device costing a directory round trip per message. A `get`
     returning None for both cases would quietly disable negative caching.

Same stubbing approach as test_gateway_binding.py: the daemon's heavy imports are replaced before
ingestion.py is loaded, since none of them are reachable from the code under test.
"""
import os
import sys
import time
import types
import unittest

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

TTLCache = ingestion.TTLCache


def cache(maxsize=3, ttl=60, name="test"):
    return TTLCache(maxsize, ttl, name)


class CapacityTest(unittest.TestCase):
    """The bound the issue exists for."""

    def test_the_cache_never_exceeds_its_capacity(self):
        c = cache(maxsize=3)
        for i in range(3 + 50):
            c.set("wire-%d" % i, {"n": i})
        self.assertEqual(len(c), 3)

    def test_the_oldest_untouched_entry_is_what_goes(self):
        c = cache(maxsize=3)
        for key in ("a", "b", "c"):
            c.set(key, key)
        c.set("d", "d")

        self.assertNotIn("a", c)
        for key in ("b", "c", "d"):
            self.assertIn(key, c)

    def test_reading_an_entry_saves_it_from_the_next_eviction(self):
        """The LRU half. Without move_to_end this is a FIFO, which evicts entries in use."""
        c = cache(maxsize=3)
        for key in ("a", "b", "c"):
            c.set(key, key)

        c.get("a")      # `a` is now the most recently used, `b` the least
        c.set("d", "d")

        self.assertIn("a", c)
        self.assertNotIn("b", c)

    def test_refreshing_an_existing_key_evicts_nothing(self):
        """Only a NEW key can grow the cache -- the distinction register_aliases() draws too."""
        c = cache(maxsize=3)
        for key in ("a", "b", "c"):
            c.set(key, key)
        c.set("a", "a-again")

        self.assertEqual(len(c), 3)
        self.assertEqual(c.get("a"), (True, "a-again"))
        self.assertIn("b", c)

    def test_evictions_are_counted_so_hitting_the_cap_is_observable(self):
        """
        A cache silently at its bound is a cache dropping entries nobody asked about. The counter
        is exported as aber_ingestion_cache_evictions_total; non-zero is the interesting case.
        """
        c = cache(maxsize=3)
        for i in range(3):
            c.set(i, i)
        self.assertEqual(c.evictions, 0)

        for i in range(3, 8):
            c.set(i, i)
        self.assertEqual(c.evictions, 5)

    def test_the_cap_is_environment_overridable_and_declared_as_a_constant(self):
        # Mirrors MAX_ALIASES_PER_NODE, which is the precedent this was written from.
        self.assertIsInstance(ingestion.MAX_ENTITIES_PER_CACHE, int)
        self.assertGreater(ingestion.MAX_ENTITIES_PER_CACHE, 0)
        for c in (ingestion._device_cache, ingestion._gateway_cache, ingestion._schema_cache):
            self.assertEqual(c.maxsize, ingestion.MAX_ENTITIES_PER_CACHE)


class InPlaceMutationTest(unittest.TestCase):
    """
    THE CONTRACT AN LRU IS MOST LIKELY TO BREAK, and the one whose failure looks like something
    else entirely. See the module docstring.
    """

    def test_get_returns_the_stored_object_not_a_copy(self):
        c = cache()
        row = {"status": "OFFLINE"}
        c.set("dev", row)

        _, got = c.get("dev")
        self.assertIs(got, row)

    def test_a_mutation_through_one_reader_is_visible_to_the_next(self):
        """
        The DBIRTH path in miniature: resolve, mutate in place, resolve again inside the TTL. The
        second read must see ONLINE, or process_dbirth() re-detects the same transition and writes
        the same UPDATE -- once per rebirth, forever.
        """
        c = cache()
        c.set("dev", {"status": "OFFLINE", "first_dbirth_at": None})

        _, first = c.get("dev")
        first.update({"status": "ONLINE"})

        _, second = c.get("dev")
        self.assertEqual(second["status"], "ONLINE")

    def test_a_mutation_survives_the_entry_being_moved_by_the_lru(self):
        """Eviction bookkeeping must not rebind the value. `move_to_end` reorders; it must not copy."""
        c = cache(maxsize=3)
        row = {"n": 1}
        c.set("dev", row)
        c.set("other", {})
        c.get("dev")           # move_to_end
        row["n"] = 2

        self.assertEqual(c.get("dev"), (True, {"n": 2}))
        self.assertIs(c.get("dev")[1], row)


class NegativeEntryTest(unittest.TestCase):
    """`None` is a cached answer, and telling it from a miss is the whole point of `(hit, value)`."""

    def test_a_cached_none_reports_as_a_hit(self):
        c = cache()
        c.set("ghost", None)
        self.assertEqual(c.get("ghost"), (True, None))

    def test_an_absent_key_reports_as_a_miss(self):
        self.assertEqual(cache().get("never-seen"), (False, None))

    def test_a_negative_entry_occupies_a_slot_like_any_other(self):
        """
        It has to. Negative entries are the ones an unregistered publisher can create at will, so a
        cache that did not count them against its bound would not be bounded at all.
        """
        c = cache(maxsize=3)
        for i in range(5):
            c.set(i, None)
        self.assertEqual(len(c), 3)


class ExpiryTest(unittest.TestCase):
    def test_an_expired_entry_is_a_miss(self):
        c = cache(ttl=0.05)
        c.set("dev", {"n": 1})
        time.sleep(0.06)
        self.assertEqual(c.get("dev"), (False, None))

    def test_an_expired_entry_is_dropped_rather_than_left_to_age(self):
        """It can never be a hit again, so holding it would spend a slot on a known-dead key."""
        c = cache(ttl=0.05)
        c.set("dev", {"n": 1})
        time.sleep(0.06)
        c.get("dev")
        self.assertEqual(len(c), 0)

    def test_expiry_alone_would_not_have_bounded_anything(self):
        """
        THE BUG, STATED AS A TEST. Fill past the cap with entries and never read them back. Under
        the old dicts every one of these is expired and every one is still resident, because expiry
        is only evaluated on read. The capacity bound is what actually removes them -- and because
        an entry nobody reads is by definition the least recently used, LRU removes exactly the
        stale ones first.
        """
        c = cache(maxsize=10, ttl=0.01)
        for i in range(1000):
            c.set("churn-%d" % i, None)
        self.assertLessEqual(len(c), 10)


class ThreadSafetyTest(unittest.TestCase):
    """
    Locked now, mandatory later. These caches are read from the paho callback thread today, so
    there is one reader; the worker-queue change would add a second, and an OrderedDict resized
    under `move_to_end` from two threads is a corrupted mapping rather than a stale read.
    """

    def test_concurrent_writers_leave_a_consistent_cache(self):
        import threading

        c = cache(maxsize=50)
        errors = []

        def hammer(offset):
            try:
                for i in range(500):
                    c.set("k-%d-%d" % (offset, i), {"i": i})
                    c.get("k-%d-%d" % (offset, i // 2))
            except Exception as e:      # noqa: BLE001 - the point is that nothing escapes
                errors.append(e)

        threads = [threading.Thread(target=hammer, args=(n,)) for n in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        self.assertLessEqual(len(c), 50)

    def test_every_entity_cache_carries_its_own_lock(self):
        for c in (ingestion._device_cache, ingestion._gateway_cache, ingestion._schema_cache):
            self.assertIsNotNone(getattr(c, "_lock", None))


class PopAndClearTest(unittest.TestCase):
    """The two operations the daemon and the existing suites already rely on."""

    def test_pop_removes_and_returns_the_value(self):
        # process_dbirth() pops on re-quarantine so the next resolve re-reads the row.
        c = cache()
        c.set("dev", {"n": 1})
        self.assertEqual(c.pop("dev"), {"n": 1})
        self.assertEqual(len(c), 0)

    def test_pop_of_an_absent_key_returns_the_default(self):
        self.assertIsNone(cache().pop("never-seen", None))

    def test_clear_empties_the_cache(self):
        # Four existing suites call .clear() in setUp; the acceptance criteria require them to
        # pass unchanged, which means this signature is part of the contract.
        c = cache()
        c.set("a", 1)
        c.clear()
        self.assertEqual(len(c), 0)


class CallSiteTest(unittest.TestCase):
    """The daemon's own caches are the bounded kind, not dicts that merely look similar."""

    def test_the_resolution_caches_are_all_bounded(self):
        for name in ("_device_cache", "_gateway_cache", "_schema_cache"):
            with self.subTest(cache=name):
                self.assertIsInstance(getattr(ingestion, name), TTLCache)

    def test_the_two_wire_keyed_caches_share_the_row_ttl(self):
        self.assertEqual(ingestion._device_cache.ttl, ingestion.CACHE_TTL_SECONDS)
        self.assertEqual(ingestion._gateway_cache.ttl, ingestion.CACHE_TTL_SECONDS)

    def test_the_schema_cache_keeps_its_own_longer_ttl(self):
        """
        It answers a different question -- what a device is DECLARED to model, which changes when
        an engineer rebinds a schema, not when a machine publishes. Bounding it must not quietly
        shorten it to the 5-second row TTL.
        """
        self.assertEqual(ingestion._schema_cache.ttl, ingestion.SCHEMA_CACHE_TTL_SECONDS)
        self.assertGreater(ingestion.SCHEMA_CACHE_TTL_SECONDS, ingestion.CACHE_TTL_SECONDS)

    def test_each_cache_is_named_for_its_metric_label(self):
        # The names become aber_ingestion_cache_entries{cache="..."}, so they have to be distinct.
        names = [c.name for c in
                 (ingestion._device_cache, ingestion._gateway_cache, ingestion._schema_cache)]
        self.assertEqual(sorted(names), ["device", "gateway", "schema"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
