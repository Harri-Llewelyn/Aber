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
import base64
import http.client
import json
import os
import re
import socket
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import address_space as A  # noqa: E402
import i3x_service  # noqa: E402
from subscriptions import SubscriptionError, SubscriptionRegistry  # noqa: E402

MODELLED_METRICS_FIXTURE = (
    Path(__file__).resolve().parents[1] / "test-harness" / "fixtures" / "modelled-metrics.json"
)
MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


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
        registry, _ = make_registry(max_per_principal=50)
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


def _jwt(**claims):
    """An unsigned JWT: the data layer is faked here, so only the payload is read."""
    def part(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode("utf-8")).rstrip(b"=").decode("ascii")

    return "Bearer " + ".".join([part({"alg": "HS256", "typ": "JWT"}), part(claims), "sig"])


class TestSubscriptionsAuthenticateEveryRequest(unittest.TestCase):
    """
    Every request but GET /info is authenticated before dispatch, and a subscription belongs to the
    token's `sub` as well as to its clientId.

    The subscription endpoints used to check only that an Authorization header was present, so
    `not-a-token` could create, sync and delete, and a revoked or expired token kept receiving
    values. Driven through a real HTTP server with the PostgREST probe faked: `accepted` is the set
    of tokens the data layer would accept, and removing one from it is a revocation.
    """

    def setUp(self):
        now = int(time.time())
        self.alice = _jwt(sub="a1ice000-0000-4000-8000-000000000001", role="authenticated",
                          exp=now + 3600)
        self.bob = _jwt(sub="b0b00000-0000-4000-8000-000000000002", role="authenticated",
                        exp=now + 3600)
        self.key_a = "Bearer sb_secret_key_a"
        self.key_b = "Bearer sb_secret_key_b"
        self.accepted = {self.alice, self.bob, self.key_a, self.key_b}
        self.probes = []

        def fake_probe(bearer):
            self.probes.append(bearer)
            if bearer not in self.accepted:
                raise i3x_service.Problem(401, "Unauthorized", "The data layer refused this token.")

        self._saved = (i3x_service.registry, i3x_service._probe, i3x_service.SSE_KEEPALIVE_SECONDS)
        i3x_service._probe = fake_probe
        self.registry = SubscriptionRegistry(max_per_principal=3, max_subscriptions=5, max_streams=1)
        self.registry.on_stream_close = i3x_service._on_registry_stream_close
        i3x_service.registry = self.registry
        i3x_service._auth_cache.clear()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), i3x_service.Handler)
        self.server.daemon_threads = True
        threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        ).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        i3x_service.registry, i3x_service._probe, i3x_service.SSE_KEEPALIVE_SECONDS = self._saved
        i3x_service._auth_cache.clear()

    def call(self, method, path, auth=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        headers = {"Content-Type": "application/json"}
        if auth is not None:
            headers["Authorization"] = auth
        data = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            conn.request(method, "/v1" + path, body=data, headers=headers)
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read() or b"{}")
        finally:
            conn.close()

    def create(self, auth, client_id="shared-client"):
        status, payload = self.call("POST", "/subscriptions", auth, {"clientId": client_id})
        self.assertEqual(status, 200, payload)
        return payload["result"]["subscriptionId"]

    def test_every_endpoint_but_info_refuses_a_token_the_data_layer_refuses(self):
        for route in i3x_service.ROUTES:
            method, path = route.split(" ", 1)
            with self.subTest(route=route):
                body = None if method == "GET" else {"clientId": "c", "subscriptionId": "s"}
                status, payload = self.call(method, path, "not-a-token", body)
                if route == "GET /info":
                    self.assertEqual(status, 200)
                else:
                    self.assertEqual(status, 401, payload)
                    self.assertEqual(payload["responseDetail"]["status"], 401)
        self.assertEqual(self.registry.count(), 0, "a refused caller created a subscription")
        self.assertEqual(len(self.probes), len(i3x_service.ROUTES) - 1, "GET /info was probed")

    def test_a_missing_header_is_refused_without_asking_the_data_layer(self):
        status, _ = self.call("POST", "/subscriptions", None, {"clientId": "c"})
        self.assertEqual(status, 401)
        self.assertEqual(self.probes, [])

    def test_another_principal_gets_404_on_the_same_client_id(self):
        sid = self.create(self.alice)
        ask = {"clientId": "shared-client", "subscriptionId": sid}
        for path in ("/subscriptions/sync", "/subscriptions/register", "/subscriptions/stream"):
            with self.subTest(path=path):
                self.assertEqual(self.call("POST", path, self.bob, ask)[0], 404)
        listed = {"clientId": "shared-client", "subscriptionIds": [sid]}
        for path in ("/subscriptions/list", "/subscriptions/delete"):
            with self.subTest(path=path):
                status, payload = self.call("POST", path, self.bob, listed)
                self.assertEqual(status, 200)
                self.assertEqual(payload["results"][0]["responseDetail"]["status"], 404)
        self.assertEqual(self.call("POST", "/subscriptions/sync", self.alice, ask)[0], 200,
                         "the owner lost its subscription to another principal's delete")

    def test_a_credential_with_no_sub_is_its_own_principal(self):
        sid = self.create(self.key_a)
        ask = {"clientId": "shared-client", "subscriptionId": sid}
        self.assertEqual(self.call("POST", "/subscriptions/sync", self.key_b, ask)[0], 404)
        self.assertEqual(self.call("POST", "/subscriptions/sync", self.key_a, ask)[0], 200)
        principal = self.registry.get_owned(
            "shared-client", sid, principal=i3x_service._authenticate(self.key_a).principal
        ).principal
        self.assertNotIn("sb_secret", principal, "the principal holds the credential itself")

    def test_the_caps_answer_429_and_name_the_limit(self):
        for _ in range(3):
            self.create(self.alice)
        status, payload = self.call("POST", "/subscriptions", self.alice, {"clientId": "c"})
        self.assertEqual(status, 429)
        self.assertIn("I3X_MAX_SUBSCRIPTIONS_PER_PRINCIPAL", payload["responseDetail"]["detail"])

        for _ in range(2):
            self.create(self.bob)
        status, payload = self.call("POST", "/subscriptions", self.bob, {"clientId": "c"})
        self.assertEqual(status, 429)
        self.assertIn("5 subscriptions", payload["responseDetail"]["detail"])
        self.assertIn("I3X_MAX_SUBSCRIPTIONS)", payload["responseDetail"]["detail"])

    def test_the_stream_cap_does_not_count_a_replacement(self):
        registry, _ = make_registry(max_streams=1)
        first, second = registry.create("a"), registry.create("b")
        registry.open_stream(first)
        registry.open_stream(first)
        with self.assertRaises(SubscriptionError) as ctx:
            registry.open_stream(second)
        self.assertEqual(ctx.exception.status, 429)
        self.assertIn("I3X_MAX_STREAMS", ctx.exception.detail)

    def test_a_success_is_cached_and_a_refusal_is_not(self):
        i3x_service._authenticate(self.alice)
        i3x_service._authenticate(self.alice)
        self.assertEqual(self.probes, [self.alice])

        for _ in range(2):
            with self.assertRaises(i3x_service.Problem):
                i3x_service._authenticate("Bearer revoked")
        self.assertEqual(self.probes.count("Bearer revoked"), 2)

        # Revoked while cached: a fresh check refuses it and evicts the cached success.
        self.accepted.discard(self.alice)
        with self.assertRaises(i3x_service.Problem):
            i3x_service._authenticate(self.alice, fresh=True)
        with self.assertRaises(i3x_service.Problem):
            i3x_service._authenticate(self.alice)

    def test_a_cached_success_never_outlives_the_tokens_exp(self):
        short = _jwt(sub="s", exp=int(time.time()) + 2)
        self.accepted.add(short)
        i3x_service._authenticate(short)
        valid_until, _ = i3x_service._auth_cache[i3x_service._credential_key(short)]
        self.assertLessEqual(valid_until - time.monotonic(), 2)

        expired = _jwt(sub="s", exp=int(time.time()) - 1)
        self.accepted.add(expired)
        with self.assertRaises(i3x_service.Problem):
            i3x_service._authenticate(expired)
        self.assertNotIn(expired, self.probes, "an expired token was sent to the data layer")

    def test_the_principal_is_the_sub_claim(self):
        self.assertEqual(
            i3x_service._authenticate(self.alice).principal, "a1ice000-0000-4000-8000-000000000001"
        )

    def _stream(self, sub, bearer, expires_at):
        client_end, server_end = socket.socketpair()
        self.addCleanup(server_end.close)
        self.addCleanup(client_end.close)
        writer = _RecordingWriter()
        req = _StreamRequest(server_end, writer)
        caller = i3x_service.Caller("p", expires_at)
        backlog = self.registry.open_stream(sub)
        thread = threading.Thread(
            target=i3x_service._serve_stream, args=(req, sub, backlog, bearer, caller), daemon=True
        )
        thread.start()
        return req, writer, thread

    def test_an_open_stream_ends_cleanly_once_its_token_is_revoked(self):
        i3x_service.SSE_KEEPALIVE_SECONDS = 0.05
        self.accepted.discard(self.alice)
        sub = self.registry.create("c", principal="p")
        req, writer, thread = self._stream(sub, self.alice, None)
        thread.join(10)
        self.assertFalse(thread.is_alive(), "a revoked token kept its stream")
        self.assertIn(self.alice, self.probes, "the keepalive tick did not re-check the token")
        self.assertTrue(writer.text().endswith("0\r\n\r\n"), "the stream was not ended cleanly")
        self.assertFalse(sub.stream_open)
        self.assertFalse(req.close_connection)

    def test_an_open_stream_ends_cleanly_at_the_tokens_exp(self):
        sub = self.registry.create("c", principal="p")
        req, writer, thread = self._stream(sub, self.alice, time.time() + 0.1)
        thread.join(10)
        self.assertFalse(thread.is_alive(), "a stream outlived its token's exp")
        self.assertEqual(self.probes, [], "it ended on a re-check, not on the exp")
        self.assertTrue(writer.text().endswith("0\r\n\r\n"))
        self.assertFalse(sub.stream_open)


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


class _Msg:
    """The two attributes of a paho message `on_message` reads."""

    def __init__(self, topic, payload):
        self.topic = topic
        self.payload = payload


def _ddata(device_id, value):
    body = {"timestamp": 1767225600000, "metrics": [{"name": "Temperature", "value": value}]}
    return _Msg(f"spBv1.0/TestGroup/DDATA/node-1/{device_id}", json.dumps(body).encode("utf-8"))


