"""
Unit tests for the i3X subscription engine and address-space projection.

THESE ARE NOT A SUBSTITUTE FOR THE CONFORMANCE SUITE, and neither is a substitute for these. The
official suite (`cesmii/i3X/conformance-tests`) is the arbiter of whether this server is i3X 1.0 --
hand-written structural assertions passed three real AAS metamodel violations, and that lesson
applies here exactly. What it cannot do is reach the cases that need a controlled clock or a
controlled queue:

  * SUB-07 and SUB-13 -- sync acknowledgement and `lastSequenceNumber = -1` -- were SKIPPED on the
    live run, reported as "no updates were observed on the subscription". The suite can only test
    acknowledgement if the server happens to produce updates while it is watching, and a demo device
    publishing every five seconds does not reliably do that inside the window. So the MUSTs that
    protect against losing a client's unprocessed updates are covered here, or nowhere.
  * Queue overflow needs 10,000 batches to fall off the end. Nothing generates that against a live
    broker in test time.
  * TTL expiry needs minutes of wall clock, which is why the registry takes an injectable clock.

Run: python -m unittest discover -s i3x
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import address_space as A  # noqa: E402
from subscriptions import SubscriptionError, SubscriptionRegistry  # noqa: E402


class FakeClock:
    """A hand-advanced monotonic clock, so TTL is tested in microseconds rather than minutes."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def make_registry(**kwargs):
    clock = FakeClock()
    registry = SubscriptionRegistry(clock=clock, **kwargs)
    return registry, clock


def stage(registry, element_id="dev1", value=1.0):
    registry.stage({element_id: {"value": value, "quality": "Good", "timestamp": "2026-01-01T00:00:00Z"}})


class TestSubscriptionScoping(unittest.TestCase):
    def test_subscription_ids_are_unguessable(self):
        registry, _ = make_registry()
        ids = {registry.create("client").subscription_id for _ in range(50)}
        self.assertEqual(len(ids), 50, "subscription ids must not collide")
        self.assertTrue(all(len(i) >= 32 for i in ids), "ids must be long enough not to be guessed")

    def test_another_clients_subscription_is_404_not_403(self):
        """
        A spec MUST, and a deliberate information-leak defence: 403 would confirm the id is real,
        turning the endpoint into an oracle for enumerating other clients' subscriptions.
        """
        registry, _ = make_registry()
        sub = registry.create("alice")
        with self.assertRaises(SubscriptionError) as ctx:
            registry.get_owned("mallory", sub.subscription_id)
        self.assertEqual(ctx.exception.status, 404)

    def test_list_reports_missing_per_item(self):
        registry, _ = make_registry()
        sub = registry.create("alice")
        results = registry.list_owned("alice", [sub.subscription_id, "nope"])
        self.assertTrue(results[0]["success"])
        self.assertFalse(results[1]["success"])
        self.assertEqual(results[1]["responseDetail"]["status"], 404)


class TestSyncAcknowledgement(unittest.TestCase):
    """The MUSTs the live conformance run could not reach."""

    def setUp(self):
        self.registry, self.clock = make_registry()
        self.sub = self.registry.create("alice")
        self.registry.register(self.sub, [{"elementId": "dev1"}])

    def test_first_sync_returns_everything_and_clears_nothing(self):
        stage(self.registry)
        stage(self.registry, value=2.0)
        batches, status = self.registry.sync(self.sub)
        self.assertEqual(status, 200)
        self.assertEqual([b["sequenceNumber"] for b in batches], [1, 2])
        # Not acknowledged, so a second call with no lastSequenceNumber returns them again.
        again, _ = self.registry.sync(self.sub)
        self.assertEqual([b["sequenceNumber"] for b in again], [1, 2])

    def test_acknowledgement_removes_only_up_to_the_given_sequence(self):
        for _ in range(3):
            stage(self.registry)
        batches, _ = self.registry.sync(self.sub, last_sequence_number=2)
        self.assertEqual([b["sequenceNumber"] for b in batches], [3])

    def test_omitted_sequence_number_must_not_clear_the_queue(self):
        """
        The whole point of the acknowledgement protocol: a client that crashed between receiving and
        processing must find its updates still there. Treating "omitted" as "acknowledge all" is the
        obvious implementation and it silently loses exactly that data.
        """
        stage(self.registry)
        self.registry.sync(self.sub)
        batches, _ = self.registry.sync(self.sub)
        self.assertEqual(len(batches), 1)

    def test_invalid_sequence_number_must_not_clear_the_queue(self):
        stage(self.registry)
        for bad in ("2", None, 1.5, True, [2]):
            batches, _ = self.registry.sync(self.sub, last_sequence_number=bad)
            self.assertEqual(len(batches), 1, f"{bad!r} must not be treated as an acknowledgement")

    def test_minus_one_clears_the_whole_queue(self):
        for _ in range(5):
            stage(self.registry)
        batches, _ = self.registry.sync(self.sub, last_sequence_number=-1)
        self.assertEqual(batches, [])

    def test_empty_queue_returns_empty_list(self):
        batches, status = self.registry.sync(self.sub)
        self.assertEqual(batches, [])
        self.assertEqual(status, 200)

    def test_sequence_numbers_never_repeat(self):
        seen = []
        for _ in range(4):
            stage(self.registry)
            batches, _ = self.registry.sync(self.sub, last_sequence_number=-1)
            seen.extend(b["sequenceNumber"] for b in batches)
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(seen, sorted(seen))


