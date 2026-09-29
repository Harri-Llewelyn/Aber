"""
Unit tests for the ingestion daemon's birth-metric observation
(`extract_declared_metrics` / `record_declared_metrics`), its Sparkplug B alias resolution, the
NCMD rebirth request path, the device liveness watchdog, and what DDATA from an OFFLINE device
does -- all in ingestion.py.

Unlike the edge-function suites, which mirror TypeScript logic in Python, these exercise the
shipped functions directly -- there is no second copy to drift from. To do that without the
daemon's runtime, the heavy imports at the top of ingestion.py (protobuf, MQTT, psycopg2) are
stubbed before it is loaded: none of them are reachable from the code under test, and requiring
a compiled sparkplug_b_pb2 would tie a pure-logic test to `protoc` being installed.

`build_rebirth_payload()` is the one function that genuinely needs a protobuf Payload, so the
rebirth suite swaps in a functional fake for the duration of its own tests rather than enriching
the module-level stub, which is shared with three other suites through sys.modules.
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
    # Also bind onto the parent package, so `import paho.mqtt.client as mqtt` resolves by
    # attribute access rather than relying on the sys.modules fallback.
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


class FakeMetric:
    """
    A Sparkplug metric as the code under test sees it: a name, an optional integer alias, and
    protobuf's `HasField`. A metric with `alias=None` has no alias field at all, which is what
    every metric in a non-optimised payload looks like.
    """
    def __init__(self, name, alias=None, string_value=None):
        self.name = name
        self.alias = alias if alias is not None else 0
        self.string_value = string_value
        self._present = set()
        if alias is not None:
            self._present.add("alias")
        if string_value is not None:
            self._present.add("string_value")

    def HasField(self, field):
        return field in self._present


class FakePayload:
    def __init__(self, *names):
        self.metrics = [FakeMetric(n) for n in names]


class AliasPayload:
    """A birth payload declaring `{alias: name}`, or a DATA payload carrying bare aliases."""
    def __init__(self, declarations=None, bare_aliases=(), named=()):
        self.metrics = []
        for alias, name in (declarations or {}).items():
            self.metrics.append(FakeMetric(name, alias=alias))
        for alias in bare_aliases:
            self.metrics.append(FakeMetric("", alias=alias))
        for name in named:
            self.metrics.append(FakeMetric(name))


def reset_module_state():
    """
    Clear every module-level cache the new features keep, so tests cannot leak into each other.

    These are process-wide dicts on a daemon that normally runs forever, so a suite that did not
    reset them would pass or fail depending on execution order.
    """
    ingestion._alias_map.clear()
    ingestion._rebirth_requested.clear()
    ingestion._device_seen.clear()
    ingestion._device_offline.clear()
    ingestion._node_epoch.clear()
    ingestion._last_seq.clear()


class TestExtractDeclaredMetrics(unittest.TestCase):

    def test_returns_sorted_unique_names(self):
        declared = ingestion.extract_declared_metrics(
            FakePayload("temperature", "availability", "temperature")
        )
        self.assertEqual(declared, ["availability", "temperature"])

    def test_identity_metrics_are_excluded(self):
        """Asset_ID/Asset_Name carry identity, not something a schema should model."""
        declared = ingestion.extract_declared_metrics(
            FakePayload("Asset_ID", "Asset_Name", "vibration")
        )
        self.assertEqual(declared, ["vibration"])

    def test_valueless_metrics_are_still_declared(self):
        """
        The divergence from store_birth_parameters, which skips metrics carrying no value
        because it is recording parameter values. A metric declared with no value is exactly
        the kind of thing a schema should account for, so it must count here.
        """
        declared = ingestion.extract_declared_metrics(FakePayload("no_value_yet"))
        self.assertEqual(declared, ["no_value_yet"])

    def test_unnamed_metrics_are_ignored(self):
        declared = ingestion.extract_declared_metrics(FakePayload("", "temperature"))
        self.assertEqual(declared, ["temperature"])

    def test_birth_declaring_nothing_yields_empty_list(self):
        """
        Empty list, not None: "a birth was observed and it declared nothing" is a different
        finding from "no birth has ever been observed", which is NULL in the column.
        """
        self.assertEqual(ingestion.extract_declared_metrics(FakePayload("Asset_ID")), [])


class TestRecordDeclaredMetrics(unittest.TestCase):

    def setUp(self):
        self._real_client = ingestion.supabase_client
        self.client = MagicMock()
        ingestion.supabase_client = self.client

    def tearDown(self):
        ingestion.supabase_client = self._real_client

    def _update_payloads(self):
        """
        The parameters of each ingest_record_declared_metrics() call.

        Reads the RPC rather than a table UPDATE because the write goes through a gate now
        (Machine Identities in supabase/README.md, archived migration 0047). The property under test is unchanged -- one write per
        real change to the declared set -- but it is asserted on the call the daemon now makes.
        """
        return [
            c.args[1] for c in self.client.rpc.call_args_list
            if c.args and c.args[0] == "ingest_record_declared_metrics"
        ]

    def test_writes_when_the_declared_set_is_new(self):
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": None}
        ingestion.record_declared_metrics(device, FakePayload("temperature", "vibration"))

        payloads = self._update_payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["p_metrics"], ["temperature", "vibration"])
        self.assertIn("p_observed_at", payloads[0])

    def test_no_write_when_the_declared_set_is_unchanged(self):
        """
        The point of the change check: log_digital_thread_event() fires on every UPDATE to
        `devices`, so an unchanged rewrite on each rebirth would append an audit row every
        time to a table that is deliberately append-only.
        """
        device = {"id": "dev-uuid", "name": "Robot_01",
                  "last_birth_metrics": ["temperature", "vibration"]}
        ingestion.record_declared_metrics(device, FakePayload("vibration", "temperature"))
        self.assertEqual(self._update_payloads(), [])

    def test_write_when_a_metric_is_added(self):
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": ["temperature"]}
        ingestion.record_declared_metrics(device, FakePayload("temperature", "humidity"))

        payloads = self._update_payloads()
        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["p_metrics"], ["humidity", "temperature"])

    def test_write_when_a_metric_is_removed(self):
        device = {"id": "dev-uuid", "name": "Robot_01",
                  "last_birth_metrics": ["humidity", "temperature"]}
        ingestion.record_declared_metrics(device, FakePayload("temperature"))
        self.assertEqual(self._update_payloads()[0]["p_metrics"], ["temperature"])

    def test_cached_row_is_updated_in_place(self):
        """
        resolve_device caches the same dict, so the in-place update is what stops a second
        birth inside the cache TTL from re-detecting the same change and writing again.
        """
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": None}
        ingestion.record_declared_metrics(device, FakePayload("temperature"))
        self.assertEqual(device["last_birth_metrics"], ["temperature"])

        ingestion.record_declared_metrics(device, FakePayload("temperature"))
        self.assertEqual(len(self._update_payloads()), 1)

    def test_supabase_failure_does_not_propagate(self):
        """A failed write must not abort DBIRTH handling; the next birth retries."""
        self.client.rpc.side_effect = RuntimeError("supabase down")
        device = {"id": "dev-uuid", "name": "Robot_01", "last_birth_metrics": None}

        ingestion.record_declared_metrics(device, FakePayload("temperature"))

        # The row is left unchanged, so the write is retried rather than assumed applied.
        self.assertIsNone(device["last_birth_metrics"])


GROUP = "Aber"
NODE_A = "gwy" + "a" * 21
NODE_B = "gwy" + "b" * 21


class TestAliasRegistration(unittest.TestCase):
    """
    Sparkplug binds each metric name to an integer alias in a BIRTH and thereafter publishes DATA
    carrying the alias alone. Reading only `.name` therefore ingests NOTHING from an
    alias-optimised gateway -- with no error, which is what made this a silent data-loss path.
    """

    def setUp(self):
        reset_module_state()

    def test_birth_aliases_are_registered(self):
        stored = ingestion.register_birth_aliases(
            GROUP, NODE_A, AliasPayload({1: "Systems/TEMPERATURE", 2: "Axes/DISPLACEMENT"})
        )
        self.assertEqual(stored, 2)

    def test_alias_only_metric_resolves_to_its_birth_name(self):
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({7: "Systems/TEMPERATURE"}))
        metric = FakeMetric("", alias=7)
        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, metric), "Systems/TEMPERATURE"
        )

    def test_a_present_name_wins_over_the_map(self):
        """A DATA message may carry both; the name is authoritative and needs no lookup."""
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({7: "Stale/NAME"}))
        metric = FakeMetric("Systems/TEMPERATURE", alias=7)
        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, metric), "Systems/TEMPERATURE"
        )

    def test_unknown_alias_is_unresolvable(self):
        """None, not '' -- the caller has to tell 'no birth seen' from 'metric of no interest'."""
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "Systems/TEMPERATURE"}))
        self.assertIsNone(ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=99)))

    def test_metric_with_neither_name_nor_alias_is_unresolvable(self):
        self.assertIsNone(ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("")))

    def test_aliases_are_scoped_per_edge_node(self):
        """Alias 1 means different things on different nodes; one table would collide them."""
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "Systems/TEMPERATURE"}))
        ingestion.register_birth_aliases(GROUP, NODE_B, AliasPayload({1: "Axes/DISPLACEMENT"}))

        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=1)),
            "Systems/TEMPERATURE",
        )
        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_B, FakeMetric("", alias=1)),
            "Axes/DISPLACEMENT",
        )

    def test_aliases_are_scoped_per_group(self):
        """Two groups may run the same edge node id; Sprint 1 keeps their tables apart."""
        ingestion.register_birth_aliases("GroupOne", NODE_A, AliasPayload({1: "One/METRIC"}))
        ingestion.register_birth_aliases("GroupTwo", NODE_A, AliasPayload({1: "Two/METRIC"}))

        self.assertEqual(
            ingestion.resolve_metric_name("GroupOne", NODE_A, FakeMetric("", alias=1)),
            "One/METRIC",
        )
        self.assertEqual(
            ingestion.resolve_metric_name("GroupTwo", NODE_A, FakeMetric("", alias=1)),
            "Two/METRIC",
        )

    def test_device_data_resolves_an_alias_declared_by_the_node_birth(self):
        """
        The reason the table is keyed per NODE and not per device. Sparkplug scopes alias
        uniqueness to the whole edge node including its devices, so a device's DDATA may carry an
        alias that only the NBIRTH declared. A per-device table would miss it silently.
        """
        ingestion.register_birth_aliases(
            GROUP, NODE_A, AliasPayload({4: "Node/UPTIME"}), reset=True
        )
        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=4)), "Node/UPTIME"
        )

    def test_nbirth_resets_the_whole_node_table(self):
        """
        An NBIRTH invalidates every prior binding for the node and its devices. A gateway that
        renumbers its aliases must not have the old ones left behind to match against -- that
        would write real samples under the wrong metric name, which is worse than dropping them.
        """
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "Old/METRIC"}))
        ingestion.register_birth_aliases(
            GROUP, NODE_A, AliasPayload({2: "New/METRIC"}), reset=True
        )

        self.assertIsNone(ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=1)))
        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=2)), "New/METRIC"
        )

    def test_dbirth_merges_and_leaves_siblings_intact(self):
        """One device re-birthing must not wipe the aliases of the others on the same node."""
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "DeviceA/TEMP"}))
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({2: "DeviceB/TEMP"}))

        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=1)), "DeviceA/TEMP"
        )
        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=2)), "DeviceB/TEMP"
        )

    def test_a_rebirth_may_rebind_an_existing_alias(self):
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "First/NAME"}))
        ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "Second/NAME"}))
        self.assertEqual(
            ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=1)), "Second/NAME"
        )

    def test_metrics_without_an_alias_are_not_registered(self):
        """A named-only birth is the un-optimised case: nothing to bind, nothing to store."""
        stored = ingestion.register_birth_aliases(
            GROUP, NODE_A, AliasPayload(named=["Systems/TEMPERATURE"])
        )
        self.assertEqual(stored, 0)
        self.assertEqual(ingestion._alias_map[(GROUP, NODE_A)], {})

    def test_unnamed_birth_metrics_are_not_registered(self):
        """A birth metric with an alias but no name binds nothing and must not store an empty."""
        stored = ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload(bare_aliases=[3]))
        self.assertEqual(stored, 0)
        self.assertIsNone(ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=3)))

    def test_alias_table_is_capped(self):
        """
        The table is fed by whatever the broker delivers. A gateway looping births with fresh
        alias numbers would otherwise grow it without bound.
        """
        original = ingestion.MAX_ALIASES_PER_NODE
        ingestion.MAX_ALIASES_PER_NODE = 3
        try:
            ingestion.register_birth_aliases(
                GROUP, NODE_A, AliasPayload({n: "Metric/%d" % n for n in range(10)})
            )
            self.assertEqual(len(ingestion._alias_map[(GROUP, NODE_A)]), 3)
        finally:
            ingestion.MAX_ALIASES_PER_NODE = original

    def test_rebinding_is_allowed_at_the_cap(self):
        """The cap counts additions, so a full table can still be re-pointed by a rebirth."""
        original = ingestion.MAX_ALIASES_PER_NODE
        ingestion.MAX_ALIASES_PER_NODE = 2
        try:
            ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "A", 2: "B"}))
            ingestion.register_birth_aliases(GROUP, NODE_A, AliasPayload({1: "A_RENAMED"}))
            self.assertEqual(
                ingestion.resolve_metric_name(GROUP, NODE_A, FakeMetric("", alias=1)), "A_RENAMED"
            )
        finally:
            ingestion.MAX_ALIASES_PER_NODE = original


class FakeProtoMetric:
    def __init__(self):
        self.name = ""
        self.datatype = None
        self.boolean_value = None


class _FakeMetricList(list):
    def add(self):
        metric = FakeProtoMetric()
        self.append(metric)
        return metric


class FakeProtoPayload:
    """Just enough of the generated protobuf class for build_rebirth_payload()."""
    def __init__(self):
        self.timestamp = 0
        self.metrics = _FakeMetricList()

    def SerializeToString(self):
        parts = ["ts=%d" % self.timestamp]
        parts += ["%s|%s|%s" % (m.name, m.datatype, m.boolean_value) for m in self.metrics]
        return ";".join(parts).encode()


class TestRebirthRequests(unittest.TestCase):
    """
    The cold-start closure. The alias table is in-memory, so it is empty after every restart, and
    a stable device may not birth again for weeks -- without a way to ASK, an ingestion restart
    would silently stop recording every alias-optimised device on the plant.
    """

    def setUp(self):
        reset_module_state()
        self._real_pb2 = ingestion.sparkplug_b_pb2
        ingestion.sparkplug_b_pb2 = types.SimpleNamespace(Payload=FakeProtoPayload)
        self.client = MagicMock()

    def tearDown(self):
        ingestion.sparkplug_b_pb2 = self._real_pb2

    def _published(self):
        return self.client.publish.call_args_list

    def test_first_unknown_alias_publishes_a_rebirth(self):
        self.assertTrue(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))
        self.assertEqual(len(self._published()), 1)

    def test_rebirth_goes_to_the_nodes_ncmd_topic(self):
        ingestion.request_node_rebirth(self.client, GROUP, NODE_A)
        topic = self._published()[0].args[0]
        self.assertEqual(topic, "spBv1.0/%s/NCMD/%s" % (GROUP, NODE_A))

    def test_rebirth_payload_carries_the_control_metric(self):
        ingestion.request_node_rebirth(self.client, GROUP, NODE_A)
        body = self._published()[0].args[1].decode()
        self.assertIn("Node Control/Rebirth", body)
        self.assertIn("|11|True", body)  # Boolean datatype, value true

    def test_second_request_inside_the_window_is_suppressed(self):
        """
        The rate limit is the load-bearing half. A gateway that answers a rebirth by restarting
        would otherwise be asked once per message and held in a reboot loop by the very mechanism
        meant to recover it.
        """
        self.assertTrue(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))
        self.assertFalse(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))
        self.assertFalse(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))
        self.assertEqual(len(self._published()), 1)

    def test_request_is_allowed_again_after_the_window(self):
        ingestion.request_node_rebirth(self.client, GROUP, NODE_A)
        # Age the throttle rather than sleeping for the real five minutes.
        key = "%s/%s" % (GROUP, NODE_A)
        ingestion._rebirth_requested[key] -= ingestion.REBIRTH_REQUEST_INTERVAL_SECONDS + 1

        self.assertTrue(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))
        self.assertEqual(len(self._published()), 2)

    def test_each_node_has_its_own_budget(self):
        """One noisy gateway must not starve another of its recovery path."""
        self.assertTrue(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))
        self.assertTrue(ingestion.request_node_rebirth(self.client, GROUP, NODE_B))
        self.assertEqual(len(self._published()), 2)

    def test_each_group_has_its_own_budget(self):
        self.assertTrue(ingestion.request_node_rebirth(self.client, "GroupOne", NODE_A))
        self.assertTrue(ingestion.request_node_rebirth(self.client, "GroupTwo", NODE_A))
        self.assertEqual(len(self._published()), 2)

    def test_no_client_means_no_request(self):
        """Callers that hold no MQTT client (the unit suites, and DDEATH) must be a no-op."""
        self.assertFalse(ingestion.request_node_rebirth(None, GROUP, NODE_A))

    def test_no_node_means_no_request(self):
        self.assertFalse(ingestion.request_node_rebirth(self.client, GROUP, ""))

    def test_publish_failure_does_not_propagate(self):
        """A broker refusing the publish must not abort the DDATA that triggered it."""
        self.client.publish.side_effect = RuntimeError("broker gone")
        self.assertFalse(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))

    def test_publish_failure_still_consumes_the_budget(self):
        """
        Deliberate: a broker that refuses this publish will refuse the next one too, and retrying
        per message is exactly the flood the rate limit exists to prevent.
        """
        self.client.publish.side_effect = RuntimeError("broker gone")
        ingestion.request_node_rebirth(self.client, GROUP, NODE_A)
        self.client.publish.side_effect = None
        self.assertFalse(ingestion.request_node_rebirth(self.client, GROUP, NODE_A))


class TestDeviceLivenessWatchdog(unittest.TestCase):
    """
    A device that stops publishing writes nothing and emits no DDEATH, so without a watchdog it
    stays ONLINE forever. The hard constraint is that this must not become an audit-row generator:
    log_digital_thread_event() fires on every UPDATE to `devices`.
    """

    DEVICE = {"id": "dev-uuid-1", "name": "Robot_01", "sparkplug_id": "dev" + "1" * 21}
    OTHER = {"id": "dev-uuid-2", "name": "Robot_02", "sparkplug_id": "dev" + "2" * 21}

    def setUp(self):
        reset_module_state()
        self._real_client = ingestion.supabase_client
        self.client = MagicMock()
        ingestion.supabase_client = self.client

    def tearDown(self):
        ingestion.supabase_client = self._real_client
        reset_module_state()

    def _offline_calls(self):
        """
        The ingest_mark_device_offline() calls the sweep made.

        The write goes through a gate now (Machine Identities in supabase/README.md, archived migration 0047). The properties this
        class exists to protect are unchanged and still asserted below -- one write per quiet
        period, tracking retained on failure -- but the already-OFFLINE predicate that used to be
        a client-side `.eq("status", "ONLINE")` now lives in the gate, where a caller cannot
        forget it. That it holds is asserted by 0047's own self-check.
        """
        return [
            c for c in self.client.rpc.call_args_list
            if c.args and c.args[0] == "ingest_mark_device_offline"
        ]

    def test_a_device_never_seen_is_never_stale(self):
        """
        The property that makes a restart safe. An empty map is an absence of evidence, not
        evidence of absence -- seeding it from the database would mark a whole fleet OFFLINE on
        every restart, one audit row each, in an append-only table.
        """
        self.assertEqual(ingestion.stale_device_ids(now=10_000_000, timeout=60), [])
        self.assertEqual(ingestion.sweep_stale_devices(now=10_000_000, timeout=60), [])
        self.assertEqual(self._offline_calls(), [])

    def test_a_device_within_the_window_is_not_stale(self):
        ingestion.mark_device_seen(self.DEVICE)
        seen_at = ingestion._device_seen[self.DEVICE["id"]]["at"]
        self.assertEqual(ingestion.stale_device_ids(now=seen_at + 30, timeout=60), [])

    def test_a_quiet_device_becomes_stale(self):
        ingestion.mark_device_seen(self.DEVICE)
        seen_at = ingestion._device_seen[self.DEVICE["id"]]["at"]
        stale = ingestion.stale_device_ids(now=seen_at + 61, timeout=60)
        self.assertEqual(stale, [(self.DEVICE["id"], "Robot_01")])

    def test_sweep_marks_the_device_offline(self):
        ingestion.mark_device_seen(self.DEVICE)
        seen_at = ingestion._device_seen[self.DEVICE["id"]]["at"]

        written = ingestion.sweep_stale_devices(now=seen_at + 61, timeout=60)

        self.assertEqual(written, [self.DEVICE["id"]])
        calls = self._offline_calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[1], {"p_device_id": self.DEVICE["id"]})

    def test_the_sweep_goes_through_the_gate_that_carries_the_filter(self):
        """
        The database-side half of write-on-change. It used to be a client-side
        `.eq("status", "ONLINE")` on the UPDATE; it is now `IS DISTINCT FROM 'OFFLINE'` inside
        ingest_mark_device_offline(), so an already-OFFLINE row matches nothing and no audit row
        is appended -- and a future edit to this sweep cannot drop it by forgetting a filter.

        What is asserted here is that the sweep uses the gate at all. That the gate carries the
        predicate is asserted in SQL, by 0047's self-check, which calls it twice against the same
        device and fails if the second call moves a row.
        """
        ingestion.mark_device_seen(self.DEVICE)
        seen_at = ingestion._device_seen[self.DEVICE["id"]]["at"]
        ingestion.sweep_stale_devices(now=seen_at + 61, timeout=60)

        calls = self._offline_calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[1]["p_device_id"], self.DEVICE["id"])
        # The status is not a parameter: the gate pins OFFLINE, so no caller can send another.
        self.assertEqual(list(calls[0].args[1]), ["p_device_id"])

    def test_a_swept_device_is_not_written_twice(self):
        """
        The client-side half. Tracking is dropped after the flip, so a device is written once per
        quiet period rather than once per sweep tick -- which at a 30s interval would otherwise
        append two audit rows a minute, per device, forever.
        """
        ingestion.mark_device_seen(self.DEVICE)
        seen_at = ingestion._device_seen[self.DEVICE["id"]]["at"]

        ingestion.sweep_stale_devices(now=seen_at + 61, timeout=60)
        ingestion.sweep_stale_devices(now=seen_at + 200, timeout=60)
        ingestion.sweep_stale_devices(now=seen_at + 400, timeout=60)

        self.assertEqual(len(self._offline_calls()), 1)

    def test_a_device_that_comes_back_is_tracked_again(self):
        ingestion.mark_device_seen(self.DEVICE)
        seen_at = ingestion._device_seen[self.DEVICE["id"]]["at"]
        ingestion.sweep_stale_devices(now=seen_at + 61, timeout=60)

        ingestion.mark_device_seen(self.DEVICE)
        self.assertIn(self.DEVICE["id"], ingestion._device_seen)

    def test_only_quiet_devices_are_swept(self):
        ingestion.mark_device_seen(self.DEVICE)
        quiet_at = ingestion._device_seen[self.DEVICE["id"]]["at"]
        ingestion.mark_device_seen(self.OTHER)
        ingestion._device_seen[self.OTHER["id"]]["at"] = quiet_at + 60

        written = ingestion.sweep_stale_devices(now=quiet_at + 61, timeout=60)
        self.assertEqual(written, [self.DEVICE["id"]])

    def test_forget_stops_tracking(self):
        """What DDEATH does: an explicit death certificate is the authoritative answer."""
        ingestion.mark_device_seen(self.DEVICE)
        ingestion.forget_device_seen(self.DEVICE["id"])
        self.assertEqual(ingestion.stale_device_ids(now=10_000_000, timeout=60), [])

    def test_timeout_of_zero_disables_the_watchdog(self):
        ingestion.mark_device_seen(self.DEVICE)
        self.assertEqual(ingestion.stale_device_ids(now=10_000_000, timeout=0), [])
        self.assertEqual(ingestion.sweep_stale_devices(now=10_000_000, timeout=0), [])

    def test_a_failed_write_keeps_the_device_tracked(self):
        """
        Retried on the next sweep. A failed write that dropped the device would leave it ONLINE
        forever while the log claimed it had been handled.
        """
        self.client.rpc.return_value.execute.side_effect = RuntimeError("supabase down")
        ingestion.mark_device_seen(self.DEVICE)
        seen_at = ingestion._device_seen[self.DEVICE["id"]]["at"]

        written = ingestion.sweep_stale_devices(now=seen_at + 61, timeout=60)

        self.assertEqual(written, [])
        self.assertIn(self.DEVICE["id"], ingestion._device_seen)

    def test_no_supabase_client_is_a_no_op(self):
        ingestion.supabase_client = None
        ingestion.mark_device_seen(self.DEVICE)
        self.assertEqual(ingestion.sweep_stale_devices(now=10_000_000, timeout=60), [])

    def test_mark_device_seen_ignores_a_row_with_no_id(self):
        ingestion.mark_device_seen({"name": "no id"})
        ingestion.mark_device_seen(None)
        self.assertEqual(ingestion._device_seen, {})

    def test_label_falls_back_when_a_device_has_no_name(self):
        ingestion.mark_device_seen({"id": "x", "sparkplug_id": "dev" + "9" * 21})
        self.assertEqual(ingestion._device_seen["x"]["name"], "dev" + "9" * 21)


class TestADeviceThatPublishesAgain(unittest.TestCase):
    """
    DDATA from a device the directory holds OFFLINE. A watchdog timeout rests on silence alone, so
    the device's next DDATA sets it ONLINE again. Any other OFFLINE (a DDEATH, its node's birth or
    death since, a row this process has not seen born) is a device that has not been born, and gets
    a rebirth request instead. The data is stored either way.
    """

    WIRE = "dev" + "1" * 21

    def setUp(self):
        reset_module_state()
        self.device = {"id": "dev-uuid-1", "name": "Robot_01", "sparkplug_id": self.WIRE,
                       "is_quarantined": False, "status": "ONLINE"}
        self.gate_moved = True
        self.failing = set()
        self.client = MagicMock()
        self.client.rpc.side_effect = self._rpc
        self.mqtt = MagicMock()
        self._real = {}
        for name, value in (
            ("supabase_client", self.client),
            ("resolve_device", lambda wire_id, use_cache=True, include_archived=False: self.device),
            ("verify_gateway_binding", lambda *a, **k: None),
            ("device_modelled_constraints", lambda device_uuid: None),
            ("_writer", MagicMock()),
            ("sparkplug_b_pb2", types.SimpleNamespace(Payload=FakeProtoPayload)),
        ):
            self._real[name] = getattr(ingestion, name)
            setattr(ingestion, name, value)

    def tearDown(self):
        for name, value in self._real.items():
            setattr(ingestion, name, value)
        reset_module_state()

    def _rpc(self, name, params):
        call = MagicMock()
        if name in self.failing:
            call.execute.side_effect = RuntimeError("supabase down")
        else:
            moved = self.gate_moved if name == "ingest_mark_device_offline" else True
            call.execute.return_value = types.SimpleNamespace(data=moved)
        return call

    def birth(self, node=NODE_A):
        """What process_dbirth() leaves behind once its write has set the row ONLINE."""
        self.device["status"] = "ONLINE"
        ingestion.mark_device_seen(self.device, GROUP, node)

    def sweep(self):
        seen_at = ingestion._device_seen[self.device["id"]]["at"]
        ingestion.sweep_stale_devices(now=seen_at + 61, timeout=60)
        # The directory refresher's next pass.
        self.device["status"] = "OFFLINE"

    def ddeath(self):
        ingestion.process_ddeath(self.WIRE, NODE_A)
        self.device["status"] = "OFFLINE"

    def ddata(self, node=NODE_A):
        payload = types.SimpleNamespace(metrics=[FakeMetric("Systems/TEMPERATURE", string_value="ok")])
        ingestion.process_ddata(self.WIRE, node, payload, group_id=GROUP, client=self.mqtt)

    def online_writes(self):
        return [c.args[1] for c in self.client.rpc.call_args_list
                if c.args[0] == "ingest_set_device_state" and c.args[1]["p_status"] == "ONLINE"]

    def rebirths(self):
        return [c.args[0] for c in self.mqtt.publish.call_args_list]

    def tracked(self):
        return self.device["id"] in ingestion._device_seen

    def test_ddata_after_a_timeout_sets_the_device_online(self):
        self.birth()
        self.sweep()
        self.ddata()

        self.assertEqual(self.online_writes(), [{
            "p_device_id": self.device["id"], "p_status": "ONLINE",
            "p_identity_source": None, "p_first_dbirth_at": None,
        }])
        self.assertEqual(self.device["status"], "ONLINE")
        self.assertTrue(self.tracked())
        self.assertEqual(self.rebirths(), [], "a timed-out device needs no rebirth to be believed")

    def test_the_revival_is_written_once(self):
        """One audit row per quiet period, as for the timeout itself."""
        self.birth()
        self.sweep()
        self.ddata()
        self.ddata()
        self.assertEqual(len(self.online_writes()), 1)

    def test_a_revived_device_times_out_again(self):
        self.birth()
        self.sweep()
        self.ddata()
        self.sweep()
        offline = [c for c in self.client.rpc.call_args_list
                   if c.args[0] == "ingest_mark_device_offline"]
        self.assertEqual(len(offline), 2)

    def test_a_failed_revival_is_retried_by_the_next_ddata(self):
        self.birth()
        self.sweep()
        self.failing.add("ingest_set_device_state")
        self.ddata()
        self.assertEqual(self.device["status"], "OFFLINE")
        self.assertFalse(self.tracked())

        self.failing.clear()
        self.ddata()
        self.assertEqual(len(self.online_writes()), 2)
        self.assertEqual(self.device["status"], "ONLINE")
        self.assertEqual(self.rebirths(), [])

    def test_a_stale_offline_row_after_a_revival_asks_for_nothing(self):
        """The refresher can replace the cached row with one read before the revival wrote."""
        self.birth()
        self.sweep()
        self.ddata()
        self.device["status"] = "OFFLINE"
        self.ddata()
        self.assertEqual(self.rebirths(), [])
        self.assertEqual(len(self.online_writes()), 1)

    def test_ddata_after_a_ddeath_requests_a_rebirth_and_stays_offline(self):
        self.birth()
        self.ddeath()
        self.ddata()

        self.assertEqual(self.online_writes(), [])
        self.assertEqual(self.rebirths(), ["spBv1.0/%s/NCMD/%s" % (GROUP, NODE_A)])
        self.assertFalse(self.tracked(), "already OFFLINE: nothing for the watchdog to sweep")

    def test_the_data_is_stored_while_the_device_waits_for_its_birth(self):
        self.birth()
        self.ddeath()
        self.ddata()
        self.assertEqual(ingestion._writer.submit.call_count, 1)

    def test_the_rebirth_request_is_rate_limited(self):
        self.birth()
        self.ddeath()
        for _ in range(3):
            self.ddata()
        self.assertEqual(len(self.rebirths()), 1)

    def test_a_stale_online_row_does_not_end_the_wait(self):
        """A row cached before the DDEATH wrote must not make the device look live."""
        self.birth()
        self.ddeath()
        self.ddata()
        self.device["status"] = "ONLINE"
        self.ddata()
        self.assertFalse(self.tracked())
        self.assertEqual(self.online_writes(), [])

    def test_a_birth_ends_the_wait(self):
        self.birth()
        self.ddeath()
        self.ddata()
        self.birth()
        self.ddata()
        self.assertTrue(self.tracked())
        self.assertEqual(len(self.rebirths()), 1)

    def test_a_node_death_before_the_timeout_requires_a_device_birth(self):
        """The usual way a node's devices go quiet: its NDEATH, and the watchdog 300s later."""
        self.birth()
        ingestion.end_device_births(GROUP, NODE_A)
        self.sweep()
        self.ddata()
        self.assertEqual(self.online_writes(), [])
        self.assertEqual(len(self.rebirths()), 1)

    def test_a_node_birth_after_the_timeout_requires_a_device_birth(self):
        self.birth()
        self.sweep()
        ingestion.end_device_births(GROUP, NODE_A)
        self.ddata()
        self.assertEqual(self.online_writes(), [])
        self.assertEqual(len(self.rebirths()), 1)

    def test_another_nodes_birth_changes_nothing(self):
        self.birth()
        self.sweep()
        ingestion.end_device_births(GROUP, NODE_B)
        self.ddata()
        self.assertEqual(len(self.online_writes()), 1)

    def test_node_births_and_deaths_end_device_births_and_ndata_does_not(self):
        ingestion.supabase_client = None  # process_node_message() returns after the bump
        for msg_type in ("NBIRTH", "NDATA", "NDEATH"):
            ingestion.process_node_message(NODE_A, msg_type, AliasPayload(), group_id=GROUP)
        self.assertEqual(ingestion._node_epoch[ingestion.alias_key(GROUP, NODE_A)], 2)

    def test_a_sweep_that_moved_nothing_leaves_the_device_to_its_birth(self):
        """The gate answered False: the row was already OFFLINE, so the watchdog is not why."""
        self.birth()
        self.gate_moved = False
        self.sweep()
        self.ddata()
        self.assertEqual(self.online_writes(), [])
        self.assertEqual(len(self.rebirths()), 1)

    def test_an_offline_row_this_process_has_not_seen_born_requests_a_rebirth(self):
        """After a restart, or a device registered and never born."""
        self.device["status"] = "OFFLINE"
        self.ddata()
        self.assertEqual(self.online_writes(), [])
        self.assertEqual(len(self.rebirths()), 1)
        self.assertFalse(self.tracked())

    def test_an_online_row_new_to_this_process_is_tracked(self):
        self.ddata()
        self.assertTrue(self.tracked())
        self.assertEqual(self.online_writes(), [])
        self.assertEqual(self.rebirths(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