class _StalledWriter:
    """A client socket that has stopped draining: a write blocks until the test releases it."""

    def __init__(self):
        self.entered = threading.Event()
        self.released = threading.Event()
        self.thread = None

    def write(self, data):
        self.thread = threading.current_thread()
        self.entered.set()
        self.released.wait()

    def flush(self):
        pass


class _RecordingWriter:
    """Records each write and the thread that made it; tests wait on content, not on the clock."""

    def __init__(self, fail_with=None):
        self.fail_with = fail_with
        self.chunks = []
        self.threads = set()
        self._cond = threading.Condition()

    def write(self, data):
        if self.fail_with is not None:
            raise self.fail_with
        with self._cond:
            self.chunks.append(bytes(data))
            self.threads.add(threading.current_thread())
            self._cond.notify_all()

    def flush(self):
        pass

    def text(self):
        return b"".join(self.chunks).decode("utf-8")

    def wait_for(self, needle, timeout=10):
        with self._cond:
            return self._cond.wait_for(lambda: needle in self.text(), timeout)


class _StreamRequest:
    """What `_serve_stream` uses of a handler. The header calls write nothing."""

    timeout = None

    def __init__(self, connection, wfile):
        self.connection = connection
        self.wfile = wfile
        self.close_connection = False

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        pass

    def end_headers(self):
        pass


class TestAStalledStreamStallsOnlyItself(unittest.TestCase):
    """
    A stream whose client stops reading must not stop the MQTT thread.

    Stream writes used to run on paho's network thread, so one client that stopped reading froze
    every value on the site. The MQTT path now only queues and wakes; each stream's own handler
    thread writes, under a send timeout. Threads are joined with a bound only so that a regression
    fails instead of hanging; nothing here waits on a sleep or on an OS buffer filling.
    """

    def setUp(self):
        self._real_registry = i3x_service.registry
        self.registry = SubscriptionRegistry()
        self.registry.on_stream_close = i3x_service._on_registry_stream_close
        i3x_service.registry = self.registry

    def tearDown(self):
        i3x_service.registry = self._real_registry

    def _subscribe(self, element_id):
        sub = self.registry.create(f"client-{element_id}")
        self.registry.register(sub, [{"elementId": element_id}])
        return sub

    def _open(self, sub, writer):
        """Run `_serve_stream` on its own thread, over a real socket pair for EOF detection."""
        client_end, server_end = socket.socketpair()
        self.addCleanup(server_end.close)
        self.addCleanup(client_end.close)
        req = _StreamRequest(server_end, writer)
        backlog = self.registry.open_stream(sub)
        caller = i3x_service.Caller("principal-494", None)
        thread = threading.Thread(
            target=i3x_service._serve_stream, args=(req, sub, backlog, "Bearer t", caller),
            daemon=True,
        )
        thread.start()
        return req, client_end, thread

    def _handle(self, *messages):
        """Feed messages to `on_message` on a thread standing in for paho's. True if it returned."""
        mqtt = threading.Thread(
            target=lambda: [i3x_service.on_message(None, None, m) for m in messages], daemon=True
        )
        mqtt.start()
        mqtt.join(10)
        return not mqtt.is_alive()

    def test_message_handling_returns_while_a_stream_reader_is_stalled(self):
        stalled = self._subscribe("dev-stalled-494")
        live = self._subscribe("dev-live-494")
        writer = _StalledWriter()
        self.addCleanup(writer.released.set)
        _, client_end, stream = self._open(stalled, writer)

        self.assertTrue(
            self._handle(_ddata("dev-stalled-494", 1.0)),
            "message handling blocked writing to a stream whose client stopped reading",
        )
        self.assertTrue(writer.entered.wait(10), "the stream never tried to deliver the value")
        self.assertIs(writer.thread, stream, "a thread other than the stream's own wrote to it")

        # The stream's thread is now stuck mid-write. The MQTT path must not be.
        self.assertTrue(self._handle(_ddata("dev-stalled-494", 2.0), _ddata("dev-live-494", 3.0)))
        self.assertEqual(i3x_service.metrics_for("dev-live-494")["Temperature"]["value"], 3.0)
        batches, _ = self.registry.sync(live)
        self.assertEqual(batches[-1]["updates"][0]["value"], {"Temperature": 3.0})

        writer.released.set()
        client_end.close()
        stream.join(10)
        self.assertFalse(stream.is_alive(), "the stream did not end when its client left")

    def test_the_streams_own_thread_delivers_under_a_send_timeout(self):
        sub = self._subscribe("dev-a-494")
        writer = _RecordingWriter()
        req, client_end, stream = self._open(sub, writer)

        i3x_service._stage_and_push("dev-a-494", {"Temperature": {"value": 3.5, "timestamp": None}})
        self.assertTrue(writer.wait_for('"Temperature": 3.5'), writer.text())
        self.assertEqual(writer.threads, {stream})
        self.assertEqual(req.connection.gettimeout(), i3x_service.SSE_SEND_TIMEOUT_SECONDS)

        client_end.close()
        stream.join(10)
        self.assertFalse(stream.is_alive())
        self.assertIsNone(i3x_service._streams.get(sub.subscription_id))
        self.assertFalse(sub.stream_open)
        self.assertTrue(req.close_connection, "a connection whose client left was kept for reuse")

    def test_a_write_that_cannot_finish_ends_the_stream(self):
        """What the send timeout raises when the client has stopped reading."""
        sub = self._subscribe("dev-b-494")
        req, _, stream = self._open(sub, _RecordingWriter(fail_with=TimeoutError("timed out")))

        i3x_service._stage_and_push("dev-b-494", {"Temperature": {"value": 1.0, "timestamp": None}})
        stream.join(10)
        self.assertFalse(stream.is_alive(), "a stream whose write timed out stayed open")
        self.assertIsNone(i3x_service._streams.get(sub.subscription_id))
        self.assertFalse(sub.stream_open)
        self.assertTrue(req.close_connection, "a half-written chunked body was kept for reuse")

    def test_a_displaced_stream_is_ended_by_its_own_thread(self):
        """Displacement runs under the registry lock, so it must signal rather than write."""
        sub = self._subscribe("dev-c-494")
        writer = _RecordingWriter()
        req, _, stream = self._open(sub, writer)
        i3x_service._stage_and_push("dev-c-494", {"Temperature": {"value": 1.0, "timestamp": None}})
        self.assertTrue(writer.wait_for("Temperature"))

        self.registry.open_stream(sub)
        self.assertTrue(writer.wait_for("0\r\n\r\n"), "the displaced stream was not ended cleanly")
        stream.join(10)
        self.assertFalse(stream.is_alive())
        self.assertEqual(writer.threads, {stream})
        self.assertFalse(req.close_connection, "a cleanly ended stream closed its connection")
        self.assertIsNone(req.connection.gettimeout(), "the send timeout outlived the stream")


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
        exactly 3 or 6 and raises on anything else; 3.11 relaxed it. On the container, 3.10 at the
        time, this fell into the unparseable branch and shipped `+00:00` -- the conformance suite's
        QRY-01 failure -- while every local run on 3.12 parsed it and passed. The container and CI
        both run 3.13 now, so that particular skew is gone and the parser is still ours to get
        right: the sweep below is what proves it, on any version.

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


SIMULATED_LANE = A.LANES[A.SOURCE_SIMULATED][0]
SHADOW_LANE = A.LANES[A.SOURCE_SHADOW][0]
# The types of the location tree's levels: HasParent/HasChildren only, never a composition.
LOCATION_TYPES = {A.SITE_TYPE_ID, A.AREA_TYPE_ID, A.CELL_TYPE_ID, A.LANE_TYPE_ID}


def _representative_space() -> dict:
    """One object of every shape the address space builds, wired as i3x_service.py wires them."""
    objects = [
        A.device_object({"sparkplug_id": "dev-placed", "_gateway_sparkplug_id": "gwy-cell"}, "cell-1", None),
        A.device_object({"sparkplug_id": "dev-unplaced", "_gateway_sparkplug_id": None}, None, None),
        A.device_object({"sparkplug_id": "dev-area-wide", "_gateway_sparkplug_id": None}, "area-1", None),
        A.device_object({"sparkplug_id": "dev-site-wide", "_gateway_sparkplug_id": None}, A.SITE_ELEMENT_ID, None),
        A.device_object({"sparkplug_id": "dev-unfiled", "_gateway_sparkplug_id": None}, "cell-unfiled", None),
        A.device_object({"sparkplug_id": "dev-sim", "_gateway_sparkplug_id": "gwy-sim"}, SIMULATED_LANE, None),
        A.device_object({"sparkplug_id": "dev-shadow", "_gateway_sparkplug_id": "gwy-shadow"}, SHADOW_LANE, None),
        A.gateway_object({"sparkplug_id": "gwy-cell", "cell_id": "cell-1"}, ["dev-placed"], "cell-1"),
        A.gateway_object({"sparkplug_id": "gwy-site", "location_scope": "site_wide"}, [], A.SITE_ELEMENT_ID),
        A.gateway_object({"sparkplug_id": "gwy-area", "location_scope": "area_wide"}, [], "area-1"),
        A.gateway_object({"sparkplug_id": "gwy-sim", "is_simulated": True}, ["dev-sim"], SIMULATED_LANE),
        A.gateway_object({"sparkplug_id": "gwy-shadow", "is_shadow": True}, ["dev-shadow"], SHADOW_LANE),
        A.cell_object({"id": "cell-1", "name": "Cell 1"}, ["dev-placed", "gwy-cell"], "area-1"),
        A.cell_object({"id": "cell-unfiled", "name": "Unfiled"}, ["dev-unfiled"], A.SITE_ELEMENT_ID),
        A.area_object({"id": "area-1", "name": "Area 1"}, ["cell-1", "dev-area-wide", "gwy-area"]),
        A.lane_object(A.SOURCE_SIMULATED, ["dev-sim", "gwy-sim"]),
        A.lane_object(A.SOURCE_SHADOW, ["dev-shadow", "gwy-shadow"]),
        A.unassigned_object(["dev-unplaced"]),
        A.site_object(
            ["area-1", "cell-unfiled", "dev-site-wide", "gwy-site", SIMULATED_LANE, SHADOW_LANE,
             A.UNASSIGNED_ELEMENT_ID],
        ),
    ]
    return {o["elementId"]: o for o in objects}