class TestOverflow(unittest.TestCase):
    def test_overflow_drops_oldest_and_reports_206(self):
        registry, _ = make_registry(queue_limit=3)
        sub = registry.create("alice")
        registry.register(sub, [{"elementId": "dev1"}])
        for _ in range(5):
            stage(registry)
        batches, status = registry.sync(sub)
        self.assertEqual(status, 206, "a dropped update MUST be reported as 206")
        # Oldest first: 1 and 2 fell off, leaving 3, 4, 5.
        self.assertEqual([b["sequenceNumber"] for b in batches], [3, 4, 5])

    def test_the_gap_is_computable_by_the_client(self):
        """
        A client computes the exact lost range from `lastSequenceNumber + 1` to
        `result[0].sequenceNumber - 1`. That is only possible because sequence numbers are never
        reused and the dropped ones are simply absent.
        """
        registry, _ = make_registry(queue_limit=2)
        sub = registry.create("alice")
        registry.register(sub, [{"elementId": "dev1"}])
        for _ in range(4):
            stage(registry)
        batches, status = registry.sync(sub)
        self.assertEqual(status, 206)
        self.assertEqual(batches[0]["sequenceNumber"] - 1, 2)

    def test_206_is_reported_once_not_forever(self):
        registry, _ = make_registry(queue_limit=2)
        sub = registry.create("alice")
        registry.register(sub, [{"elementId": "dev1"}])
        for _ in range(4):
            stage(registry)
        _, first = registry.sync(sub)
        self.assertEqual(first, 206)
        stage(registry)
        _, second = registry.sync(sub, last_sequence_number=-1)
        self.assertEqual(second, 200, "a latched overflow flag would report 206 forever")


class _FakeChannel:
    """Stands in for an SseChannel: `_detach_stream` only ever calls `close()` on it."""

    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class TestStreamExclusivity(unittest.TestCase):
    def test_sync_is_refused_while_a_stream_is_open(self):
        registry, _ = make_registry()
        sub = registry.create("alice")
        registry.open_stream(sub)
        with self.assertRaises(SubscriptionError) as ctx:
            registry.sync(sub)
        self.assertEqual(ctx.exception.status, 409)

    def test_opening_a_stream_drains_the_backlog(self):
        """Delivered means discarded: SSE is at-most-once, so a later sync must not re-deliver."""
        registry, _ = make_registry()
        sub = registry.create("alice")
        registry.register(sub, [{"elementId": "dev1"}])
        stage(registry)
        backlog = registry.open_stream(sub)
        self.assertEqual(len(backlog), 1)
        registry.close_stream(sub)
        batches, _ = registry.sync(sub)
        self.assertEqual(batches, [])

    def test_second_stream_closes_the_first(self):
        registry, _ = make_registry()
        closed = []
        registry.on_stream_close = closed.append
        sub = registry.create("alice")
        registry.open_stream(sub)
        registry.open_stream(sub)
        self.assertEqual(len(closed), 1, "opening a second stream MUST close the first")

    def test_a_displaced_stream_does_not_close_its_replacement(self):
        """
        The displaced handler thread unwinds LATER, and must not take the live stream with it.

        When a second stream opens, the first is closed while its handler thread is still parked in
        the wait loop. That thread then runs its `finally`, which detaches "the stream for this
        subscription" -- by then the SECOND channel. The client would see a stream that opened,
        worked, and then died for no reason it could observe, one keepalive interval later.

        Asserted against the real `_detach_stream`, because the guard IS the fix: a test of the
        registry alone would pass either way, since the registry never knew which channel was whose.
        """
        import i3x_service as svc

        sub = svc.registry.create("alice")
        first, second = _FakeChannel(), _FakeChannel()

        with svc._streams_lock:
            svc._streams[sub.subscription_id] = first
        with svc._streams_lock:
            svc._streams[sub.subscription_id] = second

        # The displaced thread finally unwinds and detaches -- naming the channel it owned.
        svc._detach_stream(sub, first)
        self.assertIs(
            svc._streams.get(sub.subscription_id),
            second,
            "a displaced stream's unwind closed the replacement that had taken over from it",
        )

        # The replacement's own unwind still works.
        svc._detach_stream(sub, second)
        self.assertIsNone(svc._streams.get(sub.subscription_id))


class TestTtl(unittest.TestCase):
    def test_idle_subscription_is_reaped(self):
        registry, clock = make_registry(ttl_seconds=60)
        sub = registry.create("alice")
        clock.advance(59)
        self.assertEqual(registry.reap(), [])
        clock.advance(2)
        self.assertEqual(registry.reap(), [sub.subscription_id])
        with self.assertRaises(SubscriptionError):
            registry.get_owned("alice", sub.subscription_id)

    def test_sync_keeps_it_alive(self):
        registry, clock = make_registry(ttl_seconds=60)
        sub = registry.create("alice")
        clock.advance(50)
        registry.sync(sub)
        clock.advance(50)
        self.assertEqual(registry.reap(), [], "a synced subscription must not be reaped")

    def test_an_open_stream_counts_as_activity(self):
        """
        A quiet machine on a healthy connection must not have its subscription deleted underneath
        it -- the client would see the stream close with no error and no reason.
        """
        registry, clock = make_registry(ttl_seconds=60)
        sub = registry.create("alice")
        registry.open_stream(sub)
        clock.advance(10_000)
        self.assertEqual(registry.reap(), [])


class TestRfc3339(unittest.TestCase):
    """
    i3X pins timestamps to RFC 3339 UTC with a literal `Z`. `to_rfc3339_utc` is the only place that
    is enforced, and it is the only place a timestamp can silently escape unnormalised -- it returns
    an unparseable value UNCHANGED, deliberately, so that a device's malformed timestamp is reported
    rather than blanked. That design is what turned a parser gap into a conformance failure.
    """

    def test_offset_form_becomes_z(self):
        self.assertEqual(A.to_rfc3339_utc("2026-01-08T10:30:00+00:00"), "2026-01-08T10:30:00Z")

    def test_postgrest_trailing_zero_microseconds(self):
        """
        THE ACTUAL CI FAILURE. PostgREST strips trailing zeros from `timestamptz`, so a microsecond
        value ending in 0 arrives with FIVE fractional digits. Python 3.10's `fromisoformat` accepts
        exactly 3 or 6 and raises on anything else; 3.11 relaxed it. On the container this fell into
        the unparseable branch and shipped `+00:00` -- the conformance suite's QRY-01 failure --
        while every local run on 3.12 parsed it and passed.

        Swept across every length, because "5 digits" was only the width that happened to occur.
        """
        for digits in range(1, 10):
            fraction = "1" * digits
            got = A.to_rfc3339_utc(f"2026-08-07T19:14:11.{fraction}+00:00")
            self.assertTrue(
                got.endswith("Z"),
                f"{digits} fractional digit(s) escaped normalisation as {got!r}",
            )
            self.assertNotIn("+00:00", got)

    def test_non_utc_offsets_are_converted_not_relabelled(self):
        self.assertEqual(A.to_rfc3339_utc("2026-01-08T11:30:00+01:00"), "2026-01-08T10:30:00Z")

    def test_naive_is_treated_as_utc(self):
        self.assertEqual(A.to_rfc3339_utc("2026-01-08T10:30:00"), "2026-01-08T10:30:00Z")

    def test_z_input_is_idempotent(self):
        self.assertEqual(A.to_rfc3339_utc("2026-01-08T10:30:00Z"), "2026-01-08T10:30:00Z")

    def test_unparseable_is_passed_through_not_blanked(self):
        self.assertEqual(A.to_rfc3339_utc("not-a-timestamp"), "not-a-timestamp")
        self.assertIsNone(A.to_rfc3339_utc(None))
        self.assertIsNone(A.to_rfc3339_utc("   "))

    def test_every_value_envelope_timestamp_is_normalised(self):
        """The envelope is the choke point -- a raw heartbeat must not reach a client through it."""
        env = A.gateway_value(
            {
                "sparkplug_id": "gwy1",
                "status": "ONLINE",
                "last_heartbeat": "2026-08-07T19:14:11.11239+00:00",
            }
        )
        self.assertTrue(env["timestamp"].endswith("Z"), env["timestamp"])