def _missing_inverses(objects: dict) -> list:
    """Every edge whose target does not carry the registered inverse back, as sentences."""
    inverse = {name: reverse for name, reverse, _ in A.RELATIONSHIP_TYPES}
    missing = []
    for element_id, obj in objects.items():
        for rel, targets in (obj["metadata"]["relationships"] or {}).items():
            if rel not in inverse:
                missing.append(f"{rel} is emitted but not registered in RELATIONSHIP_TYPES")
                continue
            for target in targets:
                if target not in objects:
                    missing.append(f"{element_id} points at unknown object {target}")
                    continue
                back = (objects[target]["metadata"]["relationships"] or {}).get(inverse[rel], [])
                if element_id not in back:
                    missing.append(
                        f"{element_id} -{rel}-> {target}, but {target} carries no "
                        f"{inverse[rel]} back to it"
                    )
    return missing


class TestAddressSpace(unittest.TestCase):
    def test_exactly_one_root(self):
        site = A.site_object(["cell-1"])
        self.assertIsNone(site["parentId"], "the site is the only object with a null parentId")
        self.assertEqual(site["displayName"], "Site")
        self.assertEqual(A.unassigned_object([])["parentId"], A.SITE_ELEMENT_ID)

    def test_every_edge_has_its_inverse(self):
        """
        EXP-20 IS A SAMPLE, NOT A SWEEP. The conformance suite slices the first five edges it
        discovers, so it reported the site/Unassigned pair and stopped -- while `ComponentOf` was
        emitted by nothing at all and every `HasComponent` edge in the space was one-way. Fixing
        only what it named would have moved the failure to whichever five edges it drew next.

        This walks the whole graph instead, on a space carrying one of each shape: a device and a
        gateway in a cell filed in an area, an area-wide and a site-wide one of each, a cell filed
        in no area, a simulated and a shadow gateway with a device each in their lanes, an unplaced
        device under Unassigned, and the site.
        """
        missing = _missing_inverses(_representative_space())
        self.assertEqual(missing, [], chr(10).join(missing))

    def test_location_is_never_composition(self):
        """
        The site, areas, cells, lanes and Unassigned organise; they compose nothing. A value query
        never returns a `HasChildren` object, so none of them is `isComposition`, and no edge of
        the composition pair touches one.
        """
        objects = _representative_space()
        locations = {e for e, o in objects.items() if o["typeElementId"] in LOCATION_TYPES}
        self.assertEqual(len(locations), 7, sorted(locations))
        for element_id, obj in objects.items():
            rels = obj["metadata"]["relationships"]
            with self.subTest(element_id=element_id):
                if element_id in locations:
                    self.assertFalse(obj["isComposition"])
                    self.assertNotIn("HasComponent", rels)
                    self.assertNotIn("ComponentOf", rels)
                touched = set(rels.get("ComponentOf", [])) | set(rels.get("HasComponent", []))
                self.assertFalse(touched & locations, "a composition edge reaches a location")

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


AREA_NORTH = "44444444-4444-4444-4444-444444444444"
AREA_ARCHIVED = "55555555-5555-5555-5555-555555555555"
CELL_FILED = "66666666-6666-6666-6666-666666666666"
CELL_UNFILED = "77777777-7777-7777-7777-777777777777"
CELL_IN_ARCHIVED_AREA = "88888888-8888-8888-8888-888888888888"
CELL_ARCHIVED = "99999999-9999-9999-9999-999999999999"


def _location_rows(site_name="Aber Works") -> dict:
    """
    One asset for each way of being placed, and a place of each kind the caller cannot see: an
    area and a cell that rows name but that the reads do not return, as when they are archived.
    """
    def located(device_id, source, cell=None, area=None):
        return {"device_id": device_id, "location_source": source, "effective_cell_id": cell,
                "effective_area_id": area}

    return {
        "areas": [{"id": AREA_NORTH, "name": "North", "description": "Assembly hall"}],
        "cells": [
            {"id": CELL_FILED, "name": "Filed", "description": None, "area_id": AREA_NORTH},
            {"id": CELL_UNFILED, "name": "Unfiled", "description": "In no area", "area_id": None},
            {"id": CELL_IN_ARCHIVED_AREA, "name": "Orphaned", "description": None,
             "area_id": AREA_ARCHIVED},
        ],
        "system_settings": [
            {"key": "site_map.min_pin_spacing", "value": 0.08},
            {"key": "site.name", "value": site_name},
        ],
        "gateways": [
            {"id": "g-cell", "sparkplug_id": "gwy-cell", "name": "In a cell", "cell_id": CELL_FILED,
             "location_scope": "cell"},
            {"id": "g-area", "sparkplug_id": "gwy-area", "name": "Area-wide",
             "location_scope": "area_wide", "area_id": AREA_NORTH},
            {"id": "g-site", "sparkplug_id": "gwy-site", "name": "Site-wide",
             "location_scope": "site_wide"},
            {"id": "g-sim", "sparkplug_id": "gwy-sim", "name": "Simulator", "location_scope": "cell",
             "is_simulated": True},
            {"id": "g-shadow", "sparkplug_id": "gwy-shadow", "name": "Playback",
             "location_scope": "cell", "is_simulated": True, "is_shadow": True},
            {"id": "g-none", "sparkplug_id": "gwy-none", "name": "Nowhere", "location_scope": "cell"},
            {"id": "g-gone", "sparkplug_id": "gwy-gone", "name": "Archived area",
             "location_scope": "area_wide", "area_id": AREA_ARCHIVED},
        ],
        "devices": [
            {"id": "d-cell", "sparkplug_id": "dev-cell", "name": "Mill", "gateway_id": "g-cell"},
            {"id": "d-unfiled", "sparkplug_id": "dev-unfiled", "name": "Press", "gateway_id": None,
             "cell_id": CELL_UNFILED},
            {"id": "d-area", "sparkplug_id": "dev-area", "name": "BMS", "gateway_id": "g-area",
             "location_scope": "area_wide"},
            {"id": "d-site", "sparkplug_id": "dev-site", "name": "Weather", "gateway_id": "g-site",
             "location_scope": "site_wide"},
            {"id": "d-sim", "sparkplug_id": "dev-sim", "name": "Sim", "gateway_id": "g-sim"},
            {"id": "d-shadow", "sparkplug_id": "dev-shadow", "name": "Replay",
             "gateway_id": "g-shadow"},
            {"id": "d-none", "sparkplug_id": "dev-none", "name": "Nowhere", "gateway_id": None},
            {"id": "d-gone", "sparkplug_id": "dev-gone", "name": "Archived cell",
             "gateway_id": None, "cell_id": CELL_ARCHIVED},
        ],
        "device_locations": [
            located("d-cell", "inherited", CELL_FILED, AREA_NORTH),
            located("d-unfiled", "explicit", CELL_UNFILED),
            located("d-area", "area_wide", area=AREA_NORTH),
            located("d-site", "site_wide"),
            located("d-sim", "simulated"),
            located("d-shadow", "shadow"),
            located("d-none", "unassigned"),
            located("d-gone", "explicit", CELL_ARCHIVED, AREA_NORTH),
        ],
        "schemas": [],
    }