class TestAddressSpace(unittest.TestCase):
    def test_exactly_one_root(self):
        site = A.site_object(["cell-1"])
        self.assertIsNone(site["parentId"], "the site is the only object with a null parentId")
        self.assertEqual(A.unassigned_object([])["parentId"], A.SITE_ELEMENT_ID)

    def test_device_parent_is_the_cell_not_the_gateway(self):
        device = {"sparkplug_id": "dev1", "name": "Pump", "_gateway_sparkplug_id": "gwy1"}
        obj = A.device_object(device, "cell-7", None)
        self.assertEqual(obj["parentId"], "cell-7")
        rels = obj["metadata"]["relationships"]
        self.assertEqual(rels["HasParent"], ["cell-7"])
        # The data path is a separate edge, which is what lets location and connectivity differ.
        self.assertEqual(rels["ConnectsVia"], ["gwy1"])

    def test_device_with_no_cell_falls_to_unassigned_not_to_root(self):
        obj = A.device_object({"sparkplug_id": "dev1", "_gateway_sparkplug_id": None}, None, None)
        self.assertEqual(obj["parentId"], A.UNASSIGNED_ELEMENT_ID)

    def test_is_extended_is_declared_minus_modelled(self):
        self.assertTrue(A.is_extended(["a", "b"], ["a"]))
        self.assertFalse(A.is_extended(["a"], ["a", "b"]))
        # No model at all is NOT "extended" -- "publishes beyond its model" and "has no model" are
        # different findings and only one of them is drift.
        self.assertFalse(A.is_extended(["a"], []))

    def test_null_value_is_never_reported_as_good(self):
        """A specific conformance check (`nullgood` in the reference mock's violation list)."""
        env = A.value_envelope("dev1", None, "Good", None)
        self.assertEqual(env["quality"], "GoodNoData")

    def test_timestamps_are_rfc3339_utc_with_z(self):
        for raw in (
            "2026-08-07T18:42:21.356+00:00",
            "2026-08-07T18:42:21+00:00",
            "2026-08-07T19:42:21+01:00",
            "2026-08-07T18:42:21",
        ):
            out = A.to_rfc3339_utc(raw)
            self.assertTrue(out.endswith("Z"), f"{raw} -> {out} must end in Z")
            self.assertNotIn("+", out, f"{raw} -> {out} must not carry an offset")

    def test_unparseable_timestamp_is_preserved_not_dropped(self):
        self.assertEqual(A.to_rfc3339_utc("not-a-time"), "not-a-time")
        self.assertIsNone(A.to_rfc3339_utc(None))

    def test_relationship_types_are_registered_in_both_directions(self):
        types = {t["elementId"]: t["reverseOf"] for t in A.relationship_types()}
        for name, reverse in types.items():
            self.assertIn(reverse, types, f"{name} names a reverse {reverse} that is not registered")
            self.assertEqual(types[reverse], name, f"{name}/{reverse} are not mutual")

    def test_quarantined_device_is_uncertain_not_good(self):
        device = {"sparkplug_id": "dev1", "is_quarantined": True}
        env = A.device_value(device, {"m": {"value": 1.0, "timestamp": "2026-01-01T00:00:00Z"}})
        self.assertEqual(env["quality"], "Uncertain")