class TestTheLocationTree(unittest.TestCase):
    """
    Where every asset and place is filed: the site, its areas, their cells, the lanes and
    Unassigned, built by `_build_objects` from the reads the migrations allow.
    """

    def built(self, rows=None):
        pg = ColumnCheckingPostgrest(rows or _location_rows())
        space = i3x_service._read_address_space(pg)
        return space, i3x_service._build_objects(space)

    def parents(self, objects):
        return {e: o["parentId"] for e, o in objects.items()}

    def test_each_asset_is_filed_at_the_level_it_occupies(self):
        _, objects = self.built()
        parents = self.parents(objects)
        expected = {
            # A cell's assets stay under their cell, whether or not the cell is filed in an area.
            "dev-cell": CELL_FILED, "gwy-cell": CELL_FILED, "dev-unfiled": CELL_UNFILED,
            "dev-area": AREA_NORTH, "gwy-area": AREA_NORTH,
            "dev-site": A.SITE_ELEMENT_ID, "gwy-site": A.SITE_ELEMENT_ID,
            "dev-sim": SIMULATED_LANE, "gwy-sim": SIMULATED_LANE,
            "dev-shadow": SHADOW_LANE, "gwy-shadow": SHADOW_LANE,
            "dev-none": A.UNASSIGNED_ELEMENT_ID, "gwy-none": A.UNASSIGNED_ELEMENT_ID,
            # A place the caller cannot see is climbed past, not named and not Unassigned.
            "dev-gone": AREA_NORTH, "gwy-gone": A.SITE_ELEMENT_ID,
        }
        self.assertEqual({e: parents[e] for e in expected}, expected)

    def test_a_cell_sits_under_its_area_or_directly_under_the_site(self):
        _, objects = self.built()
        self.assertEqual(objects[AREA_NORTH]["parentId"], A.SITE_ELEMENT_ID)
        self.assertEqual(objects[CELL_FILED]["parentId"], AREA_NORTH)
        self.assertEqual(objects[CELL_UNFILED]["parentId"], A.SITE_ELEMENT_ID)
        self.assertEqual(objects[CELL_IN_ARCHIVED_AREA]["parentId"], A.SITE_ELEMENT_ID)
        self.assertNotIn(AREA_ARCHIVED, objects)
        self.assertEqual(
            objects[AREA_NORTH]["metadata"]["relationships"]["HasChildren"],
            sorted([CELL_FILED, "dev-area", "gwy-area", "dev-gone"]),
        )

    def test_unassigned_holds_only_what_nobody_has_placed(self):
        _, objects = self.built()
        self.assertEqual(
            objects[A.UNASSIGNED_ELEMENT_ID]["metadata"]["relationships"]["HasChildren"],
            ["dev-none", "gwy-none"],
        )

    def test_the_built_tree_is_symmetric_and_has_one_root(self):
        _, objects = self.built()
        missing = _missing_inverses(objects)
        self.assertEqual(missing, [], chr(10).join(missing))
        self.assertEqual([e for e, o in objects.items() if o["parentId"] is None], [A.SITE_ELEMENT_ID])
        unresolved = {e: p for e, p in self.parents(objects).items() if p and p not in objects}
        self.assertEqual(unresolved, {})

    def test_no_location_is_a_composition(self):
        _, objects = self.built()
        for element_id, obj in objects.items():
            if obj["typeElementId"] not in LOCATION_TYPES:
                continue
            with self.subTest(element_id=element_id):
                self.assertFalse(obj["isComposition"])
                self.assertNotIn("HasComponent", obj["metadata"]["relationships"])

    def test_a_lane_exists_only_while_something_is_in_it(self):
        _, objects = self.built()
        self.assertEqual(objects[SIMULATED_LANE]["typeElementId"], A.LANE_TYPE_ID)
        self.assertEqual(objects[SHADOW_LANE]["displayName"], "Shadow")

        rows = _location_rows()
        rows["gateways"] = [g for g in rows["gateways"] if not g.get("is_simulated")]
        rows["devices"] = [d for d in rows["devices"] if d["id"] not in ("d-sim", "d-shadow")]
        _, objects = self.built(rows)
        self.assertNotIn(SIMULATED_LANE, objects)
        self.assertNotIn(SHADOW_LANE, objects)
        site_children = objects[A.SITE_ELEMENT_ID]["metadata"]["relationships"]["HasChildren"]
        self.assertNotIn(SIMULATED_LANE, site_children)
        # Unassigned is the queue, so it stays even when empty.
        self.assertIn(A.UNASSIGNED_ELEMENT_ID, site_children)

    def test_the_root_is_named_by_the_site_setting(self):
        _, objects = self.built()
        self.assertEqual(objects[A.SITE_ELEMENT_ID]["displayName"], "Aber Works")
        for unset in ("", "   ", None):
            with self.subTest(site_name=unset):
                _, objects = self.built(_location_rows(site_name=unset))
                self.assertEqual(objects[A.SITE_ELEMENT_ID]["displayName"], "Site")

        rows = _location_rows()
        rows["system_settings"] = []
        _, objects = self.built(rows)
        self.assertEqual(objects[A.SITE_ELEMENT_ID]["displayName"], "Site")

    def test_the_site_name_is_read_by_its_key_alone(self):
        pg = ColumnCheckingPostgrest(_location_rows())
        i3x_service._read_address_space(pg)
        reads = [params for relation, params in pg.calls if relation == "system_settings"]
        self.assertEqual(reads, [{"select": "key,value", "key": "eq.site.name"}])

    def test_a_root_query_returns_the_named_site(self):
        i3x_service._space_cache_clear()
        self.addCleanup(i3x_service._space_cache_clear)
        req = FakeRequest(path="/v1/objects?root=true", pg=ColumnCheckingPostgrest(_location_rows()))
        i3x_service.h_objects(req)
        self.assertEqual(
            [(o["elementId"], o["displayName"]) for o in req.result],
            [(A.SITE_ELEMENT_ID, "Aber Works")],
        )

    def test_location_values_count_devices_and_cells_not_children(self):
        space, objects = self.built()

        def value(element_id):
            return i3x_service._current_value(objects, space, element_id)["value"]

        # Every device in the area: area-wide, in its cell, and climbed from an archived cell.
        self.assertEqual(
            value(AREA_NORTH), {"cellCount": 1, "deviceCount": 3, "description": "Assembly hall"}
        )
        self.assertEqual(value(CELL_FILED), {"deviceCount": 1, "description": None})
        self.assertEqual(value(CELL_IN_ARCHIVED_AREA), {"deviceCount": 0, "description": None})
        self.assertEqual(value(SIMULATED_LANE)["deviceCount"], 1)
        self.assertEqual(value(SHADOW_LANE)["deviceCount"], 1)
        # Unassigned holds a gateway too, which is not a device.
        self.assertEqual(value(A.UNASSIGNED_ELEMENT_ID)["deviceCount"], 1)
        self.assertEqual(value(A.SITE_ELEMENT_ID), {"cellCount": 3, "deviceCount": 8})

    def test_every_location_value_is_what_its_type_declares(self):
        space, objects = self.built()
        schemas = {t["elementId"]: t["schema"] for t in A.SYNTHETIC_TYPES}
        json_types = {"number": (int, float), "string": (str,), "null": (type(None),)}
        seen = set()
        for element_id, obj in objects.items():
            if obj["typeElementId"] not in LOCATION_TYPES:
                continue
            seen.add(obj["typeElementId"])
            declared = schemas[obj["typeElementId"]]["properties"]
            value = i3x_service._current_value(objects, space, element_id)["value"]
            with self.subTest(element_id=element_id):
                self.assertEqual(set(value), set(declared))
                for key, spec in declared.items():
                    allowed = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
                    self.assertTrue(
                        any(isinstance(value[key], json_types[t]) for t in allowed),
                        f"{key} is {value[key]!r}, not {allowed}",
                    )
        self.assertEqual(seen, LOCATION_TYPES)

    def test_placement_takes_the_lane_first_then_the_nearest_visible_place(self):
        cells, areas = {"c"}, {"a"}
        cases = [
            (("shadow", "c", "a"), SHADOW_LANE),
            (("simulated", None, None), SIMULATED_LANE),
            (("explicit", "c", "a"), "c"),
            (("inherited", "gone", "a"), "a"),
            (("explicit", "gone", "gone"), A.SITE_ELEMENT_ID),
            (("area_wide", None, "a"), "a"),
            (("area_wide", None, "gone"), A.SITE_ELEMENT_ID),
            (("site_wide", None, None), A.SITE_ELEMENT_ID),
            (("unassigned", None, None), A.UNASSIGNED_ELEMENT_ID),
            # No location row (or a denied view) names no place.
            ((None, None, None), A.UNASSIGNED_ELEMENT_ID),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                self.assertEqual(A.placement(*args, cells, areas), expected)

    def test_the_sources_placement_reads_are_the_views_labels(self):
        # A label renamed in the view would otherwise file every lane device under Unassigned.
        sql = "\n".join(
            p.read_text(encoding="utf-8") for p in sorted(MIGRATIONS_DIR.glob("[0-9]*.sql"))
        )
        last = list(re.finditer(r"CREATE (?:OR REPLACE )?VIEW public\.device_locations\b", sql))[-1]
        view = sql[last.start():sql.index(";", last.start())]
        labels = set(re.findall(r"(?:THEN|ELSE) '([a-z_]+)'::text", view))
        used = {A.SOURCE_SHADOW, A.SOURCE_SIMULATED, A.SOURCE_SITE_WIDE, A.SOURCE_AREA_WIDE,
                A.SOURCE_EXPLICIT, A.SOURCE_UNASSIGNED}
        self.assertLessEqual(used, labels)
        self.assertEqual(set(A.LANES), {A.SOURCE_SHADOW, A.SOURCE_SIMULATED})

    def test_a_gateway_is_placed_in_the_views_precedence(self):
        cases = [
            ({"is_shadow": True, "is_simulated": True}, "shadow"),
            ({"is_simulated": True, "location_scope": "site_wide"}, "simulated"),
            ({"location_scope": "site_wide"}, "site_wide"),
            ({"location_scope": "area_wide", "area_id": "a"}, "area_wide"),
            ({"location_scope": "cell", "cell_id": "c"}, "explicit"),
            ({"location_scope": "cell"}, "unassigned"),
        ]
        for row, expected in cases:
            with self.subTest(row=row):
                self.assertEqual(A.gateway_location_source(row), expected)


# -------------------------------------------------------------------------------------------------
# The columns PostgREST would accept, replayed from the live migrations.
# -------------------------------------------------------------------------------------------------
_KEYWORD_ITEMS = re.compile(r"^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b", re.I)


def _split_top_level(sql: str, start: int = 0, stop_at_from: bool = False):
    """
    Split at depth-0 commas from `start`, ending at the closing paren of the enclosing list, a
    depth-0 `;`, or (for a SELECT list) a depth-0 FROM. Returns (items, end offset).
    """
    items, buf, depth, quote, i = [], [], 0, None, start
    while i < len(sql):
        ch = sql[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            if depth == 0:
                break
            depth -= 1
            buf.append(ch)
        elif depth == 0 and ch == ";":
            break
        elif depth == 0 and ch == ",":
            items.append("".join(buf))
            buf = []
        elif (
            stop_at_from and depth == 0 and sql[i:i + 4].upper() == "FROM"
            and not (sql[i - 1:i].isalnum() or sql[i - 1:i] == "_")
            and not (sql[i + 4:i + 5].isalnum() or sql[i + 4:i + 5] == "_")
        ):
            break
        else:
            buf.append(ch)
        i += 1
    items.append("".join(buf))
    return [item.strip() for item in items if item.strip()], i


def _select_output_name(item: str) -> str:
    alias = re.search(r'\bAS\s+"?(\w+)"?\s*$', item, re.I)
    if alias:
        return alias.group(1)
    return re.search(r'"?(\w+)"?\s*$', item).group(1)


def _relation_columns() -> dict:
    """
    The columns of every `public` table and view, replaying the live migrations in filename order.

    Tables take CREATE TABLE plus ALTER TABLE ADD / DROP / RENAME COLUMN; a view takes its last
    CREATE [OR REPLACE] VIEW, and DROP VIEW removes it. Statements must start in column 0, which is
    how pg_dump writes them; a DO block's dynamic SQL is not replayed.
    """
    columns: dict = {}
    statement = re.compile(
        r"^(?:CREATE TABLE (?:IF NOT EXISTS )?public\.(?P<table>\w+)\s*\("
        r"|ALTER TABLE (?:IF EXISTS )?(?:ONLY )?public\.(?P<altered>\w+)\b"
        r"|CREATE (?:OR REPLACE )?VIEW public\.(?P<view>\w+)(?:\s+WITH\s*\([^)]*\))?\s+AS\s+SELECT\b"
        r"|DROP VIEW (?:IF EXISTS )?public\.(?P<dropped>\w+))",
        re.M,
    )
    for path in sorted(MIGRATIONS_DIR.glob("[0-9]*.sql")):
        sql = path.read_text(encoding="utf-8")
        for m in statement.finditer(sql):
            if m.group("table"):
                items, _ = _split_top_level(sql, m.end())
                columns[m.group("table")] = {
                    item.split()[0].strip('"') for item in items if not _KEYWORD_ITEMS.match(item)
                }
            elif m.group("view"):
                items, _ = _split_top_level(sql, m.end(), stop_at_from=True)
                columns[m.group("view")] = {_select_output_name(item) for item in items}
            elif m.group("dropped"):
                columns.pop(m.group("dropped"), None)
            else:
                cols = columns.setdefault(m.group("altered"), set())
                end = sql.find(";", m.end())
                body = sql[m.end():end if end >= 0 else None]
                for add in re.finditer(
                    r"\bADD\s+COLUMN\s+(?:IF NOT EXISTS\s+)?\"?(\w+)", body, re.I
                ):
                    cols.add(add.group(1))
                for drop in re.finditer(
                    r"\bDROP\s+COLUMN\s+(?:IF EXISTS\s+)?\"?(\w+)", body, re.I
                ):
                    cols.discard(drop.group(1))
                for rename in re.finditer(
                    r"\bRENAME\s+(?:COLUMN\s+)?(?!TO\b)\"?(\w+)\"?\s+TO\s+\"?(\w+)", body, re.I
                ):
                    cols.discard(rename.group(1))
                    cols.add(rename.group(2))
    return columns


_POSTGREST_RESERVED = {"select", "order", "limit", "offset", "and", "or", "on_conflict", "columns"}


class ColumnCheckingPostgrest:
    """
    Answers like PostgREST over the migrated schema: a read naming a column the relation lacks
    fails as `PostgrestClient.get` fails on PostgREST's 400, and rows come back projected onto
    `select`. Seeded rows are held to the same columns, so a fixture cannot invent one either.
    """

    COLUMNS = None

    def __init__(self, rows=None, bearer="Bearer test"):
        if ColumnCheckingPostgrest.COLUMNS is None:
            ColumnCheckingPostgrest.COLUMNS = _relation_columns()
        self.bearer = bearer
        self.rows = rows or {}
        self.calls = []
        for relation, seeded in self.rows.items():
            for row in seeded:
                unknown = set(row) - self.COLUMNS[relation]
                assert not unknown, f"fixture row for {relation} names {sorted(unknown)}"

    def _refuse(self, relation, column):
        raise SubscriptionError(
            502,
            "Bad Gateway",
            'Upstream read failed (400): {"code":"42703","message":"column %s.%s does not exist"}'
            % (relation, column),
        )

    def get(self, relation, params=None):
        params = dict(params or {})
        self.calls.append((relation, params))
        known = self.COLUMNS.get(relation)
        if known is None:
            raise SubscriptionError(502, "Bad Gateway", f"Upstream read failed (404): {relation}")
        selected = params.get("select", "").split(",")
        named = list(selected)
        named += [k for k in params if k not in _POSTGREST_RESERVED]
        named += [part.split(".")[0] for part in params.get("order", "").split(",") if part]
        for key in ("and", "or"):
            named += re.findall(r"[(,]\s*(\w+)\.", params.get(key, ""))
        for column in named:
            if column not in known:
                self._refuse(relation, column)
        return [{c: row.get(c) for c in selected} for row in self.rows.get(relation, [])]


class FakeRequest:
    """
    Stands in for `Handler` in a handler call: a path, a parsed body, and a PostgREST. With no
    PostgREST given, reaching for one fails the test, which is how a test asserts that a request
    was refused before anything was read.
    """

    def __init__(self, path="/v1/", body=None, pg=None):
        self.path = path
        self.body = {} if body is None else body
        self.pg = pg
        self.status = None
        self.result = None

    _query = i3x_service.Handler._query

    def _body(self):
        return self.body

    def _bearer(self):
        return "Bearer test"

    def _pg(self):
        if self.pg is None:
            raise AssertionError("the handler read PostgREST before validating its input")
        return self.pg

    def _ok(self, result, status=200, detail=None):
        self.status, self.result = status, result

    def _bulk(self, results):
        self.status, self.result = 200, results


class _FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = status < 400
        self.text = json.dumps(body)
        self._body = body

    def json(self):
        return self._body


CELL_A = "11111111-1111-1111-1111-111111111111"
CELL_B = "22222222-2222-2222-2222-222222222222"
AREA = "33333333-3333-3333-3333-333333333333"


def _seeded_rows() -> dict:
    """Two cells; a device placed explicitly, one inheriting its gateway's cell, one unplaced."""
    return {
        "cells": [
            {"id": CELL_A, "name": "Cell A", "description": "Welding"},
            {"id": CELL_B, "name": "Cell B", "description": None},
        ],
        "gateways": [{"id": "g1", "sparkplug_id": "gwy-1", "name": "Gateway", "cell_id": CELL_B}],
        "devices": [
            {"id": "d-explicit", "sparkplug_id": "dev-explicit", "name": "Placed",
             "gateway_id": "g1", "cell_id": CELL_A},
            {"id": "d-inherits", "sparkplug_id": "dev-inherits", "name": "Inherits",
             "gateway_id": "g1", "cell_id": None},
            {"id": "d-nowhere", "sparkplug_id": "dev-nowhere", "name": "Nowhere",
             "gateway_id": None, "cell_id": None},
        ],
        "device_locations": [
            {"device_id": "d-explicit", "effective_cell_id": CELL_A, "effective_area_id": AREA},
            {"device_id": "d-inherits", "effective_cell_id": CELL_B, "effective_area_id": AREA},
            {"device_id": "d-nowhere", "effective_cell_id": None, "effective_area_id": None},
        ],
        "schemas": [],
    }


class TestAddressSpaceReads(unittest.TestCase):
    """
    The reads behind the address space, against the schema the migrations build.

    Every device was once filed under Unassigned because the location read selected a column
    the view does not have, PostgREST answered 400, and the failure was read as "no rows".
    """

    def test_the_migrations_are_parsed(self):
        # A parser that found nothing would make every other test here refuse everything; one
        # that found the wrong thing would accept the column that started this.
        columns = _relation_columns()
        self.assertIn("sparkplug_id", columns["devices"])
        self.assertIn("effective_area_id", columns["device_locations"])
        self.assertIn("device_id", columns["device_locations"])
        self.assertNotIn("id", columns["device_locations"])
        self.assertIn("time", columns["telemetry"])

    def test_every_address_space_read_names_real_columns(self):
        pg = ColumnCheckingPostgrest()
        i3x_service._read_address_space(pg)
        self.assertEqual(
            sorted(relation for relation, _ in pg.calls),
            ["areas", "cells", "device_locations", "devices", "gateways", "schemas",
             "system_settings"],
        )

    def test_the_history_read_names_real_columns(self):
        pg = ColumnCheckingPostgrest()
        i3x_service._read_telemetry(pg, "dev1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 10)
        self.assertEqual([relation for relation, _ in pg.calls], ["telemetry"])

    def test_a_device_is_filed_under_its_resolved_cell(self):
        space = i3x_service._read_address_space(ColumnCheckingPostgrest(_seeded_rows()))
        objects = i3x_service._build_objects(space)
        self.assertEqual(objects["dev-explicit"]["parentId"], CELL_A)
        self.assertEqual(objects["dev-inherits"]["parentId"], CELL_B, "inherits its gateway's")
        self.assertEqual(objects["dev-nowhere"]["parentId"], A.UNASSIGNED_ELEMENT_ID)
        self.assertIn("dev-explicit", objects[CELL_A]["metadata"]["relationships"]["HasChildren"])
        self.assertEqual(space["locations"]["d-explicit"]["effective_area_id"], AREA)

    def _respond(self, failing, status, body):
        def fake_get(url, **_kwargs):
            if url.endswith("/" + failing):
                return _FakeResponse(status, body)
            return _FakeResponse(200, [])
        return mock.patch.object(i3x_service.requests, "get", side_effect=fake_get)

    def test_a_rejected_read_is_a_502_carrying_postgrests_message(self):
        error = {"code": "42703", "message": "column device_locations.id does not exist"}
        with self._respond("device_locations", 400, error):
            with self.assertRaises(SubscriptionError) as caught:
                i3x_service._read_address_space(i3x_service.PostgrestClient("Bearer t"))
        self.assertEqual(caught.exception.status, 502)
        self.assertIn("device_locations", caught.exception.detail)
        self.assertIn("column device_locations.id does not exist", caught.exception.detail)

    def test_a_server_error_on_any_read_is_a_502(self):
        for relation in ("cells", "gateways", "devices", "device_locations", "schemas"):
            with self.subTest(relation=relation), self._respond(relation, 503, {"message": "down"}):
                with self.assertRaises(SubscriptionError) as caught:
                    i3x_service._read_address_space(i3x_service.PostgrestClient("Bearer t"))
                self.assertEqual(caught.exception.status, 502)

    def test_an_unreachable_data_layer_is_not_an_empty_tree(self):
        def refuse(url, **_kwargs):
            if url.endswith("/device_locations"):
                raise i3x_service.requests.ConnectionError("refused")
            return _FakeResponse(200, [])
        with mock.patch.object(i3x_service.requests, "get", side_effect=refuse):
            with self.assertRaises(i3x_service.requests.RequestException):
                i3x_service._read_address_space(i3x_service.PostgrestClient("Bearer t"))

    def test_a_denied_location_read_is_empty(self):
        with self._respond("device_locations", 403, {"code": "42501"}):
            space = i3x_service._read_address_space(i3x_service.PostgrestClient("Bearer t"))
        self.assertEqual(space["locations"], {})

    def test_a_denied_primary_read_is_still_refused(self):
        # A token PostgREST rejects must not read as an empty plant.
        with self._respond("cells", 401, {"code": "PGRST301"}):
            with self.assertRaises(SubscriptionError) as caught:
                i3x_service._read_address_space(i3x_service.PostgrestClient("Bearer t"))
        self.assertEqual(caught.exception.status, 401)


class TestObjectsMatchTheirTypes(unittest.TestCase):
    """An object says what its ObjectType says: the same `sourceTypeId`, and a conforming value."""

    SEMANTIC = "https://admin-shell.io/idta/example/Mill/1/0"

    def space(self):
        rows = _seeded_rows()
        rows["schemas"] = [
            {"id": "s-semantic", "schema_name": "Mill", "semantic_id": self.SEMANTIC,
             "schema_definition": {"properties": {"Spindle/SPEED": {}}}},
            {"id": "s-local", "schema_name": "Local Pump", "semantic_id": None,
             "schema_definition": {"properties": {"Flow": {}}}},
        ]
        rows["devices"][0]["schema_id"] = "s-semantic"
        rows["devices"][1]["schema_id"] = "s-local"
        rows["gateways"].append(
            {"id": "g2", "sparkplug_id": "gwy-site", "name": "Site-wide",
             "location_scope": "site_wide", "status": "ONLINE", "sparkplug_group": "Aber",
             "last_heartbeat": "2026-08-07T19:14:11.11239+00:00"}
        )
        space = i3x_service._read_address_space(ColumnCheckingPostgrest(rows))
        return space, i3x_service._build_objects(space), i3x_service._build_types(space)

    def test_every_objects_source_type_id_is_its_types(self):
        _, objects, types = self.space()
        by_type = {t["elementId"]: t["sourceTypeId"] for t in types}
        for element_id, obj in objects.items():
            with self.subTest(element_id=element_id):
                self.assertEqual(obj["metadata"]["sourceTypeId"], by_type[obj["typeElementId"]])

    def test_a_devices_source_type_id_names_its_schema_not_itself(self):
        _, objects, _ = self.space()
        self.assertEqual(objects["dev-explicit"]["metadata"]["sourceTypeId"], self.SEMANTIC)
        self.assertEqual(objects["dev-inherits"]["metadata"]["sourceTypeId"], "Local Pump")
        self.assertEqual(objects["dev-nowhere"]["metadata"]["sourceTypeId"], "Device")

    JSON_TYPES = {
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "string": lambda v: isinstance(v, str),
        "boolean": lambda v: isinstance(v, bool),
        "null": lambda v: v is None,
    }

    def nonconformance(self, value, schema) -> list:
        """What in `value` a flat object schema does not describe, or describes and is not sent."""
        if not isinstance(value, dict):
            return [f"value is {value!r}, not an object"]
        declared = schema.get("properties", {})
        problems = [f"{k} is sent and not declared" for k in value if k not in declared]
        problems += [f"{k} is declared and not sent" for k in declared if k not in value]
        for key, spec in declared.items():
            if key not in value:
                continue
            allowed = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
            if not any(self.JSON_TYPES[t](value[key]) for t in allowed):
                problems.append(f"{key} is {value[key]!r}, not {allowed}")
            if "enum" in spec and value[key] not in spec["enum"]:
                problems.append(f"{key} is {value[key]!r}, not one of {spec['enum']}")
        return problems

    def test_every_synthetic_objects_value_conforms_to_its_type(self):
        space, objects, _ = self.space()
        schemas = {t["elementId"]: t["schema"] for t in A.SYNTHETIC_TYPES}
        checked = set()
        for element_id, obj in objects.items():
            type_id = obj["typeElementId"]
            if type_id not in schemas or type_id == A.UNTYPED_DEVICE_TYPE_ID:
                continue
            with self.subTest(element_id=element_id):
                value = i3x_service._current_value(objects, space, element_id)["value"]
                self.assertEqual(self.nonconformance(value, schemas[type_id]), [])
                checked.add(type_id)
        self.assertEqual(checked, {A.SITE_TYPE_ID, A.CELL_TYPE_ID, A.LANE_TYPE_ID, A.GATEWAY_TYPE_ID})

    def test_containers_count_devices_not_children(self):
        space, objects, _ = self.space()

        def value(element_id):
            return i3x_service._current_value(objects, space, element_id)["value"]

        cell_a, cell_b = CELL_A, CELL_B
        # Three devices and two cells; the site's children are the cells, Unassigned and a
        # site-wide gateway.
        self.assertEqual(value(A.SITE_ELEMENT_ID), {"cellCount": 2, "deviceCount": 3})
        self.assertEqual(value(cell_a), {"deviceCount": 1, "description": "Welding"})
        # Cell B holds one device and the gateway it inherits from.
        self.assertEqual(value(cell_b), {"deviceCount": 1, "description": None})
        self.assertEqual(value(A.UNASSIGNED_ELEMENT_ID)["deviceCount"], 1)

    def test_a_gateways_heartbeat_inside_its_value_is_rfc3339_utc(self):
        # The envelope's timestamp was normalised and the same instant inside the value was not.
        space, objects, _ = self.space()
        vqt = i3x_service._current_value(objects, space, "gwy-site")
        self.assertEqual(vqt["value"]["lastHeartbeat"], "2026-08-07T19:14:11.112Z")
        self.assertEqual(vqt["value"]["lastHeartbeat"], vqt["timestamp"])


class TestRequestValidation(unittest.TestCase):
    """Invalid parameters on the Exploratory and Query endpoints are a 400, before any read."""

    HISTORY = {"startTime": "2026-01-01T00:00:00Z", "endTime": "2026-01-02T00:00:00Z"}
    NOT_A_DEPTH = ("abc", "2", -1, 1.5, True, False, [], {"n": 1}, float("inf"))

    def setUp(self):
        i3x_service._space_cache_clear()

    def tearDown(self):
        i3x_service._space_cache_clear()

    def refused(self, handler, body):
        with self.assertRaises(i3x_service.Problem) as caught:
            handler(FakeRequest(body=body))
        self.assertEqual(caught.exception.status, 400)
        return caught.exception.detail

    def test_max_depth_accepts_a_non_negative_integer(self):
        for given, expected in ((0, 0), (1, 1), (7, 7), (2.0, 2), (None, 1)):
            with self.subTest(given=given):
                self.assertEqual(i3x_service._max_depth({"maxDepth": given}), expected)
        self.assertEqual(i3x_service._max_depth({}), 1)

    def test_anything_else_as_max_depth_is_a_400(self):
        for handler, base in (
            (i3x_service.h_objects_value, {}),
            (i3x_service.h_objects_history, self.HISTORY),
        ):
            for bad in self.NOT_A_DEPTH:
                with self.subTest(handler=handler.__name__, maxDepth=bad):
                    detail = self.refused(handler, {**base, "elementIds": ["i3x:site"], "maxDepth": bad})
                    self.assertIn("maxDepth", detail)

    def test_limit_must_be_a_positive_integer(self):
        for bad in ("100", 0, -5, 2.5, True, [10]):
            with self.subTest(limit=bad):
                detail = self.refused(
                    i3x_service.h_objects_history,
                    {**self.HISTORY, "elementIds": ["dev1"], "limit": bad},
                )
                self.assertIn("limit", detail)
        self.assertEqual(i3x_service._int_field({"limit": 1}, "limit", 1000, 1), 1)

    def test_element_ids_must_be_strings(self):
        for handler in (
            i3x_service.h_objects_list,
            i3x_service.h_objects_related,
            i3x_service.h_objects_value,
        ):
            with self.subTest(handler=handler.__name__):
                self.refused(handler, {"elementIds": ["i3x:site", {"elementId": "x"}]})

    def test_a_body_that_is_not_an_object_is_a_400(self):
        for raw in (b"[1, 2]", b'"elementIds"', b"7"):
            with self.subTest(raw=raw):
                req = FakeRequest()
                req._raw_body = raw
                with self.assertRaises(i3x_service.Problem) as caught:
                    i3x_service.Handler._body(req)
                self.assertEqual(caught.exception.status, 400)

    def test_max_depth_zero_does_not_descend_the_location_tree(self):
        # maxDepth follows HasComponent only. The site organises its cells and devices with
        # HasChildren, so even an unbounded read returns the site's own value and nothing else.
        rows = _seeded_rows()
        req = FakeRequest(
            body={"elementIds": [A.SITE_ELEMENT_ID], "maxDepth": 0},
            pg=ColumnCheckingPostgrest(rows),
        )
        i3x_service.h_objects_value(req)
        self.assertTrue(req.result[0]["success"])
        self.assertFalse(req.result[0]["result"]["isComposition"])
        self.assertNotIn("components", req.result[0]["result"])


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
            # either as a bare literal (`= "Aber"`) or as an override with a default
            # (`= os.getenv("DEFAULT_SPARKPLUG_GROUP", "Aber")`), and in the second form the
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

    def _integer_decoder(self, path):
        """`sparkplug_integer_value` as code (docstring aside) and `SPARKPLUG_SIGNED_INT_BITS` as data."""
        import ast

        out = {}
        for node in ast.parse(open(path, encoding="utf-8").read()).body:
            if isinstance(node, ast.FunctionDef) and node.name == "sparkplug_integer_value":
                body = node.body[1:] if ast.get_docstring(node) else node.body
                out["function"] = [ast.dump(node.args)] + [ast.dump(stmt) for stmt in body]
            elif isinstance(node, ast.Assign) and any(
                getattr(target, "id", None) == "SPARKPLUG_SIGNED_INT_BITS" for target in node.targets
            ):
                out["widths"] = ast.literal_eval(node.value)
        return out

    def test_the_integer_decoder_agrees_with_ingestion(self):
        here = os.path.dirname(os.path.abspath(__file__))
        mine = self._integer_decoder(os.path.join(here, "i3x_service.py"))
        theirs = self._integer_decoder(os.path.join(here, "..", "ingestion", "ingestion.py"))
        self.assertEqual(set(mine), {"function", "widths"})
        self.assertEqual(
            mine, theirs, "sparkplug_integer_value has drifted between i3x_service.py and ingestion.py"
        )


INGESTION_DIR = Path(__file__).resolve().parents[1] / "ingestion"

INT8, INT16, INT32, INT64, UINT8, UINT16, UINT32, UINT64, DATETIME = 1, 2, 3, 4, 5, 6, 7, 8, 13

# (datatype, value) at each signed type's minimum, -1 and maximum, and each unsigned type's maximum.
SIGNED_CASES = [
    (INT8, -128), (INT8, -1), (INT8, 127),
    (INT16, -32768), (INT16, -1), (INT16, 32767),
    (INT32, -(2**31)), (INT32, -1), (INT32, 2**31 - 1),
    (INT64, -(2**63)), (INT64, -1), (INT64, 2**63 - 1),
]
UNSIGNED_CASES = [(UINT8, 255), (UINT16, 65535), (UINT32, 2**32 - 1), (UINT64, 2**64 - 1)]


class _Message:
    def __init__(self, topic, payload):
        self.topic, self.payload = topic, payload


class TestSparkplugValues(unittest.TestCase):
    """
    Values as the MQTT side decodes them: a signed integer is the number the device sent.

    Sparkplug carries Int8-32 in the uint32 `int_value` and Int64 in the uint64 `long_value` as two's
    complement, and DDATA may name a metric by alias or name alone with no datatype -- so the
    datatype comes from the birth. Real protobuf payloads through `on_message`, the path the broker
    drives; the generated module is the one `npm run proto` writes into ingestion/.
    """

    GROUP, NODE, DEVICE = "Aber", "gwy120000000000400080000", "dev220000000000400080000"

    @classmethod
    def setUpClass(cls):
        if str(INGESTION_DIR) not in sys.path:
            sys.path.append(str(INGESTION_DIR))
        import sparkplug_b_pb2  # noqa: E402 -- a missing module fails here, not as silent None values

        cls.pb = sparkplug_b_pb2

    def setUp(self):
        for table in ("_values", "_alias_map", "_alias_datatypes", "_name_datatypes"):
            getattr(i3x_service, table).clear()

    tearDown = setUp

    def publish(self, msg_type, *metrics, device=DEVICE, raw=None):
        payload = self.pb.Payload()
        payload.timestamp = 1790000000000
        for fields in metrics:
            metric = payload.metrics.add()
            for field, value in fields.items():
                if hasattr(value, "CopyFrom"):
                    getattr(metric, field).CopyFrom(value)
                else:
                    setattr(metric, field, value)
        topic = "spBv1.0/%s/%s/%s" % (self.GROUP, msg_type, self.NODE) + ("/" + device if device else "")
        i3x_service.on_message(None, None, _Message(topic, raw or payload.SerializeToString()))

    def served(self):
        return {name: entry["value"] for name, entry in i3x_service.metrics_for(self.DEVICE).items()}

    @staticmethod
    def on_the_wire(datatype, value):
        """Eclipse Tahu's Java encoding: Int8-32 sign-extended into the uint32, Int64 into the uint64."""
        if datatype in (INT64, UINT64, DATETIME):
            return {"long_value": value & (2**64 - 1)}
        return {"int_value": value & (2**32 - 1)}

    def cases(self):
        return [
            ("m%d" % i, 100 + i, datatype, value)
            for i, (datatype, value) in enumerate(SIGNED_CASES + UNSIGNED_CASES)
        ]

    def assert_served(self, cases):
        served = self.served()
        for name, _alias, datatype, value in cases:
            with self.subTest(datatype=datatype, value=value):
                self.assertEqual(served[name], value)
                self.assertIs(type(served[name]), int)

    def test_an_aliased_ddata_reads_each_width_at_its_limits(self):
        cases = self.cases()
        self.publish("DBIRTH", *[
            {"name": name, "alias": alias, "datatype": datatype, **self.on_the_wire(datatype, 0)}
            for name, alias, datatype, _ in cases
        ])
        self.publish("DDATA", *[
            {"alias": alias, **self.on_the_wire(datatype, value)} for _, alias, datatype, value in cases
        ])
        self.assert_served(cases)

    def test_a_named_ddata_reads_each_width_at_its_limits(self):
        cases = self.cases()
        self.publish("DBIRTH", *[
            {"name": name, "datatype": datatype, **self.on_the_wire(datatype, 0)}
            for name, _, datatype, _ in cases
        ])
        self.publish("DDATA", *[
            {"name": name, **self.on_the_wire(datatype, value)} for name, _, datatype, value in cases
        ])
        self.assert_served(cases)

    def test_an_alias_the_nbirth_declared_is_read_on_a_devices_ddata(self):
        self.publish("NBIRTH", {"name": "offset", "alias": 7, "datatype": INT16, "int_value": 0}, device=None)
        self.publish("DDATA", {"alias": 7, "int_value": 2**32 - 300})
        self.assertEqual(self.served(), {"offset": -300})

    def test_a_birth_value_is_read_through_its_own_datatype(self):
        self.publish("DBIRTH", {"name": "offset", "datatype": INT32, "int_value": 2**32 - 5})
        self.assertEqual(self.served(), {"offset": -5})

    def test_an_undeclared_integer_is_served_unsigned(self):
        # No birth seen since startup: served as it arrived, as ingestion stores it.
        with self.assertLogs(i3x_service.logger, "WARNING"):
            i3x_service._undeclared_integer_warned_at = 0.0
            self.publish("DDATA", {"name": "offset", "int_value": 2**32 - 5})
        self.assertEqual(self.served(), {"offset": 4294967291})

    def test_a_datetime_is_served_as_epoch_milliseconds(self):
        # The Schema Builder declares DateTime as `number`, so no ObjectType asks for `date-time`.
        self.publish("DBIRTH", {"name": "since", "datatype": DATETIME, "long_value": 1790000000000})
        self.assertEqual(self.served(), {"since": 1790000000000})

    def test_values_it_cannot_represent_are_skipped_not_stringified(self):
        self.publish(
            "DDATA",
            {"name": "blob", "datatype": 17, "bytes_value": b"\x00\x01"},
            {"name": "table", "datatype": 16, "dataset_value": self.pb.Payload.DataSet(num_of_columns=0)},
            {"name": "udt", "datatype": 19, "template_value": self.pb.Payload.Template(is_definition=False)},
            {"name": "speed", "datatype": 10, "double_value": 1.5},
        )
        self.assertEqual(self.served(), {"speed": 1.5})

    def test_a_negative_json_integer_is_served_as_itself(self):
        # A JSON number carries its own sign, so an undeclared one is not reported as unsigned.
        body = {"timestamp": 1790000000000, "metrics": [
            {"name": "a", "int_value": -5},
            {"name": "b", "datatype": INT16, "int_value": -32768},
        ]}
        i3x_service._undeclared_integer_warned_at = 0.0
        with self.assertNoLogs(i3x_service.logger, "WARNING"):
            self.publish("DDATA", raw=json.dumps(body).encode("utf-8"))
        self.assertEqual(self.served(), {"a": -5, "b": -32768})


class TestNamespaces(unittest.TestCase):
    """
    GET /namespaces lists the namespaces the served types belong to, and only those (#459).

    i3X groups ObjectTypes and RelationshipTypes into namespaces, and an Object reaches one through
    its type (`typeNamespaceUri`), so a client reads the list as the set it will meet there. It
    used to add one URI per `metric_catalog.standard` -- MTConnect's under mtconnect.org, which
    the semantic ids disclaim -- that no type or object carried. The space includes a device typed
    by a schema whose metrics come from standards, the case that once looked like a reason to
    advertise them.
    """

    SCHEMA = {
        "id": "schema-1",
        "schema_name": "Mill",
        "schema_definition": {"properties": {"Axes/X/POSITION": {}, "OEE/OEE": {}}},
        "semantic_id": "https://admin-shell.io/idta/example/1/0",
    }

    def served(self):
        types = i3x_service._build_types({"schemas": [self.SCHEMA]})
        objects = dict(_representative_space())
        typed = A.device_object({"sparkplug_id": "dev-typed", "_gateway_sparkplug_id": None}, None, "schema-1")
        objects[typed["elementId"]] = typed
        return types, A.relationship_types(), objects

    def used(self):
        types, relationships, objects = self.served()
        return (
            {t["namespaceUri"] for t in types}
            | {r["namespaceUri"] for r in relationships}
            | {o["metadata"]["typeNamespaceUri"] for o in objects.values()}
        )

    def test_every_advertised_namespace_is_one_a_type_belongs_to(self):
        used = self.used()
        for namespace in A.namespaces():
            self.assertIn(
                namespace["uri"], used,
                f"{namespace['uri']} is advertised but no type or object carries it",
            )

    def test_every_namespace_a_type_belongs_to_is_advertised(self):
        advertised = {n["uri"] for n in A.namespaces()}
        self.assertLessEqual(self.used(), advertised)

    def test_an_objects_type_namespace_is_its_types(self):
        types, _, objects = self.served()
        by_id = {t["elementId"]: t["namespaceUri"] for t in types}
        for element_id, obj in objects.items():
            with self.subTest(element_id=element_id):
                self.assertEqual(
                    obj["metadata"]["typeNamespaceUri"], by_id[obj["typeElementId"]],
                )

    def test_nothing_is_advertised_under_a_standards_bodys_authority(self):
        # A local type under mtconnect.org or opcfoundation.org would claim that body defined it.
        for namespace in A.namespaces():
            self.assertTrue(namespace["uri"].startswith("https://aber.local/"), namespace["uri"])


class TestNamespaceFilter(unittest.TestCase):
    """`GET /objecttypes` and `GET /relationshiptypes` honour `?namespaceUri=`."""

    def setUp(self):
        i3x_service._space_cache_clear()

    def tearDown(self):
        i3x_service._space_cache_clear()

    def served(self, handler, query=""):
        req = FakeRequest(path="/v1/types" + query, pg=ColumnCheckingPostgrest())
        handler(req)
        self.assertEqual(req.status, 200)
        return req.result

    def test_no_filter_returns_every_type(self):
        self.assertEqual(len(self.served(i3x_service.h_objecttypes)), len(A.SYNTHETIC_TYPES))
        self.assertEqual(
            len(self.served(i3x_service.h_relationshiptypes)), len(A.RELATIONSHIP_TYPES)
        )

    def test_each_namespace_returns_only_its_own_types(self):
        encoded = "?namespaceUri=https%3A%2F%2Faber.local%2Fi3x"
        object_types = self.served(i3x_service.h_objecttypes, encoded)
        self.assertEqual(len(object_types), len(A.SYNTHETIC_TYPES))
        self.assertEqual(self.served(i3x_service.h_relationshiptypes, encoded), [])

        relationships = self.served(
            i3x_service.h_relationshiptypes, "?namespaceUri=" + A.NS_RELATIONSHIPS
        )
        self.assertEqual(len(relationships), len(A.RELATIONSHIP_TYPES))
        self.assertEqual(
            self.served(i3x_service.h_objecttypes, "?namespaceUri=" + A.NS_RELATIONSHIPS), []
        )

    def test_an_unknown_namespace_is_an_empty_list(self):
        for handler in (i3x_service.h_objecttypes, i3x_service.h_relationshiptypes):
            with self.subTest(handler=handler.__name__):
                self.assertEqual(self.served(handler, "?namespaceUri=urn:nothing"), [])


class ModelledMetricsContractTest(unittest.TestCase):
    """
    `_modelled_metrics()` is the THIRD implementation of one rule, and was the second of two with
    no contract behind it.

    `modelledMetrics()` in frontend/src/utils/deviceTags.js, `modelled_metrics()` in
    ingestion/validate.py and `modelledMetrics()` in supabase/functions/aas-export/index.ts answer
    the same question -- which metrics a schema models. None can import another, so
    `test-harness/fixtures/modelled-metrics.json` is the seam, and each asserts it in its own runner.

    This copy's own docstring said "this is the third, and all three must agree" while agreeing
    with nothing that was checked. That is the failure mode a fixture exists to end: the aas-export
    copy, equally unchecked, was still carrying the array-`properties` divergence the fixture was
    written to record.

    WHAT THIS ONE DOES DIFFERENTLY, AND WHY IT IS NOT A DIVERGENCE. It returns a set, empty rather
    than None when a schema declares neither `properties` nor `required`. The mirrors return None
    there to mean "cannot be evaluated", a distinction `unmodelledMetrics()` needs so that "has no
    model" is not reported as "publishes beyond its model". i3X has no such caller: `_build_objects`
    iterates the result to decide which metrics to project, so "not evaluable" and "models nothing"
    produce the same address space. The NAMES must still agree exactly, and that is what is
    asserted -- an element that appears here and nowhere else is an elementId a client can
    subscribe to and never receive a value for.
    """

    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(MODELLED_METRICS_FIXTURE.read_text(encoding="utf-8"))

    def test_fixture_is_not_empty(self):
        """A contract test exercising nothing reports green while four implementations drift."""
        self.assertGreater(len(self.fixture["cases"]), 5)

    def test_every_case_matches_the_contract(self):
        for case in self.fixture["cases"]:
            with self.subTest(case=case["name"]):
                got = i3x_service._modelled_metrics(case.get("schema_definition"))
                self.assertIsInstance(got, set)
                self.assertEqual(got, set(case["expected"] or []))

    def test_an_array_properties_contributes_nothing(self):
        """
        The regression itself, pinned separately so a failure names it rather than pointing at a
        fixture row. `properties: ['A','B']` must model NOTHING -- reading it as {'0','1'} is what
        shipped in the aas-export copy of this same rule.
        """
        self.assertEqual(i3x_service._modelled_metrics({"properties": ["A", "B"]}), set())
        self.assertEqual(
            i3x_service._modelled_metrics({"properties": ["A", "B"], "required": ["Real/METRIC"]}),
            {"Real/METRIC"},
        )

    def test_a_non_dict_definition_models_nothing(self):
        """`schema_definition` is free-form JSONB, so none of these is unreachable."""
        for definition in (None, [], "properties", 7, True):
            with self.subTest(definition=definition):
                self.assertEqual(i3x_service._modelled_metrics(definition), set())


class BulkElementIdsCapTest(unittest.TestCase):
    """
    Bulk breadth is bounded, as bulk DEPTH already was.

    `maxDepth` has always been budgeted on the value path; `elementIds` was read straight off the
    request body, so one POST could name any number of elements and this server would resolve every
    one against the whole address space, on the request thread, for a caller holding nothing but a
    valid bearer token.

    A LIMIT, NOT A TRUNCATION, and that is the part worth a test. i3X bulk results are paired to
    requests BY POSITION -- the conformance suite has a dedicated check for it -- so quietly
    answering the first N would make a client mis-attribute every value after the cut. Refusing is
    the only answer that cannot be misread.
    """

    def test_a_valid_array_passes_through_unchanged(self):
        self.assertEqual(
            i3x_service._require_element_ids({"elementIds": ["a", "b"]}), ["a", "b"]
        )

    def test_a_missing_array_is_a_400_where_it_is_required(self):
        with self.assertRaises(i3x_service.Problem) as caught:
            i3x_service._require_element_ids({})
        self.assertEqual(caught.exception.status, 400)

    def test_a_non_list_is_a_400(self):
        for value in ("elementIds", 7, {"a": 1}, None):
            with self.subTest(value=value):
                with self.assertRaises(i3x_service.Problem):
                    i3x_service._require_element_ids({"elementIds": value})

    def test_absent_is_allowed_where_it_means_all(self):
        """The two type endpoints document an absent array as 'every type'."""
        self.assertEqual(i3x_service._require_element_ids({}, required=False), [])

    def test_exactly_the_cap_is_accepted(self):
        ids = [str(n) for n in range(i3x_service.MAX_BULK_ELEMENT_IDS)]
        self.assertEqual(len(i3x_service._require_element_ids({"elementIds": ids})), len(ids))

    def test_one_over_the_cap_is_refused_rather_than_truncated(self):
        ids = [str(n) for n in range(i3x_service.MAX_BULK_ELEMENT_IDS + 1)]
        with self.assertRaises(i3x_service.Problem) as caught:
            i3x_service._require_element_ids({"elementIds": ids})
        self.assertEqual(caught.exception.status, 400)
        # The message must name both numbers: "too many" without them leaves a client guessing at
        # a batch size, which is the one thing it needs in order to retry successfully.
        self.assertIn(str(len(ids)), caught.exception.detail)
        self.assertIn(str(i3x_service.MAX_BULK_ELEMENT_IDS), caught.exception.detail)

    def test_the_registration_path_is_capped_too(self):
        """
        Subscription registration takes `objects` OR `elementIds`, and is the batch that matters
        most: it does not merely answer, it adds to the client's monitored set, which outlives the
        request and is what every later poll is evaluated against.
        """
        big = [str(n) for n in range(i3x_service.MAX_BULK_ELEMENT_IDS + 1)]
        for body in ({"elementIds": big}, {"objects": [{"elementId": e} for e in big]}):
            with self.subTest(shape=next(iter(body))):
                with self.assertRaises(i3x_service.Problem) as caught:
                    i3x_service._registration_entries(body)
                self.assertEqual(caught.exception.status, 400)

        # And the ordinary case still passes through, normalised.
        self.assertEqual(
            i3x_service._registration_entries({"elementIds": ["a"]}), [{"elementId": "a"}]
        )

    def test_only_the_two_sanctioned_helpers_read_elementIds(self):
        """
        The cap is only worth having if a handler added later cannot forget it.

        Asserted against the source, like the telemetry-upsert check in test_gateway_binding.py:
        there is no seam to test through, and the failure mode of a handler reading `elementIds`
        directly is an uncapped endpoint that behaves perfectly until someone points a load
        generator at it.

        TWO readers are legitimate -- `_require_element_ids` (the bulk read endpoints) and
        `_registration_entries` (subscriptions) -- and both go through `_cap_bulk`. A third is a
        bug, whatever it looks like.
        """
        src = (Path(__file__).resolve().parent / "i3x_service.py").read_text(encoding="utf-8")
        readers = [
            src[: m.start()].count("\n") + 1
            for m in re.finditer(r'get\("elementIds"\)', src)
        ]
        sanctioned = {
            src[: src.index("def _require_element_ids")].count("\n"),
            src[: src.index("def _registration_entries")].count("\n"),
        }
        for line in readers:
            enclosing = max(
                (start for start in (
                    src[: m.start()].count("\n")
                    for m in re.finditer(r"^def \w+", src, re.M)
                ) if start < line),
                default=-1,
            )
            with self.subTest(line=line):
                self.assertIn(
                    enclosing,
                    sanctioned,
                    f"i3x_service.py:{line} reads elementIds outside _require_element_ids() and "
                    "_registration_entries(), so it is not capped by _cap_bulk()",
                )


class TestAddressSpaceCache(unittest.TestCase):
    """
    The short-TTL address-space cache.

    THE ONLY TEST HERE THAT IS ABOUT SECURITY RATHER THAN SPEED is
    `test_two_tokens_never_share_an_entry`, and it is the reason the others exist at all. The
    address space is assembled from reads made AS THE CALLER so that RLS decides what it contains.
    A cache that keyed on anything else -- or on nothing -- would serve one operator another's view
    of the plant, and it would do so silently and only on a hit, which is the worst way for a
    permissions bug to behave.
    """

    class FakePg:
        """Counts cold reads. `bearer` is what the cache keys on, so it is the whole fixture."""

        def __init__(self, bearer, marker):
            self.bearer = bearer
            self.marker = marker

        def get(self, *_args, **_kwargs):
            return []

    def setUp(self):
        self.reads = []

        def fake_read(pg):
            self.reads.append(pg.bearer)
            # A distinguishable payload per caller, so a leak across identities shows up as the
            # WRONG CONTENT rather than only as a suspicious read count.
            return {"cells": [], "gateways": [], "devices": [], "locations": {},
                    "schemas": [], "_marker": pg.marker}

        self._real_read = i3x_service._read_address_space
        i3x_service._read_address_space = fake_read
        self._real_ttl = i3x_service.ADDRESS_SPACE_TTL_SECONDS
        self._real_max = i3x_service.ADDRESS_SPACE_CACHE_MAX
        i3x_service._space_cache_clear()

    def tearDown(self):
        i3x_service._read_address_space = self._real_read
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = self._real_ttl
        i3x_service.ADDRESS_SPACE_CACHE_MAX = self._real_max
        i3x_service._space_cache_clear()

    def test_two_tokens_never_share_an_entry(self):
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 60
        alice = i3x_service._load_address_space(self.FakePg("Bearer alice", "alice"))
        bob = i3x_service._load_address_space(self.FakePg("Bearer bob", "bob"))

        self.assertEqual(alice["_marker"], "alice")
        self.assertEqual(
            bob["_marker"], "bob",
            "Bob was served Alice's address space. The cache is not keyed by the caller's token, "
            "and RLS no longer decides what an operator can see."
        )
        self.assertEqual(self.reads, ["Bearer alice", "Bearer bob"])

    def test_a_second_request_on_one_token_is_a_hit(self):
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 60
        first = i3x_service._load_address_space(self.FakePg("Bearer alice", "alice"))
        second = i3x_service._load_address_space(self.FakePg("Bearer alice", "alice"))

        self.assertEqual(len(self.reads), 1, "the second request re-read the address space")
        # The SAME object, not an equal one: several endpoints load the space two or three times
        # in one request, and the in-place index decoration on the first load is what the second
        # is meant to reuse.
        self.assertIs(first, second)

    def test_the_raw_token_is_not_a_key(self):
        # The dict outlives the request. A process dump of it should not be a wallet of live
        # bearer tokens.
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 60
        i3x_service._load_address_space(self.FakePg("Bearer supersecret", "a"))
        self.assertNotIn("Bearer supersecret", i3x_service._space_cache)
        self.assertIn(
            i3x_service._space_cache_key("Bearer supersecret"), i3x_service._space_cache
        )

    def test_an_expired_entry_is_re_read(self):
        # A negative TTL makes every entry already stale on arrival, which tests the clock branch
        # without a sleep. TTL <= 0 is the disable switch, so this also covers that path.
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 60
        i3x_service._load_address_space(self.FakePg("Bearer alice", "alice"))
        # Force the stored entry into the past rather than waiting for it.
        key = i3x_service._space_cache_key("Bearer alice")
        _expires, space = i3x_service._space_cache[key]
        i3x_service._space_cache[key] = (0.0, space)

        i3x_service._load_address_space(self.FakePg("Bearer alice", "alice"))
        self.assertEqual(len(self.reads), 2, "an expired entry was served")

    def test_ttl_of_zero_disables_the_cache(self):
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 0
        for _ in range(3):
            i3x_service._load_address_space(self.FakePg("Bearer alice", "alice"))
        self.assertEqual(len(self.reads), 3)
        self.assertEqual(len(i3x_service._space_cache), 0,
                         "the disable switch still populated the cache")

    def test_the_cache_is_bounded_against_a_token_flood(self):
        """
        The key is CLIENT-CONTROLLED. Anyone who can reach the port can mint distinct entries by
        varying the Authorization header, so an unbounded dict here is a memory-exhaustion vector
        rather than merely untidy.
        """
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 60
        i3x_service.ADDRESS_SPACE_CACHE_MAX = 4
        for n in range(50):
            i3x_service._load_address_space(self.FakePg(f"Bearer t{n}", f"m{n}"))
        self.assertLessEqual(len(i3x_service._space_cache), 4)

    def test_eviction_is_least_recently_used(self):
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 60
        i3x_service.ADDRESS_SPACE_CACHE_MAX = 2
        i3x_service._load_address_space(self.FakePg("Bearer a", "a"))
        i3x_service._load_address_space(self.FakePg("Bearer b", "b"))
        # Touch A so B becomes the least recently used.
        i3x_service._load_address_space(self.FakePg("Bearer a", "a"))
        i3x_service._load_address_space(self.FakePg("Bearer c", "c"))

        keys = set(i3x_service._space_cache)
        self.assertIn(i3x_service._space_cache_key("Bearer a"), keys)
        self.assertNotIn(i3x_service._space_cache_key("Bearer b"), keys)


if __name__ == "__main__":
    unittest.main()