class TestMirroredConstants(unittest.TestCase):
    """
    `i3x_service.py` mirrors a little of `ingestion.py` rather than importing it.

    The import is refused on purpose -- ingestion builds a service-role Supabase client at import
    time whenever the key is in the environment, and this process must never hold one. The cost of
    that refusal is duplicated constants, so they get a drift check, the same discipline
    `sparkplugToXsd.ts` has against `sparkplugDatatype.js`.
    """

    def _constants(self, path):
        import re

        src = open(path, encoding="utf-8").read()
        out = {}
        for name in ("MAX_ALIASES_PER_NODE", "DEFAULT_SPARKPLUG_GROUP"):
            m = re.search(rf"^{name} = (.+)$", src, re.M)
            if not m:
                continue
            # The LAST quoted string on the line, not the first. Both files may write the constant
            # either as a bare literal (`= "FactoryPlus"`) or as an override with a default
            # (`= os.getenv("DEFAULT_SPARKPLUG_GROUP", "FactoryPlus")`), and in the second form the
            # first quoted string is the environment variable's NAME -- comparing that against the
            # other file's value fails on a pair that agrees perfectly.
            quoted = re.findall(r'"([^"]*)"', m.group(1))
            if quoted:
                out[name] = quoted[-1]
        m = re.search(r"^IDENTITY_METRICS = \(([^)]*)\)", src, re.M)
        if m:
            out["IDENTITY_METRICS"] = tuple(sorted(re.findall(r'"([^"]+)"', m.group(1))))
        return out

    def test_shared_constants_agree_with_ingestion(self):
        here = os.path.dirname(os.path.abspath(__file__))
        mine = self._constants(os.path.join(here, "i3x_service.py"))
        theirs = self._constants(os.path.join(here, "..", "ingestion", "ingestion.py"))
        for key, value in mine.items():
            if key in theirs:
                self.assertEqual(
                    value,
                    theirs[key],
                    f"{key} has drifted between i3x_service.py and ingestion.py",
                )
        self.assertIn("IDENTITY_METRICS", mine)
        self.assertIn("MAX_ALIASES_PER_NODE", mine)


class TestStandardNamespaces(unittest.TestCase):
    """
    `STANDARD_NAMESPACES` is keyed on `metric_catalog.standard`, and a key that does not match the
    column fails SILENTLY -- `namespaces()` skips what it cannot resolve, so the endpoint answers
    200 with a shorter list. Nothing raises, nothing logs, and the omission reads as "this
    deployment does not use that standard".

    That is not hypothetical: the keys were `ISO-22400` and `OPC-UA` while the column has held
    `ISO 22400` and `OPC UA` since 0030/0031, so two of the three vocabularies were missing from
    GET /namespaces. Adding a vocabulary is the moment this recurs, which is why the second test
    pins the key set against the frontend's canonical list rather than against a literal here.
    """

    def test_namespaces_emit_every_standard_in_use(self):
        result = A.namespaces({"MTConnect", "ISO 22400", "OPC UA"})
        uris = {n["uri"] for n in result}
        self.assertIn(A.NS_LOCAL, uris)
        self.assertIn(A.NS_RELATIONSHIPS, uris)
        for standard in ("MTConnect", "ISO 22400", "OPC UA"):
            self.assertIn(
                A.STANDARD_NAMESPACES[standard],
                uris,
                f"{standard!r} is in use but contributed no namespace to GET /namespaces",
            )

    def test_unknown_standard_is_skipped_rather_than_invented(self):
        # A standard with no registered URI must not fall back to the local namespace: that would
        # assert this deployment minted the concept, which is the opposite of what provenance means.
        result = A.namespaces({"Not A Standard"})
        self.assertEqual(
            [n["uri"] for n in result],
            [A.NS_LOCAL, A.NS_RELATIONSHIPS],
        )

    def test_standard_namespaces_cover_every_known_standard(self):
        import re

        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, "..", "frontend", "src", "utils", "standards.js")
        src = open(path, encoding="utf-8").read()
        block = re.search(r"export const STANDARDS = \{(.*?)\}", src, re.S)
        self.assertIsNotNone(block, "STANDARDS not found in standards.js")
        # Key/value lines only. A bare `'([^']*)'` would also match the quoted word in the comment
        # that documents the CUSTOM entry.
        values = re.findall(r"^\s*[A-Z0-9_]+:\s*'([^']*)'", block.group(1), re.M)
        self.assertTrue(values, "no STANDARDS values parsed from standards.js")
        for value in values:
            if not value:
                continue  # CUSTOM is stored as NULL -- it is the absence of a standard.
            self.assertIn(
                value,
                A.STANDARD_NAMESPACES,
                f"{value!r} is offered as a standard but has no i3X namespace, so metrics carrying "
                f"it would be dropped from GET /namespaces",
            )


if __name__ == "__main__":
    unittest.main()
