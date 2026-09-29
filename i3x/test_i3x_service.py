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


class TestASubscriptionDeliversOnlyWhatItsOwnerCanSee(unittest.TestCase):
    """
    What a subscription delivers is checked again, as its owner, at each /sync, at a stream's open
    and on each keepalive tick, through the owner's own address-space read.

    Registration used to be the only RLS decision on the value path, so a caller who lost sight of
    a device kept receiving its values. Driven through a real HTTP server with the token probe
    faked. `rows` is what the fake PostgREST returns; `hide()` takes a device out of it and expires
    the cache, which is its owner losing the grant that let them read it.
    """

    DEVICE, OTHER = "dev-explicit", "dev-inherits"

    def setUp(self):
        self.alice = _jwt(sub="a1ice000-0000-4000-8000-000000000001", role="authenticated")
        self.bob = _jwt(sub="b0b00000-0000-4000-8000-000000000002", role="authenticated")
        self.rows = _seeded_rows()
        self.reads = []
        self.read_error = None
        real_read = i3x_service._read_address_space

        def read_as_caller(pg):
            self.reads.append(pg.bearer)
            if self.read_error is not None:
                raise self.read_error
            return real_read(ColumnCheckingPostgrest(self.rows, pg.bearer))

        self._saved = (
            i3x_service.registry, i3x_service._probe, i3x_service._read_address_space,
            i3x_service.SSE_KEEPALIVE_SECONDS, i3x_service.ADDRESS_SPACE_TTL_SECONDS,
        )
        i3x_service._probe = lambda bearer: None
        i3x_service._read_address_space = read_as_caller
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 60
        # Each withdrawal logs at INFO; the tests assert on state instead.
        self.addCleanup(i3x_service.logger.setLevel, i3x_service.logger.level)
        i3x_service.logger.setLevel("WARNING")
        self.registry = SubscriptionRegistry()
        self.registry.on_stream_close = i3x_service._on_registry_stream_close
        i3x_service.registry = self.registry
        i3x_service._auth_cache.clear()
        i3x_service._space_cache_clear()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), i3x_service.Handler)
        self.server.daemon_threads = True
        threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        ).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        (
            i3x_service.registry, i3x_service._probe, i3x_service._read_address_space,
            i3x_service.SSE_KEEPALIVE_SECONDS, i3x_service.ADDRESS_SPACE_TTL_SECONDS,
        ) = self._saved
        i3x_service._auth_cache.clear()
        i3x_service._space_cache_clear()

    # -- helpers -------------------------------------------------------------------------------
    def call(self, path, auth, body):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        try:
            conn.request("POST", "/v1" + path, body=json.dumps(body).encode("utf-8"),
                         headers={"Content-Type": "application/json", "Authorization": auth})
            resp = conn.getresponse()
            raw = resp.read()
            if resp.getheader("Content-Type") == "application/json":
                return resp.status, json.loads(raw)
            return resp.status, raw.decode("utf-8")
        finally:
            conn.close()

    def create(self, auth):
        status, payload = self.call("/subscriptions", auth, {"clientId": "c"})
        self.assertEqual(status, 200, payload)
        return payload["result"]["subscriptionId"]

    def register(self, auth, sid, element_ids):
        body = {"clientId": "c", "subscriptionId": sid, "elementIds": element_ids}
        status, payload = self.call("/subscriptions/register", auth, body)
        self.assertTrue(status == 200 and payload["success"], payload)

    def sync(self, auth, sid, last=None):
        body = {"clientId": "c", "subscriptionId": sid}
        if last is not None:
            body["lastSequenceNumber"] = last
        return self.call("/subscriptions/sync", auth, body)

    def subscription(self, auth, sid):
        principal = i3x_service._authenticate(auth).principal
        return self.registry.get_owned("c", sid, principal=principal)

    def hide(self, sparkplug_id):
        device = next(d for d in self.rows["devices"] if d["sparkplug_id"] == sparkplug_id)
        self.rows["devices"].remove(device)
        self.rows["device_locations"] = [
            row for row in self.rows["device_locations"] if row["device_id"] != device["id"]
        ]
        i3x_service._space_cache_clear()

    @staticmethod
    def push(sparkplug_id, value):
        i3x_service._stage_and_push(sparkplug_id, {"Temperature": {"value": value, "timestamp": None}})

    @staticmethod
    def delivered(batches):
        return [(u["elementId"], u["value"]["Temperature"]) for b in batches for u in b["updates"]]

    def stream(self, sub, bearer):
        """`_serve_stream` on its own thread, ticking every 50 ms, over a real socket pair."""
        i3x_service.SSE_KEEPALIVE_SECONDS = 0.05
        client_end, server_end = socket.socketpair()
        self.addCleanup(server_end.close)
        self.addCleanup(client_end.close)
        writer = _RecordingWriter()
        req = _StreamRequest(server_end, writer)
        backlog = self.registry.open_stream(sub)
        thread = threading.Thread(
            target=i3x_service._serve_stream,
            args=(req, sub, backlog, bearer, i3x_service.Caller(sub.principal, None)),
            daemon=True,
        )
        thread.start()
        return req, writer, client_end, thread

    @staticmethod
    def wait_until(condition, timeout=10.0):
        """For state another thread changes: polled, bounded, and never a bare sleep."""
        deadline = time.monotonic() + timeout
        while not condition():
            if time.monotonic() > deadline:
                return False
            time.sleep(0.01)
        return True

    # -- /sync ---------------------------------------------------------------------------------
    def test_the_next_sync_withdraws_a_device_and_reports_it(self):
        sid = self.create(self.alice)
        self.register(self.alice, sid, [self.DEVICE, self.OTHER])
        self.push(self.DEVICE, 1.0)
        self.push(self.OTHER, 2.0)
        self.hide(self.DEVICE)
        self.push(self.DEVICE, 3.0)

        status, payload = self.sync(self.alice, sid)
        self.assertEqual(status, 206, payload)
        self.assertEqual(self.delivered(payload["result"]), [(self.OTHER, 2.0)],
                         "a value queued for a device its owner can no longer see was delivered")
        detail = payload["responseDetail"]
        self.assertEqual((detail["status"], detail["title"]), (206, "Elements left this caller's view"))
        self.assertIn(self.DEVICE, detail["detail"])
        self.assertNotIn(self.OTHER, detail["detail"])

        self.push(self.DEVICE, 4.0)
        self.push(self.OTHER, 5.0)
        last = payload["result"][-1]["sequenceNumber"]
        status, payload = self.sync(self.alice, sid, last)
        self.assertEqual(status, 200, "the removal was reported twice")
        self.assertEqual(self.delivered(payload["result"]), [(self.OTHER, 5.0)])
        listed = self.call("/subscriptions/list", self.alice, {"clientId": "c", "subscriptionIds": [sid]})
        monitored = listed[1]["results"][0]["result"]["monitoredObjects"]
        self.assertEqual([m["elementId"] for m in monitored], [self.OTHER])

    def test_a_metric_follows_its_device(self):
        sid = self.create(self.alice)
        sub = self.subscription(self.alice, sid)
        # Registered directly: a metric is an Object only once metrics are components.
        self.registry.register(sub, [{"elementId": self.DEVICE + "/Temperature"},
                                     {"elementId": self.OTHER + "/Axes/X/POSITION"}])
        visible = i3x_service._visible_to(self.alice)
        self.assertTrue(visible(self.OTHER + "/Axes/X/POSITION"), "split at the first /")
        self.assertTrue(visible("gwy-1"))
        self.assertFalse(visible("gwy-1/Temperature"), "only a device's metric follows it")
        self.assertFalse(visible("dev-nobody/Temperature"))

        self.hide(self.DEVICE)
        status, payload = self.sync(self.alice, sid)
        self.assertEqual(status, 206, payload)
        self.assertIn(self.DEVICE + "/Temperature", payload["responseDetail"]["detail"])
        self.assertEqual(list(sub.monitored), [self.OTHER + "/Axes/X/POSITION"])

    def test_a_check_costs_one_read_per_cache_ttl_per_caller(self):
        sid = self.create(self.alice)
        self.register(self.alice, sid, [self.DEVICE])
        for _ in range(3):
            self.assertEqual(self.sync(self.alice, sid)[0], 200)
        theirs = self.create(self.bob)
        self.register(self.bob, theirs, [self.OTHER])
        self.assertEqual(self.sync(self.bob, theirs)[0], 200)
        self.assertEqual(self.reads, [self.alice, self.bob])

        i3x_service._space_cache_clear()
        self.sync(self.alice, sid)
        self.assertEqual(self.reads, [self.alice, self.bob, self.alice])

    def test_a_subscription_holding_nothing_is_not_read_for(self):
        sid = self.create(self.alice)
        self.assertEqual(self.sync(self.alice, sid), (200, {"success": True, "result": []}))
        self.assertEqual(self.reads, [])

    def test_a_failed_read_acknowledges_delivers_and_withdraws_nothing(self):
        sid = self.create(self.alice)
        self.register(self.alice, sid, [self.DEVICE])
        self.push(self.DEVICE, 1.0)
        first = self.sync(self.alice, sid)[1]["result"][-1]["sequenceNumber"]
        self.push(self.DEVICE, 2.0)
        self.read_error = SubscriptionError(502, "Bad Gateway", "Reading devices: upstream down")
        i3x_service._space_cache_clear()
        status, payload = self.sync(self.alice, sid, first)
        self.assertEqual(status, 502, payload)

        self.read_error = None
        status, payload = self.sync(self.alice, sid)
        self.assertEqual(
            (status, self.delivered(payload["result"])),
            (200, [(self.DEVICE, 1.0), (self.DEVICE, 2.0)]),
        )

    # -- streams -------------------------------------------------------------------------------
    def test_a_stream_tick_stops_a_device_that_left_the_view(self):
        sid = self.create(self.alice)
        self.register(self.alice, sid, [self.DEVICE, self.OTHER])
        sub = self.subscription(self.alice, sid)
        req, writer, client_end, thread = self.stream(sub, self.alice)
        self.push(self.DEVICE, 1.0)
        self.assertTrue(writer.wait_for('"Temperature": 1.0'), writer.text())

        self.hide(self.DEVICE)
        self.assertTrue(self.wait_until(lambda: self.DEVICE not in sub.monitored),
                        "no tick withdrew the device")
        self.push(self.DEVICE, 5.0)
        self.push(self.OTHER, 6.0)
        self.assertTrue(writer.wait_for('"Temperature": 6.0'), writer.text())
        self.assertNotIn('"Temperature": 5.0', writer.text())
        self.assertTrue(thread.is_alive(), "the stream ended while an element remained")

        client_end.close()
        thread.join(10)
        status, payload = self.sync(self.alice, sid)
        self.assertEqual(status, 206, "the next /sync did not report what the stream withdrew")
        self.assertIn(self.DEVICE, payload["responseDetail"]["detail"])

    def test_a_stream_whose_last_element_left_ends_cleanly(self):
        sid = self.create(self.alice)
        self.register(self.alice, sid, [self.DEVICE])
        sub = self.subscription(self.alice, sid)
        req, writer, _, thread = self.stream(sub, self.alice)

        self.hide(self.DEVICE)
        thread.join(10)
        self.assertFalse(thread.is_alive(), "the stream outlived its last element")
        self.assertTrue(writer.text().endswith("0\r\n\r\n"), "the stream was not ended cleanly")
        self.assertFalse(req.close_connection)
        self.assertFalse(sub.stream_open)

        status, payload = self.sync(self.alice, sid)
        self.assertEqual((status, payload["result"]), (206, []))
        self.assertIn(self.DEVICE, payload["responseDetail"]["detail"])
        self.assertEqual(self.sync(self.alice, sid), (200, {"success": True, "result": []}))

    def test_a_stream_opened_after_the_last_element_left_ends_at_once(self):
        sid = self.create(self.alice)
        self.register(self.alice, sid, [self.DEVICE])
        self.push(self.DEVICE, 1.0)
        self.hide(self.DEVICE)

        status, body = self.call("/subscriptions/stream", self.alice, {"clientId": "c", "subscriptionId": sid})
        self.assertEqual((status, body), (200, ""), "the backlog of a withdrawn device was streamed")
        status, payload = self.sync(self.alice, sid)
        self.assertEqual((status, payload["result"]), (206, []))
        self.assertIn(self.DEVICE, payload["responseDetail"]["detail"])


class TestWithdrawingAnElement(unittest.TestCase):
    """The registry's half: what `withdraw` removes and keeps, and how its report is held."""

    @staticmethod
    def queue(registry, sub):
        batches, _ = registry.sync(sub)
        return [(b["sequenceNumber"], [u["elementId"] for u in b["updates"]]) for b in batches]

    def test_it_removes_the_element_and_its_queued_updates_only(self):
        registry, _ = make_registry()
        sub = registry.create("c")
        registry.register(sub, [{"elementId": "a"}, {"elementId": "b"}])
        stage(registry, "a")
        stage(registry, "b")
        registry.stage({eid: {"value": 1, "quality": "Good", "timestamp": None} for eid in ("a", "b")})

        self.assertEqual(registry.withdraw(sub, lambda eid: eid != "b"), (["b"], False))
        self.assertEqual(list(sub.monitored), ["a"])
        # The batch left empty is gone, so its number is a gap; the mixed one keeps its number.
        self.assertEqual(self.queue(registry, sub), [(1, ["a"]), (3, ["a"])])

    def test_an_unregistered_elements_queued_updates_are_withheld_too(self):
        registry, _ = make_registry()
        sub = registry.create("c")
        registry.register(sub, [{"elementId": "a"}, {"elementId": "b"}])
        stage(registry, "b")
        registry.unregister(sub, ["b"])
        self.assertEqual(registry.withdraw(sub, lambda eid: eid != "b"), (["b"], False))
        self.assertEqual(self.queue(registry, sub), [])

    def test_emptied_means_this_call_removed_the_last_element(self):
        registry, _ = make_registry()
        sub = registry.create("c")
        self.assertEqual(registry.withdraw(sub, lambda eid: False), ([], False))
        registry.register(sub, [{"elementId": "a"}])
        self.assertEqual(registry.withdraw(sub, lambda eid: False), (["a"], True))
        self.assertEqual(registry.withdraw(sub, lambda eid: False), ([], False))

    def test_the_report_is_held_until_taken_once(self):
        registry, _ = make_registry()
        sub = registry.create("c")
        registry.register(sub, [{"elementId": "a"}, {"elementId": "b"}])
        registry.withdraw(sub, lambda eid: eid != "a")
        registry.withdraw(sub, lambda eid: False)
        self.assertEqual(registry.take_withdrawn(sub), ["a", "b"])
        self.assertEqual(registry.take_withdrawn(sub), [])

        registry.register(sub, [{"elementId": "a"}])
        registry.withdraw(sub, lambda eid: False)
        registry.register(sub, [{"elementId": "a"}])
        self.assertEqual(registry.take_withdrawn(sub), [], "a re-registered element was reported")

    def test_overflow_and_a_withdrawal_share_one_detail(self):
        detail = i3x_service._sync_detail(True, ["dev-a", "dev-b/Temperature"])
        self.assertEqual(detail["status"], 206)
        self.assertIn("queue overflow", detail["title"])
        self.assertIn("left this caller's view", detail["title"])
        self.assertIn(str(i3x_service.registry.queue_limit), detail["detail"])
        self.assertIn("dev-a, dev-b/Temperature", detail["detail"])
        self.assertIsNone(i3x_service._sync_detail(False, []))


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


class TestAMessageReachesEachRegistration(unittest.TestCase):
    """
    The MQTT side and the registry together: `on_message` builds what some registration watches,
    and the registry's depth rule decides which subscription each update reaches.
    """

    DEVICE, NODE = "dev-reach-499", "node-1"
    METRIC = DEVICE + "/Temperature"

    def setUp(self):
        self._real_registry = i3x_service.registry
        self.registry = SubscriptionRegistry()
        i3x_service.registry = self.registry
        i3x_service._liveness_clear()
        with i3x_service._values_lock:
            i3x_service._values.pop(self.DEVICE, None)

    def tearDown(self):
        i3x_service.registry = self._real_registry
        i3x_service._liveness_clear()
        with i3x_service._values_lock:
            i3x_service._values.pop(self.DEVICE, None)

    def subscribe(self, element_id, depth=1):
        sub = self.registry.create(f"client-{element_id}-{depth}")
        self.registry.register(sub, [{"elementId": element_id, "maxDepth": depth}])
        return sub

    def delivered(self, sub):
        """Each queued batch as [(elementId, quality)], then the queue acknowledged."""
        batches, _ = self.registry.sync(sub)
        self.registry.sync(sub, last_sequence_number=-1)
        return [[(u["elementId"], u["quality"]) for u in b["updates"]] for b in batches]

    def test_a_ddata_reaches_the_device_unbounded_and_the_metric_alone(self):
        unbounded, shallow = self.subscribe(self.DEVICE, 0), self.subscribe(self.DEVICE, 1)
        alone = self.subscribe(self.METRIC)
        i3x_service.on_message(None, None, _ddata(self.DEVICE, 1.0))
        ids = lambda sub: [[e for e, _ in batch] for batch in self.delivered(sub)]  # noqa: E731
        self.assertEqual(ids(unbounded), [[self.DEVICE, self.METRIC]])
        self.assertEqual(ids(shallow), [[self.DEVICE]])
        self.assertEqual(ids(alone), [[self.METRIC]])

    def test_an_ndeath_reaches_the_gateway_registration(self):
        gateway, alone = self.subscribe(self.NODE, 0), self.subscribe(self.METRIC)
        # The device's traffic is how the MQTT side learns which node it is behind.
        i3x_service.on_message(None, None, _ddata(self.DEVICE, 1.0))
        self.assertEqual(self.delivered(gateway), [], "a device's data reached its gateway")
        self.delivered(alone)

        i3x_service.on_message(None, None, _spb("NDEATH", node=self.NODE, group="TestGroup"))
        batches, _ = self.registry.sync(gateway)
        updates = [u for batch in batches for u in batch["updates"]]
        self.assertEqual([(u["elementId"], u["value"]["status"], u["quality"]) for u in updates],
                         [(self.NODE, "OFFLINE", "Good")])
        # Its device's values are now held, so the metric registered alone hears that too.
        self.assertEqual(self.delivered(alone), [[(self.METRIC, "Uncertain")]])


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


class TestDeliveryFollowsDepth(unittest.TestCase):
    """
    Who receives a staged update. A metric `<device>/<name>` reaches subscriptions that registered
    it, and those that registered its device at maxDepth 0 or 2 or more. Nothing else composes:
    a gateway and a location receive only their own updates. Envelopes are built by hand here;
    what gets staged, and when, is the MQTT side's.
    """

    DEVICE, GATEWAY = "dev-one", "gwy-1"
    METRIC = DEVICE + "/Axes/X/POSITION"
    OTHER_METRIC = DEVICE + "/Controller/EXECUTION"

    @staticmethod
    def vqt(element_id, value, quality="Good"):
        return {"elementId": element_id, "value": value, "quality": quality,
                "timestamp": "2026-09-28T10:00:00Z"}

    def device_change(self):
        """A DDATA's envelopes: the device's map, and the one metric that changed."""
        return {self.DEVICE: self.vqt(self.DEVICE, {"Axes/X/POSITION": 1.5}),
                self.METRIC: self.vqt(self.METRIC, 1.5)}

    def gateway_change(self):
        return {self.GATEWAY: self.vqt(self.GATEWAY, {"status": "OFFLINE"}, "Uncertain")}

    def subscribe(self, element_id, depth=None):
        sub = self.registry.create("c")
        entry = {"elementId": element_id}
        if depth is not None:
            entry["maxDepth"] = depth
        self.assertTrue(self.registry.register(sub, [entry])[0]["success"])
        return sub

    def delivered(self, sub):
        """The elementIds of each queued batch, then the queue acknowledged."""
        batches, _ = self.registry.sync(sub)
        self.registry.sync(sub, last_sequence_number=-1)
        return [[u["elementId"] for u in b["updates"]] for b in batches]

    def setUp(self):
        self.registry, _ = make_registry()

    def test_a_component_reaches_its_device_registered_unbounded(self):
        sub = self.subscribe(self.DEVICE, 0)
        self.registry.stage(self.device_change())
        self.assertEqual(self.delivered(sub), [[self.DEVICE, self.METRIC]])

    def test_a_component_reaches_its_device_registered_at_two_or_more(self):
        for depth in (2, 3):
            with self.subTest(maxDepth=depth):
                sub = self.subscribe(self.DEVICE, depth)
                self.registry.stage(self.device_change())
                self.assertEqual(self.delivered(sub), [[self.DEVICE, self.METRIC]])

    def test_a_component_does_not_reach_its_device_registered_at_one(self):
        for depth in (1, None):
            with self.subTest(maxDepth=depth):
                sub = self.subscribe(self.DEVICE, depth)
                self.registry.stage(self.device_change())
                self.assertEqual(self.delivered(sub), [[self.DEVICE]])
                self.registry.stage({self.METRIC: self.vqt(self.METRIC, 2.0)})
                self.assertEqual(self.delivered(sub), [], "a component alone reached maxDepth 1")

    def test_a_metric_registered_alone_receives_only_its_own_changes(self):
        sub = self.subscribe(self.METRIC, 0)
        self.registry.stage(self.device_change())
        self.registry.stage({self.OTHER_METRIC: self.vqt(self.OTHER_METRIC, "ACTIVE")})
        self.registry.stage({self.DEVICE: self.vqt(self.DEVICE, {})})
        self.registry.stage(self.gateway_change())
        self.assertEqual(self.delivered(sub), [[self.METRIC]])

    def test_the_parent_is_the_text_before_the_first_slash(self):
        sub = self.subscribe(self.DEVICE, 0)
        near = "dev-one2/Axes/X/POSITION"
        self.registry.stage({near: self.vqt(near, 1.0)})
        self.assertEqual(self.delivered(sub), [], "a device whose id merely starts the same")
        self.registry.stage({self.OTHER_METRIC: self.vqt(self.OTHER_METRIC, "ACTIVE")})
        self.assertEqual(self.delivered(sub), [[self.OTHER_METRIC]])

    def test_a_gateway_receives_its_own_envelope_and_composes_nothing(self):
        gateway = self.subscribe(self.GATEWAY, 0)
        device = self.subscribe(self.DEVICE, 0)
        self.registry.stage(self.gateway_change())
        self.registry.stage(self.device_change())
        self.assertEqual(self.delivered(gateway), [[self.GATEWAY]])
        self.assertEqual(self.delivered(device), [[self.DEVICE, self.METRIC]])
        batch = self.registry.stage(self.gateway_change())
        self.assertEqual(batch, [], "no stream is open, so none is returned to wake")
        updates = self.registry.sync(gateway)[0][0]["updates"]
        self.assertEqual(updates, [self.gateway_change()[self.GATEWAY]])

    def test_a_location_receives_nothing_from_below(self):
        for element_id in (CELL_A, A.SITE_ELEMENT_ID, A.UNASSIGNED_ELEMENT_ID):
            with self.subTest(location=element_id):
                sub = self.subscribe(element_id, 0)
                self.registry.stage(self.device_change())
                self.registry.stage(self.gateway_change())
                self.assertEqual(self.delivered(sub), [])

    def test_an_update_is_delivered_once_to_a_subscription_holding_both(self):
        sub = self.registry.create("c")
        self.registry.register(sub, [{"elementId": self.DEVICE, "maxDepth": 0},
                                     {"elementId": self.METRIC, "maxDepth": 1}])
        self.registry.stage(self.device_change())
        self.assertEqual(self.delivered(sub), [[self.DEVICE, self.METRIC]])

    def test_a_stream_is_woken_for_a_component_alone(self):
        sub = self.subscribe(self.DEVICE, 0)
        self.registry.open_stream(sub)
        self.assertEqual(self.registry.stage({self.METRIC: self.vqt(self.METRIC, 2.0)}), [sub])
        self.assertEqual(
            [u["elementId"] for b in self.registry.drain(sub) for u in b["updates"]], [self.METRIC]
        )

    def test_a_repeat_registration_keeps_the_first_depth(self):
        sub = self.subscribe(self.DEVICE, 1)
        result = self.registry.register(sub, [{"elementId": self.DEVICE, "maxDepth": 0}])
        self.assertEqual(result, [{"success": True, "elementId": self.DEVICE, "result": None}])
        self.assertEqual(sub.to_json()["monitoredObjects"],
                         [{"elementId": self.DEVICE, "maxDepth": 1}])
        self.registry.stage(self.device_change())
        self.assertEqual(self.delivered(sub), [[self.DEVICE]])

        # Unregistering first is how a client changes the depth.
        self.registry.unregister(sub, [self.DEVICE])
        self.registry.register(sub, [{"elementId": self.DEVICE, "maxDepth": 0}])
        self.assertEqual(sub.monitored[self.DEVICE], 0)

    def test_the_registry_refuses_a_non_string_id_per_entry(self):
        sub = self.registry.create("c")
        results = self.registry.register(
            sub, [{"elementId": ["x"]}, {"elementId": 5}, {}, {"elementId": self.DEVICE}]
        )
        self.assertEqual([r["success"] for r in results], [False, False, False, True])
        self.assertEqual({r["responseDetail"]["status"] for r in results[:3]}, {400})
        self.assertEqual(list(sub.monitored), [self.DEVICE])


class TestRegistrationRequests(unittest.TestCase):
    """
    `/subscriptions/register` and `/unregister` through their handlers, over `_metric_rows()`:
    `maxDepth` read from the top level and validated, results paired with requests by position,
    and a malformed elementId failing only its own item.
    """

    DEVICE, METRIC, UNKNOWN = "dev-one", "dev-one/Axes/X/POSITION", "dev-unknown"

    def setUp(self):
        self._saved = (i3x_service.registry, i3x_service.ADDRESS_SPACE_TTL_SECONDS)
        self.registry = SubscriptionRegistry()
        i3x_service.registry = self.registry
        i3x_service.ADDRESS_SPACE_TTL_SECONDS = 0
        self.sub = self.registry.create("c", principal="p")

    def tearDown(self):
        i3x_service.registry, i3x_service.ADDRESS_SPACE_TTL_SECONDS = self._saved

    def call(self, handler, pg=True, **fields):
        body = {"clientId": "c", "subscriptionId": self.sub.subscription_id, **fields}
        req = FakeRequest(body=body, pg=ColumnCheckingPostgrest(_metric_rows()) if pg else None)
        req.caller = i3x_service.Caller("p", None)
        handler(req)
        return req.result

    def register(self, **fields):
        return self.call(i3x_service.h_sub_register, **fields)

    def listed(self):
        req = FakeRequest(body={"clientId": "c", "subscriptionIds": [self.sub.subscription_id]})
        req.caller = i3x_service.Caller("p", None)
        i3x_service.h_sub_list(req)
        return req.result[0]["result"]["monitoredObjects"]

    @staticmethod
    def outcomes(results):
        return [(r["elementId"], r["success"], (r.get("responseDetail") or {}).get("status"))
                for r in results]

    def test_max_depth_is_read_from_the_top_level_and_listed(self):
        self.register(elementIds=[self.DEVICE], maxDepth=0)
        self.register(elementIds=[self.METRIC])
        self.assertEqual(self.listed(), [{"elementId": self.DEVICE, "maxDepth": 0},
                                         {"elementId": self.METRIC, "maxDepth": 1}])

    def test_the_top_level_depth_applies_to_the_objects_form_too(self):
        self.register(objects=[{"elementId": self.DEVICE, "maxDepth": 5}], maxDepth=2)
        self.assertEqual(self.listed(), [{"elementId": self.DEVICE, "maxDepth": 2}])

    def test_a_repeat_registration_succeeds_and_keeps_the_first_depth(self):
        self.register(elementIds=[self.DEVICE], maxDepth=0)
        results = self.register(elementIds=[self.DEVICE], maxDepth=1)
        self.assertEqual(self.outcomes(results), [(self.DEVICE, True, None)])
        self.assertEqual(self.listed(), [{"elementId": self.DEVICE, "maxDepth": 0}])

    def test_an_invalid_max_depth_is_a_400_before_anything_is_read(self):
        for bad in ("0", -1, True, 1.5, [0], {"n": 0}):
            with self.subTest(maxDepth=bad):
                with self.assertRaises(i3x_service.Problem) as caught:
                    self.register(pg=False, elementIds=[self.DEVICE], maxDepth=bad)
                self.assertEqual(caught.exception.status, 400)
                self.assertIn("maxDepth", caught.exception.detail)
        self.assertEqual(list(self.sub.monitored), [])

    def test_results_pair_with_requests_by_position_when_an_id_repeats(self):
        results = self.register(elementIds=[self.DEVICE, self.UNKNOWN, self.DEVICE])
        self.assertEqual(self.outcomes(results), [(self.DEVICE, True, None),
                                                  (self.UNKNOWN, False, 404),
                                                  (self.DEVICE, True, None)])
        results = self.call(i3x_service.h_sub_unregister,
                            elementIds=[self.UNKNOWN, self.DEVICE, self.UNKNOWN, self.DEVICE])
        self.assertEqual(self.outcomes(results), [(self.UNKNOWN, False, 404),
                                                  (self.DEVICE, True, None),
                                                  (self.UNKNOWN, False, 404),
                                                  (self.DEVICE, True, None)])
        self.assertEqual(list(self.sub.monitored), [])

    def test_a_non_string_element_id_is_a_400_item_not_a_500(self):
        bad = [["x"], 5, {"a": 1}, None, "", True]
        for handler in (i3x_service.h_sub_register, i3x_service.h_sub_unregister):
            for shape in ("elementIds", "objects"):
                with self.subTest(handler=handler.__name__, shape=shape):
                    entries = bad + [self.DEVICE]
                    named = list(bad)
                    if shape == "objects":
                        entries = [{"elementId": e} for e in entries]
                    else:
                        # A dictionary entry names its own `elementId`, which this one lacks.
                        named[2] = None
                    results = self.call(handler, **{shape: entries})
                    self.assertEqual(self.outcomes(results),
                                     [(e, False, 400) for e in named] + [(self.DEVICE, True, None)])
        # The body #499's comment reported as a 500.
        results = self.register(objects=[{"elementId": ["x"]}])
        self.assertEqual(self.outcomes(results), [(["x"], False, 400)])


class TestSubscriptionIdsAreChecked(unittest.TestCase):
    """
    A `subscriptionId` that is not a string is a 400, and so is a `subscriptionIds` that is not an
    array; a non-string entry in one fails its own item, at its position. Each used to reach a dict
    lookup and answer 500, or be iterated character by character.
    """

    BAD = (["x"], 5, {"a": 1}, True)

    def setUp(self):
        self._saved = i3x_service.registry
        self.registry = SubscriptionRegistry()
        i3x_service.registry = self.registry
        self.sub = self.registry.create("c", principal="p")

    def tearDown(self):
        i3x_service.registry = self._saved

    def call(self, handler, **fields):
        req = FakeRequest(body={"clientId": "c", **fields})
        req.caller = i3x_service.Caller("p", None)
        handler(req)
        return req.result

    @staticmethod
    def outcomes(results):
        return [(r["subscriptionId"], r["success"], (r.get("responseDetail") or {}).get("status"))
                for r in results]

    def test_a_non_string_subscription_id_is_a_400(self):
        for handler in (i3x_service.h_sub_register, i3x_service.h_sub_unregister,
                        i3x_service.h_sub_sync, i3x_service.h_sub_stream):
            for bad in self.BAD:
                with self.subTest(handler=handler.__name__, subscriptionId=bad):
                    with self.assertRaises(i3x_service.Problem) as caught:
                        self.call(handler, subscriptionId=bad)
                    self.assertEqual(caught.exception.status, 400)
                    self.assertIn("subscriptionId", caught.exception.detail)

    def test_an_absent_or_null_subscription_id_is_still_a_404(self):
        for fields in ({}, {"subscriptionId": None}):
            with self.subTest(fields=fields):
                with self.assertRaises(SubscriptionError) as caught:
                    self.call(i3x_service.h_sub_sync, **fields)
                self.assertEqual(caught.exception.status, 404)

    def test_a_non_string_entry_fails_its_own_item_in_place(self):
        sid = self.sub.subscription_id
        ids = [sid, ["x"], "nope", 5, sid]
        self.assertEqual(self.outcomes(self.call(i3x_service.h_sub_list, subscriptionIds=ids)),
                         [(sid, True, None), (["x"], False, 400), ("nope", False, 404),
                          (5, False, 400), (sid, True, None)])
        # The second delete of the same id finds nothing, and says so at its own place.
        self.assertEqual(self.outcomes(self.call(i3x_service.h_sub_delete, subscriptionIds=ids)),
                         [(sid, True, None), (["x"], False, 400), ("nope", False, 404),
                          (5, False, 400), (sid, False, 404)])
        self.assertEqual(self.registry.count(), 0)

    def test_subscription_ids_that_are_not_an_array_are_a_400(self):
        for handler in (i3x_service.h_sub_list, i3x_service.h_sub_delete):
            for bad in (self.sub.subscription_id, "", {"a": 1}, 5, True):
                with self.subTest(handler=handler.__name__, subscriptionIds=bad):
                    with self.assertRaises(i3x_service.Problem) as caught:
                        self.call(handler, subscriptionIds=bad)
                    self.assertEqual(caught.exception.status, 400)
        self.assertEqual(self.registry.count(), 1, "a string of ids deleted something")

    def test_absent_or_null_subscription_ids_list_nothing(self):
        for fields in ({}, {"subscriptionIds": None}, {"subscriptionIds": []}):
            with self.subTest(fields=fields):
                self.assertEqual(self.call(i3x_service.h_sub_list, **fields), [])


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
LOCATION_TYPES = {
    A.SITE_TYPE_ID, A.AREA_TYPE_ID, A.CELL_TYPE_ID, A.LANE_TYPE_ID, A.UNASSIGNED_TYPE_ID,
}


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

    def _bulk(self, results, detail=None):
        self.status, self.result, self.detail = (detail or {}).get("status", 200), results, detail


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
            ["areas", "cells", "device_locations", "device_schemas", "devices", "gateways",
             "metric_catalog", "schemas", "system_settings"],
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
        # The view's legacy arm: each device's devices.schema_id, since neither has submodels.
        rows["device_schemas"] = [
            {"device_id": "d-explicit", "schema_id": "s-semantic"},
            {"device_id": "d-inherits", "schema_id": "s-local"},
        ]
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
                vqt = i3x_service._current_value(objects, space, element_id)
                if vqt["value"] is None:
                    # The guide's null rule: no value is Bad or GoodNoData, and conforms to nothing.
                    self.assertIn(vqt["quality"], ("Bad", "GoodNoData"))
                    continue
                self.assertEqual(self.nonconformance(vqt["value"], schemas[type_id]), [])
                checked.add(type_id)
        self.assertEqual(
            checked, {A.SITE_TYPE_ID, A.CELL_TYPE_ID, A.UNASSIGNED_TYPE_ID, A.GATEWAY_TYPE_ID}
        )

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


MILL, OEE = "s-mill", "s-oee"
MTCONNECT = "https://aber.local/semantics/mtconnect/v2.0"


def _metric_rows() -> dict:
    """
    Five devices in one cell: one schema; two schemas, twice, attached in opposite orders; one
    schema and two metrics beyond it, quarantined; and neither a schema nor a birth.
    """
    devices = [
        {"id": "d-one", "sparkplug_id": "dev-one", "name": "One", "gateway_id": "g1",
         "schema_id": MILL, "last_birth_metrics": ["Axes/X/POSITION", "Asset_ID"]},
        {"id": "d-two", "sparkplug_id": "dev-two", "name": "Two", "gateway_id": "g1",
         "schema_id": MILL, "last_birth_metrics": ["Axes/X/POSITION", "OEE/AVAILABILITY"]},
        {"id": "d-three", "sparkplug_id": "dev-three", "name": "Three", "gateway_id": "g1"},
        {"id": "d-ext", "sparkplug_id": "dev-ext", "name": "Extended", "gateway_id": "g1",
         "schema_id": MILL, "is_quarantined": True,
         "last_birth_metrics": ["Axes/X/POSITION", "Environmental/HUMIDITY", "Vendor/COUNT"]},
        {"id": "d-bare", "sparkplug_id": "dev-bare", "name": "Bare", "gateway_id": None},
    ]
    return {
        "cells": [{"id": CELL_A, "name": "Cell A", "description": None}],
        "gateways": [{"id": "g1", "sparkplug_id": "gwy-1", "name": "Gateway", "cell_id": CELL_A}],
        "devices": devices,
        "device_locations": [
            {"device_id": d["id"], "effective_cell_id": CELL_A, "effective_area_id": None}
            for d in devices
        ],
        "schemas": [
            {"id": MILL, "schema_name": "Mill",
             "semantic_id": "https://admin-shell.io/idta/example/Mill/1/0",
             "schema_definition": {
                 "type": "object",
                 "properties": {"Axes/X/POSITION": {"type": "number"},
                                "Controller/EXECUTION": {"type": "string"}},
                 "required": ["Axes/X/POSITION"]}},
            {"id": OEE, "schema_name": "OEE", "semantic_id": None,
             "schema_definition": {"type": "object",
                                   "properties": {"OEE/AVAILABILITY": {"type": "number"}}}},
        ],
        "device_schemas": [
            {"device_id": "d-one", "schema_id": MILL},
            {"device_id": "d-two", "schema_id": MILL},
            {"device_id": "d-two", "schema_id": OEE},
            {"device_id": "d-three", "schema_id": OEE},
            {"device_id": "d-three", "schema_id": MILL},
            {"device_id": "d-ext", "schema_id": MILL},
        ],
        "metric_catalog": [
            {"name": "Axes/X/POSITION", "datatype": 10, "description": "Linear position of X",
             "units": "MILLIMETER", "standard": "MTConnect", "deprecated": False,
             "semantic_id": MTCONNECT + "/DataItemType/POSITION"},
            {"name": "Controller/EXECUTION", "datatype": 12, "description": None, "units": None,
             "standard": "MTConnect", "deprecated": False,
             "semantic_id": MTCONNECT + "/DataItemType/EXECUTION"},
            {"name": "OEE/AVAILABILITY", "datatype": 10, "description": None, "units": "PERCENT",
             "standard": "ISO 22400", "deprecated": False,
             "semantic_id": "https://aber.local/semantics/iso22400/AVAILABILITY"},
        ],
    }


class _MetricSpace(unittest.TestCase):
    """The space `_metric_rows()` reads to, with dev-ext's DBIRTH seen and two samples cached."""

    def setUp(self):
        for table in ("_values", "_alias_map", "_alias_datatypes", "_name_datatypes"):
            getattr(i3x_service, table).clear()
        i3x_service._space_cache_clear()
        i3x_service.register_birth_aliases(
            "Aber", "gwy-1", [{"name": "Environmental/HUMIDITY", "datatype": 10}],
            device_id="dev-ext",
        )
        i3x_service.record_value(
            "dev-one", "Axes/X/POSITION", 12.5, "2026-09-28T10:00:00.123+00:00"
        )
        i3x_service.record_value("dev-ext", "Axes/X/POSITION", 3.0, "2026-09-28T10:00:01Z")

    def tearDown(self):
        for table in ("_values", "_alias_map", "_alias_datatypes", "_name_datatypes"):
            getattr(i3x_service, table).clear()
        i3x_service._space_cache_clear()

    def space(self, rows=None):
        space = i3x_service._read_address_space(ColumnCheckingPostgrest(rows or _metric_rows()))
        return space, i3x_service._build_objects(space), i3x_service._build_types(space)

    def value(self, element_id):
        space, objects, _ = self.space()
        return i3x_service._current_value(objects, space, element_id)


class TestMetricsAreComponentsOfTheirDevice(_MetricSpace):
    """
    Each metric is a leaf Object, `<sparkplug_id>/<metric name>`, whose parent is its device and
    whose only edge is `ComponentOf`; the device is a composition of them and keeps its map as its
    own value. The pattern of CESMII's reference server (`pump-101`).
    """

    COMPONENTS = {
        "dev-one": ["Axes/X/POSITION", "Controller/EXECUTION"],
        "dev-two": ["Axes/X/POSITION", "Controller/EXECUTION", "OEE/AVAILABILITY"],
        "dev-three": ["Axes/X/POSITION", "Controller/EXECUTION", "OEE/AVAILABILITY"],
        "dev-ext": ["Axes/X/POSITION", "Controller/EXECUTION", "Environmental/HUMIDITY",
                    "Vendor/COUNT"],
    }

    def test_a_device_is_a_composition_of_every_modelled_and_declared_metric(self):
        _, objects, _ = self.space()
        for sid, names in self.COMPONENTS.items():
            with self.subTest(device=sid):
                device = objects[sid]
                self.assertTrue(device["isComposition"])
                self.assertEqual(device["metadata"]["relationships"]["HasComponent"],
                                 [f"{sid}/{name}" for name in names])
                for name in names:
                    self.assertIn(f"{sid}/{name}", objects)
        self.assertNotIn("dev-one/Asset_ID", objects, "identity metrics are wire plumbing")
        bare = objects["dev-bare"]
        self.assertFalse(bare["isComposition"], "no components, so not a composition")
        self.assertNotIn("HasComponent", bare["metadata"]["relationships"])

    def test_a_metric_is_a_leaf_whose_only_edge_is_to_its_device(self):
        _, objects, _ = self.space()
        metrics = {eid: o for eid, o in objects.items() if "/" in eid}
        self.assertEqual(len(metrics), sum(len(n) for n in self.COMPONENTS.values()))
        children = set()
        for obj in objects.values():
            children.update(obj["metadata"]["relationships"].get("HasChildren", []))
        for element_id, metric in metrics.items():
            sid, _, name = element_id.partition("/")
            with self.subTest(element_id=element_id):
                self.assertEqual(metric["parentId"], sid)
                self.assertEqual(metric["displayName"], name)
                self.assertEqual(metric["metadata"]["relationships"], {"ComponentOf": [sid]})
                self.assertFalse(metric["isComposition"])
                self.assertFalse(metric["isExtended"])
                self.assertNotIn(element_id, children, "HasChildren never reaches a metric")

    def test_every_edge_has_its_inverse_with_metrics_in_the_space(self):
        _, objects, _ = self.space()
        inverse = {name: reverse for name, reverse, _ in A.RELATIONSHIP_TYPES}
        missing = []
        for element_id, obj in objects.items():
            for rel, targets in obj["metadata"]["relationships"].items():
                for target in targets:
                    back = objects[target]["metadata"]["relationships"].get(inverse[rel], [])
                    if element_id not in back:
                        missing.append(f"{element_id} -{rel}-> {target} has no {inverse[rel]} back")
        self.assertEqual(missing, [], chr(10).join(missing))

    def test_a_metrics_value_is_its_latest_sample(self):
        vqt = self.value("dev-one/Axes/X/POSITION")
        self.assertEqual(vqt["elementId"], "dev-one/Axes/X/POSITION")
        self.assertEqual((vqt["value"], vqt["quality"]), (12.5, "Good"))
        self.assertEqual(vqt["timestamp"], "2026-09-28T10:00:00.123Z")

    def test_a_modelled_metric_never_published_is_good_no_data_now(self):
        before = time.time()
        vqt = self.value("dev-one/Controller/EXECUTION")
        self.assertEqual((vqt["value"], vqt["quality"]), (None, "GoodNoData"))
        # The guide forbids a null timestamp; with no sample, it is the time of the read.
        stamp = vqt["timestamp"]
        self.assertTrue(stamp.endswith("Z"), stamp)
        parsed = A.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        self.assertLessEqual(abs(parsed - before), 5)

    def test_a_quarantined_devices_metrics_are_uncertain_only_with_a_value(self):
        self.assertEqual(self.value("dev-ext/Axes/X/POSITION")["quality"], "Uncertain")
        # A null value is never Uncertain: the guide allows only Bad or GoodNoData with it, and a
        # source nobody vouches for is not "connected but silent".
        silent = self.value("dev-ext/Environmental/HUMIDITY")
        self.assertEqual((silent["value"], silent["quality"]), (None, "Bad"))

    def test_the_device_keeps_its_map_as_its_own_value(self):
        rows = _metric_rows()
        for depth, components in ((1, None), (2, True), (0, True)):
            with self.subTest(maxDepth=depth):
                i3x_service._space_cache_clear()
                req = FakeRequest(body={"elementIds": ["dev-one"], "maxDepth": depth},
                                  pg=ColumnCheckingPostgrest(rows))
                i3x_service.h_objects_value(req)
                result = req.result[0]["result"]
                self.assertTrue(result["isComposition"])
                self.assertEqual(result["value"], {"Axes/X/POSITION": 12.5})
                if components is None:
                    self.assertNotIn("components", result)
                    continue
                self.assertEqual(sorted(result["components"]),
                                 ["dev-one/Axes/X/POSITION", "dev-one/Controller/EXECUTION"])
                self.assertEqual(result["components"]["dev-one/Axes/X/POSITION"]["value"], 12.5)

    def test_a_catalog_metric_is_typed_by_its_catalog_row(self):
        _, objects, types = self.space()
        types = {t["elementId"]: t for t in types}
        metric = objects["dev-one/Axes/X/POSITION"]
        self.assertEqual(metric["typeElementId"], "i3x:type:metric:Axes/X/POSITION")
        self.assertEqual(metric["metadata"]["typeNamespaceUri"], MTCONNECT)
        self.assertEqual(metric["metadata"]["sourceTypeId"], MTCONNECT + "/DataItemType/POSITION")
        position = types[metric["typeElementId"]]
        self.assertEqual(position["schema"], {"type": "number", "x-unit": "MILLIMETER",
                                              "description": "Linear position of X"})
        self.assertEqual(position["namespaceUri"], MTCONNECT)
        execution = types[objects["dev-one/Controller/EXECUTION"]["typeElementId"]]
        self.assertEqual(execution["schema"], {"type": "string"})
        # Every device carrying the metric shares the one type.
        self.assertEqual(objects["dev-two/Axes/X/POSITION"]["typeElementId"],
                         metric["typeElementId"])

    def test_an_uncatalogued_metric_takes_its_birth_datatype_else_unknown_type(self):
        _, objects, types = self.space()
        types = {t["elementId"]: t for t in types}
        humidity = objects["dev-ext/Environmental/HUMIDITY"]
        self.assertEqual(humidity["typeElementId"], "i3x:type:sparkplug:Double")
        self.assertEqual(types[humidity["typeElementId"]]["schema"], {"type": "number"})
        # No catalog row and no DBIRTH seen since startup: nothing says what it is.
        count = objects["dev-ext/Vendor/COUNT"]
        self.assertEqual(count["typeElementId"], A.UNKNOWN_TYPE_ID)
        self.assertEqual(types[A.UNKNOWN_TYPE_ID]["displayName"], "UnknownType")

    def test_every_object_names_a_served_type_and_says_what_it_says(self):
        space, objects, types = self.space()
        types = {t["elementId"]: t for t in types}
        json_types = TestObjectsMatchTheirTypes.JSON_TYPES
        for element_id, obj in objects.items():
            with self.subTest(element_id=element_id):
                served = types[obj["typeElementId"]]
                self.assertEqual(obj["metadata"]["sourceTypeId"], served["sourceTypeId"])
                self.assertEqual(obj["metadata"]["typeNamespaceUri"], served["namespaceUri"])
                if "/" not in element_id:
                    continue
                value = i3x_service._current_value(objects, space, element_id)["value"]
                if value is not None and "type" in served["schema"]:
                    self.assertTrue(json_types[served["schema"]["type"]](value), (value, served))

    def test_element_ids_are_unique_across_objects_and_types(self):
        _, objects, types = self.space()
        ids = list(objects) + [t["elementId"] for t in types]
        ids += [r["elementId"] for r in A.relationship_types()]
        self.assertEqual(len(ids), len(set(ids)))
        for element_id in ids:
            with self.subTest(element_id=element_id):
                self.assertEqual(element_id, element_id.strip())
                self.assertIsNone(re.search(r"[\x00-\x1f\x7f]", element_id))

    def test_a_name_that_cannot_be_an_element_id_is_not_a_component(self):
        rows = _metric_rows()
        rows["devices"][0]["last_birth_metrics"] = ["Axes/X/POSITION", " padded", "bell\x07"]
        _, objects, _ = self.space(rows)
        self.assertEqual(objects["dev-one"]["metadata"]["relationships"]["HasComponent"],
                         ["dev-one/Axes/X/POSITION", "dev-one/Controller/EXECUTION"])
        # It is still published beyond the schema, so still an extension.
        self.assertIn(" padded", objects["dev-one"]["metadata"]["schemaExtensions"])

    def test_a_metric_can_be_registered_and_its_history_asked_for(self):
        rows = _metric_rows()
        rows["telemetry"] = []
        metric = "dev-one/Axes/X/POSITION"
        sub = i3x_service.registry.create("client-metrics", "", principal="p-metrics")
        try:
            req = FakeRequest(body={"clientId": "client-metrics",
                                    "subscriptionId": sub.subscription_id,
                                    "elementIds": [metric]},
                              pg=ColumnCheckingPostgrest(rows))
            req.caller = i3x_service.Caller("p-metrics", None)
            i3x_service.h_sub_register(req)
            self.assertEqual(req.result, [{"success": True, "elementId": metric, "result": None}])
            i3x_service.h_sub_sync(req)
            self.assertEqual(req.status, 200)
        finally:
            i3x_service.registry.delete("client-metrics", sub.subscription_id,
                                        principal="p-metrics")
        req = FakeRequest(body={"elementIds": [metric, "dev-one"], "maxDepth": 0,
                                "startTime": "2026-09-28T00:00:00Z",
                                "endTime": "2026-09-29T00:00:00Z"},
                          pg=ColumnCheckingPostgrest(rows))
        i3x_service.h_objects_history(req)
        self.assertTrue(all(item["success"] for item in req.result), req.result)
        self.assertEqual(req.result[0]["result"]["values"], [])

    def test_get_namespaces_lists_the_ones_the_metric_types_use(self):
        req = FakeRequest(pg=ColumnCheckingPostgrest(_metric_rows()))
        i3x_service.h_namespaces(req)
        self.assertEqual(
            [n["uri"] for n in req.result],
            [A.NS_LOCAL, A.NS_RELATIONSHIPS, "https://aber.local/semantics/iso22400", MTCONNECT],
        )


class TestDevicesAreTypedByEveryAttachedSchema(_MetricSpace):
    """
    A device is typed by every schema the `device_schemas` view attaches, not by the legacy
    `devices.schema_id` alone: one schema is its type; several are one synthesized `allOf` type per
    distinct set. `isExtended` is computed against their union.
    """

    def test_one_schema_is_the_devices_type(self):
        _, objects, _ = self.space()
        self.assertEqual(objects["dev-one"]["typeElementId"], MILL)
        self.assertEqual(objects["dev-one"]["metadata"]["sourceTypeId"],
                         "https://admin-shell.io/idta/example/Mill/1/0")

    def test_several_schemas_are_one_type_per_set_whatever_the_order(self):
        _, objects, types = self.space()
        type_id = A.schema_set_type_id([OEE, MILL])
        self.assertEqual(type_id, A.SCHEMA_SET_TYPE_PREFIX + MILL + "+" + OEE)
        self.assertEqual(objects["dev-two"]["typeElementId"], type_id)
        self.assertEqual(objects["dev-three"]["typeElementId"], type_id)
        served = [t for t in types if t["elementId"] == type_id]
        self.assertEqual(len(served), 1, "one type for the set, not one per device")
        rows = {s["id"]: s for s in _metric_rows()["schemas"]}
        self.assertEqual(served[0]["schema"], {
            "type": "object",
            "allOf": [rows[MILL]["schema_definition"], rows[OEE]["schema_definition"]],
        })
        self.assertEqual(served[0]["displayName"], "Mill + OEE")
        self.assertEqual(served[0]["related"],
                         {"relationshipType": "InheritsFrom", "types": [MILL, OEE]})
        self.assertEqual(objects["dev-two"]["metadata"]["sourceTypeId"], served[0]["sourceTypeId"])

    def test_is_extended_is_computed_against_every_attached_schema(self):
        _, objects, _ = self.space()
        rows = _metric_rows()
        declared = rows["devices"][1]["last_birth_metrics"]
        mill_alone = i3x_service._modelled_metrics(rows["schemas"][0]["schema_definition"])
        self.assertTrue(A.is_extended(declared, mill_alone), "the premise: Mill alone misses one")
        self.assertFalse(objects["dev-two"]["isExtended"])
        self.assertNotIn("schemaExtensions", objects["dev-two"]["metadata"])

    def test_an_extended_device_names_what_it_publishes_beyond_its_schemas(self):
        _, objects, _ = self.space()
        device = objects["dev-ext"]
        self.assertTrue(device["isExtended"])
        # From the DBIRTH datatype; `{}` where none was seen and the catalog has no row.
        self.assertEqual(device["metadata"]["schemaExtensions"],
                         {"Environmental/HUMIDITY": {"type": "number"}, "Vendor/COUNT": {}})
        self.assertEqual(device["metadata"]["system"], {"quarantined": True})
        self.assertNotIn("quarantined", device["metadata"], "a vendor key belongs in system")

    def test_schema_extensions_are_sent_exactly_when_the_device_is_extended(self):
        _, objects, _ = self.space()
        for sid in ("dev-one", "dev-two", "dev-three", "dev-ext", "dev-bare"):
            with self.subTest(device=sid):
                device = objects[sid]
                extensions = device["metadata"].get("schemaExtensions")
                self.assertEqual(device["isExtended"], bool(extensions), extensions)
        # dev-one's last birth declared Asset_ID, which is identity, not a metric beyond the model.
        self.assertFalse(objects["dev-one"]["isExtended"])

    def test_every_device_carries_its_vendor_keys_in_system(self):
        _, objects, _ = self.space()
        for sid in ("dev-one", "dev-two", "dev-bare"):
            with self.subTest(device=sid):
                self.assertEqual(objects[sid]["metadata"]["system"], {"quarantined": False})

    def test_a_device_with_no_schema_is_the_unmodelled_device(self):
        _, objects, _ = self.space()
        self.assertEqual(objects["dev-bare"]["typeElementId"], A.UNTYPED_DEVICE_TYPE_ID)
        self.assertFalse(objects["dev-bare"]["isExtended"])


# -------------------------------------------------------------------------------------------------
# Quality: one rule for reads, staging and history, from the device, its gateway and the value.
# -------------------------------------------------------------------------------------------------
def _iso_ago(seconds: float) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def _quality_rows(device=None, gateway=None) -> dict:
    """`_metric_rows()` with dev-one's and dev-two's rows, and their gateway gwy-1's, changed."""
    rows = _metric_rows()
    for row in rows["devices"]:
        if row["sparkplug_id"] in ("dev-one", "dev-two"):
            row.update(device or {})
    rows["gateways"][0].update(gateway or {})
    return rows


def _quality_table() -> list:
    """(condition, device row, gateway row, quality with a held value, without one)."""
    beat = _iso_ago(5)
    return [
        ("device quarantined", {"status": "ONLINE", "is_quarantined": True},
         {"status": "ONLINE", "last_heartbeat": beat}, "Uncertain", "Bad"),
        ("device OFFLINE", {"status": "OFFLINE"},
         {"status": "ONLINE", "last_heartbeat": beat}, "Uncertain", "Bad"),
        ("gateway OFFLINE", {"status": "ONLINE"},
         {"status": "OFFLINE", "last_heartbeat": beat}, "Uncertain", "Bad"),
        ("gateway STALE", {"status": "ONLINE"},
         {"status": "ONLINE", "last_heartbeat": _iso_ago(600)}, "Uncertain", "Bad"),
        ("source online", {"status": "ONLINE"},
         {"status": "ONLINE", "last_heartbeat": beat}, "Good", "GoodNoData"),
    ]


def _spb(msg_type, node="gwy-1", device=None, metrics=(), group="Aber"):
    """A JSON-encoded Sparkplug B message on its topic."""
    topic = f"spBv1.0/{group}/{msg_type}/{node}" + (f"/{device}" if device else "")
    body = {"timestamp": 1790000000000, "metrics": list(metrics)}
    return _Msg(topic, json.dumps(body).encode("utf-8"))


class _QualityCase(_MetricSpace):
    """
    `_MetricSpace` with a fresh registry, no liveness observations and nothing filled. dev-one holds
    a cached Axes/X/POSITION and has never published Controller/EXECUTION; dev-two holds nothing.
    Every `registry.stage` call is recorded in `self.staged`, whoever it would be delivered to.
    """

    def setUp(self):
        super().setUp()
        i3x_service._liveness_clear()
        i3x_service._filled.clear()
        self._real_registry = i3x_service.registry
        i3x_service.registry = SubscriptionRegistry()
        self.staged = []
        real_stage = i3x_service.registry.stage

        def record(updates):
            self.staged.append(dict(updates))
            return real_stage(updates)

        i3x_service.registry.stage = record

    def tearDown(self):
        i3x_service.registry = self._real_registry
        i3x_service._liveness_clear()
        i3x_service._filled.clear()
        super().tearDown()

    def read(self, rows, *element_ids, depth=1, pg=None):
        """Each element's result through POST /objects/value, keyed by elementId."""
        i3x_service._space_cache_clear()
        req = FakeRequest(body={"elementIds": list(element_ids), "maxDepth": depth},
                          pg=pg or ColumnCheckingPostgrest(rows))
        i3x_service.h_objects_value(req)
        return {item["elementId"]: item["result"] for item in req.result}

    def directory(self, rows):
        """An address-space read, as a subscriber's registration or sync makes one."""
        i3x_service._space_cache_clear()
        return i3x_service._read_address_space(ColumnCheckingPostgrest(rows))

    def watch(self, *element_ids):
        sub = i3x_service.registry.create("client-quality", principal="p-quality")
        i3x_service.registry.register(sub, [{"elementId": e} for e in element_ids])
        return sub

    def last_staged(self) -> dict:
        self.assertTrue(self.staged, "nothing was staged")
        return self.staged[-1]

    def assertNeverNull(self, vqt):
        self.assertIsNotNone(vqt["timestamp"])
        self.assertTrue(vqt["timestamp"].endswith("Z"), vqt["timestamp"])


class TestQualityOnTheReadPath(_QualityCase):
    """
    POST /objects/value derives quality from the device's row, its gateway's row and whether a
    value is held, by the i3X guide's table (Query Methods): a stale value being held is
    Uncertain, a source that is unreachable is Bad, and null never pairs with Good or Uncertain.
    """

    HELD = ("dev-one", "dev-one/Axes/X/POSITION")
    WITHOUT = ("dev-two", "dev-one/Controller/EXECUTION")

    def test_every_row_of_the_table(self):
        for condition, device, gateway, held, without in _quality_table():
            with self.subTest(condition=condition):
                got = self.read(_quality_rows(device, gateway), *self.HELD, *self.WITHOUT)
                for element_id in self.HELD:
                    self.assertIsNotNone(got[element_id]["value"])
                    self.assertEqual(got[element_id]["quality"], held, element_id)
                for element_id in self.WITHOUT:
                    self.assertEqual((got[element_id]["value"], got[element_id]["quality"]),
                                     (None, without), element_id)
                for vqt in got.values():
                    self.assertNeverNull(vqt)

    def test_a_devices_map_takes_the_worst_quality_among_the_metrics_it_holds(self):
        beat = {"status": "ONLINE", "last_heartbeat": _iso_ago(5)}
        got = self.read(_quality_rows({"status": "ONLINE"}, beat), "dev-one", depth=0)["dev-one"]
        # A modelled metric never published is GoodNoData alone; the map it is absent from is Good.
        self.assertEqual(got["quality"], "Good")
        self.assertEqual(got["components"]["dev-one/Controller/EXECUTION"]["quality"], "GoodNoData")
        self.assertEqual(got["components"]["dev-one/Axes/X/POSITION"]["quality"], "Good")

    def test_the_maps_timestamp_is_its_newest_sample_as_an_instant_not_as_text(self):
        # As text "10:00:00Z" sorts after "10:00:00.500Z".
        i3x_service.record_value("dev-two", "Axes/X/POSITION", 1.0, "2026-09-28T10:00:00Z")
        i3x_service.record_value("dev-two", "OEE/AVAILABILITY", 2.0, "2026-09-28T10:00:00.500Z")
        got = self.read(_quality_rows({"status": "ONLINE"}), "dev-two")["dev-two"]
        self.assertEqual(got["timestamp"], "2026-09-28T10:00:00.500Z")

    def test_with_no_sample_the_timestamp_is_the_devices_last_status_change(self):
        died = time.time() - 1
        i3x_service._hear_device("dev-two", "gwy-1", "OFFLINE", died)
        got = self.read(_quality_rows({"status": "ONLINE"}), "dev-two")["dev-two"]
        self.assertEqual((got["value"], got["quality"]), (None, "Bad"))
        stamped = A.instant(got["timestamp"]).timestamp()
        self.assertAlmostEqual(stamped, died, delta=0.01)

    def test_a_gateways_own_value_is_good_whenever_its_status_is_known(self):
        for gateway, status in (
            ({"status": "ONLINE", "last_heartbeat": _iso_ago(5)}, "ONLINE"),
            ({"status": "OFFLINE", "last_heartbeat": _iso_ago(5)}, "OFFLINE"),
            ({"status": "ONLINE", "last_heartbeat": _iso_ago(600)}, "STALE"),
            ({"status": "AWAITING_BIRTH", "last_heartbeat": _iso_ago(600)}, "AWAITING_BIRTH"),
            ({"status": "Maintenance", "last_heartbeat": _iso_ago(5)}, "MAINTENANCE"),
            ({"status": "ONLINE", "last_heartbeat": None}, "ONLINE"),
        ):
            with self.subTest(gateway=gateway):
                got = self.read(_quality_rows(None, gateway), "gwy-1")["gwy-1"]
                self.assertEqual((got["value"]["status"], got["quality"]), (status, "Good"))
                self.assertNeverNull(got)
        unknown = self.read(_quality_rows(None, {"status": None}), "gwy-1")["gwy-1"]
        self.assertEqual((unknown["value"], unknown["quality"]), (None, "GoodNoData"))
        self.assertNeverNull(unknown)

    def test_only_an_offline_or_stale_gateway_holds_its_devices(self):
        for status in ("AWAITING_BIRTH", "PENDING_ENROLLMENT", "Maintenance", None):
            with self.subTest(status=status):
                gateway = {"status": status, "last_heartbeat": _iso_ago(5)}
                got = self.read(_quality_rows({"status": "ONLINE"}, gateway), "dev-one")
                self.assertEqual(got["dev-one"]["quality"], "Good")

    def test_an_ndeath_the_rows_do_not_show_yet_holds_the_devices_at_once(self):
        rows = _quality_rows({"status": "ONLINE"}, {"status": "ONLINE", "last_heartbeat": _iso_ago(20)})
        i3x_service.on_message(None, None, _spb("NDEATH"))
        got = self.read(rows, "gwy-1", "dev-one")
        self.assertEqual((got["gwy-1"]["value"]["status"], got["gwy-1"]["quality"]), ("OFFLINE", "Good"))
        self.assertEqual(got["dev-one"]["quality"], "Uncertain")
        # A heartbeat stored after the death, as ingestion writes a rebirth, outranks it.
        rows["gateways"][0]["last_heartbeat"] = _iso_ago(-1)
        self.assertEqual(self.read(rows, "dev-one")["dev-one"]["quality"], "Good")

    def test_a_device_row_read_well_after_a_birth_or_death_outranks_it(self):
        now = time.time()
        i3x_service._hear_device("dev-one", "gwy-1", "OFFLINE", now - 60)
        row = {"sparkplug_id": "dev-one", "status": "ONLINE"}
        # Read inside the lag: ingestion may not have written the death yet.
        self.assertEqual(i3x_service._effective_device(row, now - 58)["status"], "OFFLINE")
        # Read past it: the row has since been written, by a birth this process did not see.
        self.assertEqual(i3x_service._effective_device(row, now)["status"], "ONLINE")
        self.assertEqual(row, {"sparkplug_id": "dev-one", "status": "ONLINE"}, "the row was mutated")


class TestQualityOnTheStagingPath(_QualityCase):
    """
    What the MQTT thread stages carries the quality the read path derives: from the rows the last
    address-space read returned, overlaid with the broker's births and deaths since.
    """

    def test_every_row_of_the_table_as_staging_derives_it(self):
        for condition, device, gateway, held, without in _quality_table():
            with self.subTest(condition=condition):
                i3x_service._liveness_clear()
                rows = _quality_rows(device, gateway)
                self.directory(rows)
                now = time.time()
                staged = i3x_service._device_updates(
                    "dev-one", i3x_service.metrics_for("dev-one"), ["Axes/X/POSITION"], now
                )
                self.assertEqual(staged["dev-one"]["quality"], held)
                self.assertEqual(staged["dev-one/Axes/X/POSITION"]["quality"], held)
                empty = i3x_service._device_updates("dev-two", {}, (), now)["dev-two"]
                self.assertEqual((empty["value"], empty["quality"]), (None, without))
                self.assertNeverNull(empty)
                read = self.read(rows, "dev-one", "dev-one/Axes/X/POSITION", "dev-two")
                for element_id, vqt in {**staged, "dev-two": empty}.items():
                    self.assertEqual(vqt["quality"], read[element_id]["quality"], element_id)

    def test_a_ddata_stages_the_map_and_each_metric_it_changed(self):
        self.directory(_quality_rows({"status": "ONLINE"},
                                     {"status": "ONLINE", "last_heartbeat": _iso_ago(5)}))
        i3x_service.record_value("dev-one", "Controller/EXECUTION", "ACTIVE", None)
        self.watch("dev-one")
        i3x_service.on_message(None, None, _spb(
            "DDATA", device="dev-one", metrics=[{"name": "Axes/X/POSITION", "value": 13.0}]))
        staged = self.last_staged()
        self.assertEqual(set(staged), {"dev-one", "dev-one/Axes/X/POSITION"})
        self.assertEqual(staged["dev-one"]["value"],
                         {"Axes/X/POSITION": 13.0, "Controller/EXECUTION": "ACTIVE"})
        self.assertEqual((staged["dev-one/Axes/X/POSITION"]["value"],
                          staged["dev-one/Axes/X/POSITION"]["quality"]), (13.0, "Good"))
        self.assertEqual(staged["dev-one"]["quality"], "Good")

    def test_a_quarantined_device_is_staged_as_it_is_read(self):
        rows = _quality_rows({"status": "ONLINE", "is_quarantined": True})
        self.directory(rows)
        self.watch("dev-one")
        i3x_service.on_message(None, None, _spb(
            "DDATA", device="dev-one", metrics=[{"name": "Axes/X/POSITION", "value": 13.0}]))
        self.assertEqual(self.last_staged()["dev-one"]["quality"], "Uncertain")
        self.assertEqual(self.read(rows, "dev-one")["dev-one"]["quality"], "Uncertain")

    def test_a_ddeath_stages_the_device_and_its_metrics_held_or_bad(self):
        self.directory(_quality_rows({"status": "ONLINE"},
                                     {"status": "ONLINE", "last_heartbeat": _iso_ago(5)}))
        self.watch("dev-one", "dev-two")
        i3x_service.on_message(None, None, _spb("DDEATH", device="dev-one"))
        staged = self.last_staged()
        self.assertEqual(set(staged), {"dev-one", "dev-one/Axes/X/POSITION"})
        self.assertEqual({e: v["quality"] for e, v in staged.items()},
                         {"dev-one": "Uncertain", "dev-one/Axes/X/POSITION": "Uncertain"})
        self.assertEqual(staged["dev-one"]["value"], {"Axes/X/POSITION": 12.5})

        before = time.time()
        i3x_service.on_message(None, None, _spb("DDEATH", device="dev-two"))
        empty = self.last_staged()["dev-two"]
        self.assertEqual((empty["value"], empty["quality"]), (None, "Bad"))
        # No sample, so the time of the death.
        self.assertGreaterEqual(A.instant(empty["timestamp"]).timestamp(), before - 1)

    def test_a_dbirth_brings_a_dead_device_back(self):
        self.directory(_quality_rows({"status": "ONLINE"},
                                     {"status": "ONLINE", "last_heartbeat": _iso_ago(5)}))
        self.watch("dev-one")
        i3x_service.on_message(None, None, _spb("DDEATH", device="dev-one"))
        i3x_service.on_message(None, None, _spb(
            "DBIRTH", device="dev-one", metrics=[{"name": "Axes/X/POSITION", "value": 14.0}]))
        self.assertEqual(self.last_staged()["dev-one"]["quality"], "Good")
        # A birth with nothing but its identity still changes the device's status.
        i3x_service.on_message(None, None, _spb("DDEATH", device="dev-one"))
        i3x_service.on_message(None, None, _spb(
            "DBIRTH", device="dev-one", metrics=[{"name": "Asset_ID", "string_value": "x"}]))
        self.assertEqual(set(self.last_staged()), {"dev-one"})
        self.assertEqual(self.last_staged()["dev-one"]["quality"], "Good")

    def test_an_ndeath_stages_the_gateway_and_the_devices_it_holds(self):
        rows = _quality_rows({"status": "ONLINE"}, {"status": "ONLINE", "last_heartbeat": _iso_ago(5)})
        self.directory(rows)
        # dev-ext is quarantined, so already held: its quality does not change and it is not staged.
        self.watch("gwy-1", "dev-one", "dev-two", "dev-ext")
        i3x_service.on_message(None, None, _spb("NDEATH"))
        staged = self.last_staged()
        self.assertEqual(set(staged), {"gwy-1", "dev-one", "dev-one/Axes/X/POSITION", "dev-two"})
        self.assertEqual((staged["gwy-1"]["value"]["status"], staged["gwy-1"]["quality"]),
                         ("OFFLINE", "Good"))
        self.assertEqual(staged["gwy-1"]["value"]["sparkplugGroup"], "Aber")
        self.assertEqual(staged["dev-one"]["quality"], "Uncertain")
        self.assertEqual((staged["dev-two"]["value"], staged["dev-two"]["quality"]), (None, "Bad"))
        read = self.read(rows, "gwy-1", "dev-one", "dev-two")
        for element_id in ("gwy-1", "dev-one", "dev-two"):
            self.assertEqual(read[element_id]["quality"], staged[element_id]["quality"])

    def test_an_nbirth_stages_the_gateway_back_and_the_devices_it_releases(self):
        self.directory(_quality_rows({"status": "ONLINE"},
                                     {"status": "ONLINE", "last_heartbeat": _iso_ago(5)}))
        self.watch("gwy-1", "dev-one", "dev-two")
        i3x_service.on_message(None, None, _spb("NDEATH"))
        i3x_service.on_message(None, None, _spb("NBIRTH"))
        staged = self.last_staged()
        self.assertEqual((staged["gwy-1"]["value"]["status"], staged["gwy-1"]["quality"]),
                         ("ONLINE", "Good"))
        self.assertEqual(staged["dev-one"]["quality"], "Good")
        self.assertEqual((staged["dev-two"]["value"], staged["dev-two"]["quality"]),
                         (None, "GoodNoData"))

    def test_an_ndata_stages_only_a_change_of_live_status(self):
        self.directory(_quality_rows({"status": "ONLINE"},
                                     {"status": "ONLINE", "last_heartbeat": _iso_ago(5)}))
        self.watch("gwy-1", "dev-one")
        i3x_service.on_message(None, None, _spb("NDATA"))
        self.assertEqual(self.staged, [], "a heartbeat that changes nothing was staged")

        i3x_service._liveness_clear()
        self.directory(_quality_rows({"status": "ONLINE"},
                                     {"status": "ONLINE", "last_heartbeat": _iso_ago(600)}))
        i3x_service.on_message(None, None, _spb("NDATA"))
        staged = self.last_staged()
        self.assertEqual(staged["gwy-1"]["value"]["status"], "ONLINE")
        self.assertEqual(staged["dev-one"]["quality"], "Good", "the STALE gateway held it")

    def test_a_reported_status_is_staged_as_ingestion_writes_it(self):
        self.directory(_quality_rows())
        self.watch("gwy-1")
        for reported, status in (("MAINTENANCE", "MAINTENANCE"), (" stale ", "ONLINE"),
                                 ("x" * 33, "ONLINE"), ("", "ONLINE")):
            with self.subTest(reported=reported):
                i3x_service.on_message(None, None, _spb(
                    "NBIRTH", metrics=[{"name": "Gateway_Status", "string_value": reported}]))
                self.assertEqual(self.last_staged()["gwy-1"]["value"]["status"], status)

    def test_nothing_is_built_while_nobody_watches(self):
        self.directory(_quality_rows({"status": "ONLINE"},
                                     {"status": "ONLINE", "last_heartbeat": _iso_ago(5)}))
        messages = [
            _spb("NBIRTH"), _spb("NDATA"),
            _spb("DBIRTH", device="dev-one", metrics=[{"name": "Axes/X/POSITION", "value": 1.0}]),
            _spb("DDATA", device="dev-one", metrics=[{"name": "Axes/X/POSITION", "value": 2.0}]),
            _spb("DDEATH", device="dev-one"), _spb("NDEATH"),
        ]
        with mock.patch.object(i3x_service, "_device_updates", wraps=i3x_service._device_updates) as device, \
                mock.patch.object(A, "gateway_value", wraps=A.gateway_value) as gateway:
            for message in messages:
                i3x_service.on_message(None, None, message)
            self.assertEqual((device.call_count, gateway.call_count), (0, 0))
            self.assertEqual(self.staged, [])

            # One metric watched makes its device's messages, and its gateway's, worth building.
            self.watch("dev-one/Axes/X/POSITION")
            for message in messages:
                i3x_service.on_message(None, None, message)
            self.assertGreater(device.call_count, 0)
            self.assertEqual(gateway.call_count, 0, "nobody watches the gateway itself")
            self.assertTrue(any("dev-one/Axes/X/POSITION" in batch for batch in self.staged))


class TestCurrentValuesAreFilledFromTheHistorian(_QualityCase):
    """
    A value read fills what the MQTT cache lacks for a device from `telemetry_latest`, read as the
    caller, once per device, and seeds the cache with it, so a slow metric is not GoodNoData after
    a restart while the historian holds it.
    """

    DEV_TWO = (
        ("2026-09-28T08:30:00+00:00", "Axes/X/POSITION", 6.0),
        ("2026-09-28T09:00:00+00:00", "Axes/X/POSITION", 7.0),
        ("2026-09-28T08:00:00+00:00", "OEE/AVAILABILITY", 88.0),
        # Stored, but no longer one of its components: never filled into the map.
        ("2026-09-28T07:00:00+00:00", "Retired/METRIC", 1.0),
    )

    def pg(self, device=None, gateway=None, telemetry=None, fail=None, rows=None):
        rows = rows or _quality_rows(
            device or {"status": "ONLINE"},
            gateway or {"status": "ONLINE", "last_heartbeat": _iso_ago(5)},
        )
        return LatestPostgrest(rows, _telemetry(*(telemetry or self.DEV_TWO), sid="dev-two"), fail)

    def latest_reads(self, pg) -> list:
        return [params for relation, params in pg.calls if relation == "telemetry_latest"]

    def test_a_restart_reads_what_the_cache_lacks_from_telemetry_latest(self):
        got = self.read(None, "dev-two", depth=0, pg=self.pg())["dev-two"]
        self.assertEqual(got["value"], {"Axes/X/POSITION": 7.0, "OEE/AVAILABILITY": 88.0})
        self.assertEqual((got["quality"], got["timestamp"]), ("Good", "2026-09-28T09:00:00Z"))
        components = got["components"]
        self.assertEqual((components["dev-two/OEE/AVAILABILITY"]["value"],
                          components["dev-two/OEE/AVAILABILITY"]["timestamp"]),
                         (88.0, "2026-09-28T08:00:00Z"))
        self.assertEqual(components["dev-two/Controller/EXECUTION"]["quality"], "GoodNoData")

    def test_a_value_filled_for_an_offline_device_is_uncertain(self):
        got = self.read(None, "dev-two", "dev-two/Axes/X/POSITION",
                        pg=self.pg({"status": "OFFLINE"}))
        self.assertEqual((got["dev-two"]["quality"], got["dev-two/Axes/X/POSITION"]["quality"]),
                         ("Uncertain", "Uncertain"))

    def test_it_seeds_the_cache_so_a_ddata_merges_into_a_complete_map(self):
        self.read(None, "dev-two", pg=self.pg())
        self.assertEqual(set(i3x_service.metrics_for("dev-two")),
                         {"Axes/X/POSITION", "OEE/AVAILABILITY"})
        self.watch("dev-two")
        i3x_service.on_message(None, None, _spb(
            "DDATA", device="dev-two", metrics=[{"name": "OEE/AVAILABILITY", "value": 90.0}]))
        self.assertEqual(self.last_staged()["dev-two"]["value"],
                         {"Axes/X/POSITION": 7.0, "OEE/AVAILABILITY": 90.0})

    def test_it_is_one_read_as_the_caller_for_every_device_named_then_none(self):
        pg = self.pg()
        self.read(None, "dev-one", "dev-two/OEE/AVAILABILITY", "gwy-1", pg=pg)
        reads = self.latest_reads(pg)
        self.assertEqual(len(reads), 1, reads)
        self.assertEqual(reads[0]["asset_id"], "in.(dev-one,dev-two)")
        self.assertEqual(reads[0]["limit"], str(i3x_service.FILL_MAX_ROWS))
        again = self.pg()
        self.read(None, "dev-one", "dev-two", pg=again)
        self.assertEqual(self.latest_reads(again), [], "a filled device was read again")

    def test_a_cached_value_is_never_replaced_and_only_components_are_filled(self):
        telemetry = self.DEV_TWO + (("2026-09-28T11:00:00+00:00", "Axes/X/POSITION", 1.0),)
        pg = LatestPostgrest(_quality_rows({"status": "ONLINE"}),
                             _telemetry(*telemetry, sid="dev-one"))
        got = self.read(None, "dev-one", pg=pg)["dev-one"]
        # dev-one's Controller/EXECUTION has no stored sample, and Retired/METRIC is no component.
        self.assertEqual(got["value"], {"Axes/X/POSITION": 12.5})

    def test_an_integer_metric_is_served_as_an_integer(self):
        rows = _quality_rows({"status": "ONLINE"})
        rows["metric_catalog"][2]["datatype"] = 3  # OEE/AVAILABILITY as Int32
        got = self.read(None, "dev-two/OEE/AVAILABILITY", pg=self.pg(rows=rows))
        value = got["dev-two/OEE/AVAILABILITY"]["value"]
        self.assertEqual((value, type(value)), (88, int))

    def test_a_failed_read_makes_what_is_missing_bad_and_is_tried_again(self):
        failing = self.pg(fail=SubscriptionError(502, "Bad Gateway", "historian down"))
        got = self.read(None, "dev-one", "dev-one/Controller/EXECUTION", "dev-one/Axes/X/POSITION",
                        "dev-two", pg=failing)
        self.assertEqual((got["dev-two"]["value"], got["dev-two"]["quality"]), (None, "Bad"))
        self.assertEqual((got["dev-one"]["value"], got["dev-one"]["quality"]),
                         ({"Axes/X/POSITION": 12.5}, "Uncertain"))
        self.assertEqual(got["dev-one/Controller/EXECUTION"]["quality"], "Bad")
        self.assertEqual(got["dev-one/Axes/X/POSITION"]["quality"], "Good")
        got = self.read(None, "dev-two", pg=self.pg())
        self.assertEqual(got["dev-two"]["quality"], "Good")

    def test_nothing_is_read_when_nothing_is_missing(self):
        i3x_service.record_value("dev-one", "Controller/EXECUTION", "ACTIVE", None)
        pg = self.pg()
        self.read(None, "dev-one", pg=pg)
        self.assertEqual(self.latest_reads(pg), [])

    def test_a_read_that_comes_back_full_is_read_again(self):
        with mock.patch.object(i3x_service, "FILL_MAX_ROWS", 1):
            first, second = self.pg(), self.pg()
            self.read(None, "dev-two", pg=first)
            self.read(None, "dev-two", pg=second)
        self.assertEqual((len(self.latest_reads(first)), len(self.latest_reads(second))), (1, 1))


class TestARegistrationFillsFromTheHistorian(_QualityCase):
    """
    A registration fills what the cache lacks for each device it names, a metric naming its
    device, as a value read does, so the first map staged for a device no read has named since a
    restart is complete. A fill that fails leaves the registration standing.
    """

    DEV_TWO = TestCurrentValuesAreFilledFromTheHistorian.DEV_TWO
    pg = TestCurrentValuesAreFilledFromTheHistorian.pg
    latest_reads = TestCurrentValuesAreFilledFromTheHistorian.latest_reads

    def register(self, pg, *element_ids):
        i3x_service._space_cache_clear()
        sub = i3x_service.registry.create("client-fill", principal="p-fill")
        req = FakeRequest(body={"clientId": "client-fill", "subscriptionId": sub.subscription_id,
                                "elementIds": list(element_ids)}, pg=pg)
        req.caller = i3x_service.Caller("p-fill", None)
        i3x_service.h_sub_register(req)
        return [(r["elementId"], r["success"]) for r in req.result]

    def test_registering_a_metric_fills_its_device_before_anything_is_staged(self):
        pg = self.pg()
        self.assertEqual(self.register(pg, "dev-two/OEE/AVAILABILITY"),
                         [("dev-two/OEE/AVAILABILITY", True)])
        self.assertEqual([r["asset_id"] for r in self.latest_reads(pg)], ["in.(dev-two)"])
        i3x_service.on_message(None, None, _spb(
            "DDATA", device="dev-two", metrics=[{"name": "OEE/AVAILABILITY", "value": 90.0}]))
        # The map staged for the device holds the filled position, not only what was published.
        self.assertEqual(self.last_staged()["dev-two"]["value"],
                         {"Axes/X/POSITION": 7.0, "OEE/AVAILABILITY": 90.0})

    def test_only_registered_devices_are_read_once_between_them(self):
        pg = self.pg()
        self.register(pg, "dev-one", "gwy-1", CELL_A, "dev-unknown", "dev-two/Axes/X/POSITION",
                      "dev-two")
        self.assertEqual([r["asset_id"] for r in self.latest_reads(pg)], ["in.(dev-one,dev-two)"])
        nothing = self.pg()
        self.register(nothing, "gwy-1", CELL_A)
        self.assertEqual(self.latest_reads(nothing), [])

    def test_a_failed_fill_leaves_the_registration_standing(self):
        failing = self.pg(fail=SubscriptionError(502, "Bad Gateway", "historian down"))
        with self.assertLogs(i3x_service.logger, "WARNING") as logged:
            self.assertEqual(self.register(failing, "dev-two"), [("dev-two", True)])
        self.assertIn("historian down", "\n".join(logged.output))
        with mock.patch.object(i3x_service, "_fill_from_historian", side_effect=RuntimeError("x")), \
                self.assertLogs(i3x_service.logger, "ERROR") as logged:
            self.assertEqual(self.register(self.pg(), "dev-two"), [("dev-two", True)])
        self.assertIn("filling 1 registered device(s)", "\n".join(logged.output))


class LatestPostgrest(ColumnCheckingPostgrest):
    """
    ColumnCheckingPostgrest answering `telemetry_latest` from seeded `telemetry` rows as the view
    does: the newest row per series, filtered by `asset_id=eq.` or `in.(...)`, limited, projected.
    `fail` is raised by that read instead.
    """

    def __init__(self, rows=None, telemetry=(), fail=None):
        super().__init__({**(rows or {}), "telemetry": list(telemetry)})
        self.fail = fail

    def get(self, relation, params=None):
        answer = super().get(relation, params)
        if relation != "telemetry_latest":
            return answer
        if self.fail is not None:
            raise self.fail
        op, _, arg = params.get("asset_id", "").partition(".")
        assets = arg.strip("()").split(",") if op == "in" else [arg]
        newest = {}
        for row in self.rows["telemetry"]:
            key = (row["asset_id"], row["metric_name"])
            if row["asset_id"] in assets and (
                key not in newest
                or TelemetryPostgrest._instant(row["time"]) > TelemetryPostgrest._instant(newest[key]["time"])
            ):
                newest[key] = row
        rows = list(newest.values())[: int(params.get("limit", len(newest)))]
        return [{c: row.get(c) for c in params["select"].split(",")} for row in rows]


class TestLivenessMirrorsTheDirectory(unittest.TestCase):
    """
    The rules this server copies rather than reads: the gateway_status view's STALE, ingestion's
    acceptance of a self-reported status, and the premise that history needs no quality rule.
    """

    def _view(self) -> str:
        """The last definition of public.gateway_status the migrations make, pg_dump's form."""
        text = ""
        for path in sorted(MIGRATIONS_DIR.glob("[0-9]*.sql")):
            sql = path.read_text(encoding="utf-8")
            for m in re.finditer(r"^CREATE OR REPLACE VIEW public\.gateway_status\b.*?;$", sql,
                                 re.M | re.S):
                text = m.group(0)
        self.assertTrue(text, "no gateway_status view in the migrations")
        return text

    def test_gateway_live_status_is_the_views_rule(self):
        view = self._view()
        steps = [
            "WHEN (status = ANY (ARRAY['PENDING_ENROLLMENT'::text, 'AWAITING_BIRTH'::text])) THEN status",
            "WHEN (status = 'OFFLINE'::text) THEN 'OFFLINE'::text",
            "WHEN (last_heartbeat IS NULL) THEN status",
            "WHEN ((now() - last_heartbeat) > '00:01:30'::interval) THEN 'STALE'::text",
            "ELSE status",
        ]
        at = [view.find(step) for step in steps]
        self.assertNotIn(-1, at, "the view's CASE changed; update gateway_live_status to match")
        self.assertEqual(at, sorted(at), "the view's CASE was reordered")
        self.assertEqual(A.GATEWAY_STALE_SECONDS, 90)
        self.assertEqual(set(A.GATEWAY_ENROLMENT_STATUSES), {"PENDING_ENROLLMENT", "AWAITING_BIRTH"})

        now = time.time()

        def beat(age):
            from datetime import datetime, timezone

            return datetime.fromtimestamp(now - age, tz=timezone.utc).isoformat()

        for status, heartbeat, expected in (
            ("ONLINE", beat(89), "ONLINE"), ("ONLINE", beat(91), "STALE"),
            ("OFFLINE", beat(1000), "OFFLINE"), ("AWAITING_BIRTH", beat(1000), "AWAITING_BIRTH"),
            ("PENDING_ENROLLMENT", None, "PENDING_ENROLLMENT"), ("ONLINE", None, "ONLINE"),
            ("Maintenance", beat(1), "MAINTENANCE"), ("Maintenance", beat(1000), "STALE"),
            (None, beat(1), "UNKNOWN"),
        ):
            with self.subTest(status=status, heartbeat=heartbeat):
                gateway = {"status": status, "last_heartbeat": heartbeat}
                self.assertEqual(A.gateway_live_status(gateway, now), expected)

    def _ingestion_literal(self, name):
        import ast

        for node in ast.parse((INGESTION_DIR / "ingestion.py").read_text(encoding="utf-8")).body:
            if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
                value = node.value
                if isinstance(value, ast.Call):  # frozenset({...})
                    value = value.args[0]
                return ast.literal_eval(value)
        self.fail(f"{name} is not in ingestion.py")

    def test_a_reported_status_is_accepted_as_ingestion_accepts_it(self):
        import logging

        reserved = self._ingestion_literal("RESERVED_GATEWAY_STATUSES")
        longest = self._ingestion_literal("MAX_GATEWAY_STATUS_LENGTH")
        self.assertEqual(set(reserved), set(i3x_service.RESERVED_GATEWAY_STATUSES))
        self.assertEqual(longest, i3x_service.MAX_GATEWAY_STATUS_LENGTH)
        theirs = TestMirroredConstants._function(
            INGESTION_DIR / "ingestion.py", "accept_reported_status",
            MAX_GATEWAY_STATUS_LENGTH=longest, RESERVED_GATEWAY_STATUSES=frozenset(reserved),
            _throttled=lambda *_: False, _status_rejected_warned={},
            STATUS_REJECT_WARN_INTERVAL_SECONDS=0, logger=logging.getLogger("mirror"),
            count=lambda *_: None,
        )
        for reported in ("MAINTENANCE", " Maintenance ", "", "   ", "stale", "Awaiting_Birth",
                         "OFFLINE", "x" * 32, "x" * 33, "ONLINE"):
            with self.subTest(reported=reported):
                metric = {"name": "Gateway_Status", "field": "string_value", "value": reported}
                self.assertEqual(
                    i3x_service.reported_gateway_status("Aber", "gwy-1", [metric]),
                    theirs(reported, "gwy-1"),
                )

    def test_history_is_good_because_ingestion_stores_nothing_from_a_quarantined_device(self):
        source = (INGESTION_DIR / "ingestion.py").read_text(encoding="utf-8")
        # The premise: process_ddata drops a quarantined device's readings, and DBIRTH values go to
        # asset_config, so no stored sample came from a source in quarantine.
        premise = r'device\.get\("is_quarantined"\):\s+drop\(\s+"quarantined_or_unregistered"'
        self.assertIsNotNone(re.search(premise, source), "ingestion no longer drops that DDATA")
        self.assertEqual(i3x_service._vqt(1.0, "2026-09-28T10:00:00+00:00")["quality"], "Good")
        self.assertEqual(i3x_service._vqt(None, "2026-09-28T10:00:00+00:00")["quality"], "GoodNoData")
        self.assertEqual(A.stored_sample_quality(True),
                         A.value_quality(A.STORED_SAMPLE_SOURCE, None, True))


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


# -------------------------------------------------------------------------------------------------
# History: a metric's samples, a device's map snapshots, and a 206 whenever a limit cuts either.
# -------------------------------------------------------------------------------------------------
class TelemetryPostgrest(ColumnCheckingPostgrest):
    """
    ColumnCheckingPostgrest that also answers `telemetry` and `telemetry_latest` as PostgREST
    would: filtered by asset, metric and time, ordered, limited, then projected onto `select`.
    `telemetry_latest` is the newest telemetry row of each (asset, metric), as the view is.
    """

    def __init__(self, telemetry=(), rows=None):
        super().__init__({**(rows or {}), "telemetry": list(telemetry)})

    @staticmethod
    def _instant(text):
        from datetime import datetime

        return datetime.fromisoformat(text.replace("Z", "+00:00"))

    def get(self, relation, params=None):
        import operator

        answer = super().get(relation, params)  # the column checks, and `calls`
        if relation not in ("telemetry", "telemetry_latest"):
            return answer
        params = dict(params or {})
        rows = list(self.rows["telemetry"])
        if relation == "telemetry_latest":
            newest = {}
            for row in rows:
                key = (row["asset_id"], row["metric_name"])
                if key not in newest or self._instant(row["time"]) > self._instant(newest[key]["time"]):
                    newest[key] = row
            rows = list(newest.values())
        filters = [
            (column, *params[column].split(".", 1))
            for column in ("asset_id", "metric_name", "time") if column in params
        ]
        for op, value in re.findall(r"time\.(\w+)\.([^,)]+)", params.get("and", "")):
            filters.append(("time", op, value))
        compare = {"eq": operator.eq, "lt": operator.lt, "lte": operator.le, "gte": operator.ge}

        def keep(row):
            for column, op, value in filters:
                left, right = row[column], value
                if column == "time":
                    left, right = self._instant(left), self._instant(right)
                if not compare[op](left, right):
                    return False
            return True

        rows = [r for r in rows if keep(r)]
        for part in reversed([p for p in params.get("order", "").split(",") if p]):
            column, _, direction = part.partition(".")
            rows.sort(
                key=lambda r: self._instant(r["time"]) if column == "time" else r[column],
                reverse=direction == "desc",
            )
        if "limit" in params:
            rows = rows[: int(params["limit"])]
        return [{c: row.get(c) for c in params["select"].split(",")} for row in rows]


SID = "dev0000000000000000000a1"
WINDOW = {"startTime": "2026-09-28T10:00:00Z", "endTime": "2026-09-28T11:00:00Z"}


def _at(hhmm: str, day: str = "2026-09-28") -> str:
    """A time as PostgREST writes a timestamptz."""
    return f"{day}T{hhmm}:00+00:00"


def _telemetry(*samples, sid=SID) -> list:
    """Rows for `sid` from (time, metric, value), each value in the column its type selects."""
    rows = []
    for time_, metric, value in samples:
        row = {"time": time_, "asset_id": sid, "metric_name": metric,
               "val_double": None, "val_string": None, "val_bool": None}
        if isinstance(value, bool):
            row["val_bool"] = value
        elif isinstance(value, str):
            row["val_string"] = value
        elif value is not None:
            row["val_double"] = value
        rows.append(row)
    return rows


def _device_space(*devices) -> tuple:
    """
    (space, objects) for devices given as (sparkplug_id, metric names), in the shape the address
    space gives a metric: an Object `<sparkplug_id>/<name>` whose parent is its device and whose
    only edge is ComponentOf it, while the device is a composition naming it under HasComponent.
    Locations are HasChildren only.
    """
    objects = {"cell-1": {"elementId": "cell-1", "parentId": A.SITE_ELEMENT_ID, "isComposition": False,
                          "metadata": {"relationships": {"HasChildren": [d for d, _ in devices]}}}}
    for sid, metrics in devices:
        ids = [f"{sid}/{name}" for name in metrics]
        objects[sid] = {"elementId": sid, "parentId": "cell-1", "isComposition": True,
                        "metadata": {"relationships": {"HasParent": ["cell-1"], "HasComponent": ids}}}
        for element_id in ids:
            objects[element_id] = {"elementId": element_id, "parentId": sid, "isComposition": False,
                                   "metadata": {"relationships": {"ComponentOf": [sid]}}}
    rows = [{"sparkplug_id": sid} for sid, _ in devices]
    space = {"cells": [], "gateways": [], "devices": rows, "locations": {}, "schemas": [],
             "_devices_by_sid": {r["sparkplug_id"]: r for r in rows}, "_gateways_by_sid": {}}
    return space, objects


class _HistoryCase(unittest.TestCase):
    """Runs one history request over a synthetic address space and a TelemetryPostgrest."""

    def setUp(self):
        i3x_service._space_cache_clear()

    def history(self, body, telemetry=(), devices=((SID, ("Temp",)),)):
        space, objects = _device_space(*devices)
        pg = TelemetryPostgrest(telemetry)
        req = FakeRequest(body={**WINDOW, **body}, pg=pg)
        with mock.patch.object(i3x_service, "_load_address_space", return_value=space), \
                mock.patch.object(i3x_service, "_build_objects", return_value=objects):
            i3x_service.h_objects_history(req)
        return req, pg

    def only(self, req) -> dict:
        self.assertEqual(len(req.result), 1)
        self.assertTrue(req.result[0]["success"], req.result[0])
        return req.result[0]["result"]

    def assertCut(self, req, element_id, *phrases):
        """A 206 on the response naming `element_id`, and one on its item saying each phrase."""
        self.assertEqual(req.status, 206)
        self.assertEqual(req.detail["status"], 206)
        self.assertEqual(req.detail["title"], "Partial results returned")
        self.assertIn(element_id, req.detail["detail"])
        item = next(i for i in req.result if i["elementId"] == element_id)
        self.assertTrue(item["success"], "a partial result is still a result")
        self.assertEqual(item["responseDetail"]["status"], 206)
        for phrase in phrases:
            self.assertIn(phrase, item["responseDetail"]["detail"])


class TestHistoryWindow(_HistoryCase):
    """startTime and endTime are parsed in full, and a window that ends before it starts is a 400."""

    def refused(self, body):
        with self.assertRaises(i3x_service.Problem) as caught:
            i3x_service.h_objects_history(FakeRequest(body={"elementIds": [SID], **body}))
        self.assertEqual(caught.exception.status, 400)
        return caught.exception.detail

    def test_rfc3339_is_read_in_full_and_as_utc(self):
        from datetime import datetime, timezone

        midnight = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for text, expected in (
            ("2026-01-01T00:00:00Z", midnight),
            ("2026-01-01t00:00:00z", midnight),
            ("2026-01-01T01:00:00+01:00", midnight),
            ("2025-12-31T19:00:00-05:00", midnight),
            ("2026-01-01T00:00:00-00:00", midnight),
            ("2026-01-01T00:00:00.5Z", midnight.replace(microsecond=500000)),
            ("2026-01-01T00:00:00.123456789Z", midnight.replace(microsecond=123456)),
        ):
            with self.subTest(text=text):
                self.assertEqual(i3x_service._rfc3339(text), expected)
        self.assertEqual(i3x_service._pg_time(midnight), "2026-01-01T00:00:00.000000Z")

    def test_anything_else_is_a_400_before_any_read(self):
        valid = WINDOW["startTime"]
        for bad in (
            "2026-01-01T00:00:00",  # no offset: a local time, which RFC 3339 does not allow
            "2026-01-01",
            "2026-01-01 00:00:00Z",
            "2026-01-01T00:00:00Zjunk",
            "2026-01-01T00:00:00Z),or(asset_id.neq.x",
            "2026-13-01T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T23:59:60Z",
            "2026-01-01T00:00:00+05:99",
            "2026-01-01T00:00:00+24:00",
            "2026-01-01T00:00:00+0100",
            "0001-01-01T00:00:00+01:00",
            "２０２６-01-01T00:00:00Z",
            "not-a-date",
            1767225600,
            True,
            [],
            {"t": 1},
        ):
            for name, body in (("startTime", {"startTime": bad, "endTime": valid}),
                               ("endTime", {"startTime": valid, "endTime": bad})):
                with self.subTest(field=name, value=bad):
                    self.assertIn(name, self.refused(body))

    def test_both_bounds_are_required(self):
        for body in ({}, {"startTime": WINDOW["startTime"]}, {"endTime": WINDOW["endTime"]},
                     {"startTime": "", "endTime": WINDOW["endTime"]}):
            with self.subTest(body=body):
                self.assertIn("required", self.refused(body))

    def test_a_start_after_the_end_is_a_400_and_an_instant_is_a_window(self):
        detail = self.refused({"startTime": "2026-09-28T11:00:00Z", "endTime": "2026-09-28T10:00:00Z"})
        self.assertIn("after endTime", detail)
        # The same instant written two ways is not reversed.
        self.assertEqual(
            i3x_service._history_window({"startTime": "2026-09-28T11:00:00+01:00",
                                         "endTime": "2026-09-28T10:00:00Z"})[0],
            i3x_service._rfc3339("2026-09-28T10:00:00Z"),
        )

    def test_the_filters_carry_the_parsed_instant_not_the_text(self):
        req, pg = self.history({"elementIds": [f"{SID}/Temp"], "startTime": "2026-09-28T11:00:00+01:00",
                                "endTime": "2026-09-28T11:00:00.5Z"})
        self.assertEqual(req.status, 200)
        _, params = pg.calls[-1]
        self.assertEqual(params["time"], "gte.2026-09-28T10:00:00.000000Z")
        self.assertEqual(params["and"], "(time.lte.2026-09-28T11:00:00.500000Z)")


class TestHistorySeries(_HistoryCase):
    """A metric's history is its samples; a device's is one map per instant; components follow."""

    DEVICE = ((SID, ("Temp", "State", "Running", "Serial")),)
    # Serial was set weeks ago; Temp and State last changed before the window; Temp changes again
    # after it. Running has no value until 10:20.
    ROWS = _telemetry(
        (_at("00:00", "2026-09-01"), "Serial", "SN-1"),
        (_at("09:50"), "Temp", 20.0),
        (_at("09:55"), "State", "IDLE"),
        (_at("10:10"), "Temp", 21.0),
        (_at("10:20"), "State", "ACTIVE"),
        (_at("10:20"), "Running", False),
        (_at("10:30"), "Temp", 22.0),
        (_at("11:30"), "Temp", 23.0),
    )

    def test_a_stored_row_becomes_a_scalar_vqt(self):
        for row, value, quality in (
            ({"val_double": 1.5}, 1.5, "Good"),
            ({"val_double": 0.0}, 0.0, "Good"),
            ({"val_string": ""}, "", "Good"),
            ({"val_bool": False}, False, "Good"),
            ({"val_double": 2.0, "val_string": "x"}, 2.0, "Good"),
            ({}, None, "GoodNoData"),
        ):
            with self.subTest(row=row):
                vqt = i3x_service._vqt(i3x_service._sample_value(row), "2026-09-28T10:10:00.12345+00:00")
                self.assertEqual(vqt, {"value": value, "quality": quality,
                                       "timestamp": "2026-09-28T10:10:00.123Z"})

    def test_a_metric_is_one_read_of_its_own_samples(self):
        req, pg = self.history({"elementIds": [f"{SID}/Temp"]}, self.ROWS, self.DEVICE)
        result = self.only(req)
        self.assertEqual(result, {"isComposition": False, "values": [
            {"value": 22.0, "quality": "Good", "timestamp": "2026-09-28T10:30:00Z"},
            {"value": 21.0, "quality": "Good", "timestamp": "2026-09-28T10:10:00Z"},
        ]})
        self.assertEqual(len(pg.calls), 1)
        relation, params = pg.calls[0]
        self.assertEqual((relation, params["asset_id"], params["metric_name"]),
                         ("telemetry", f"eq.{SID}", "eq.Temp"))

    def test_a_metric_id_splits_at_the_first_slash(self):
        rows = _telemetry((_at("10:10"), "Controller/EXECUTION", "ACTIVE"), (_at("10:10"), "Temp", 1.0))
        req, pg = self.history({"elementIds": [f"{SID}/Controller/EXECUTION"]}, rows,
                               ((SID, ("Controller/EXECUTION", "Temp")),))
        self.assertEqual([v["value"] for v in self.only(req)["values"]], ["ACTIVE"])
        self.assertEqual(pg.calls[0][1]["metric_name"], "eq.Controller/EXECUTION")

    def test_a_device_is_a_map_per_instant_carried_forward_from_before_the_window(self):
        req, pg = self.history({"elementIds": [SID]}, self.ROWS, self.DEVICE)
        result = self.only(req)
        self.assertEqual(req.status, 200)
        self.assertNotIn("components", result, "maxDepth 1 is the device's own value")
        self.assertEqual([(v["timestamp"], v["value"]) for v in result["values"]], [
            ("2026-09-28T10:30:00Z", {"Running": False, "Serial": "SN-1", "State": "ACTIVE", "Temp": 22.0}),
            ("2026-09-28T10:20:00Z", {"Running": False, "Serial": "SN-1", "State": "ACTIVE", "Temp": 21.0}),
            # Serial seeded from telemetry_latest, State from the rows before the window; Running
            # has no value yet, so it is absent rather than invented.
            ("2026-09-28T10:10:00Z", {"Serial": "SN-1", "State": "IDLE", "Temp": 21.0}),
        ])
        self.assertTrue(all(v["quality"] == "Good" for v in result["values"]))
        # The window, the newest row per metric, and the rows just before the window.
        self.assertEqual([relation for relation, _ in pg.calls], ["telemetry", "telemetry_latest", "telemetry"])
        self.assertEqual(pg.calls[2][1]["time"], "lt.2026-09-28T10:00:00.000000Z")
        # Unbounded below, so only a filter and an order postgres_fdw ships keep it cheap.
        self.assertEqual(pg.calls[2][1]["order"], "time.desc")

    def test_the_read_before_the_window_asks_for_few_rows_whatever_the_limit(self):
        # postgres_fdw ships its LIMIT only up to 6338 rows (README.md -> History); past that, this
        # read, unbounded below, would fetch the device's whole history.
        with mock.patch.object(i3x_service, "HISTORY_MAX_ROWS", 20000):
            _, pg = self.history({"elementIds": [SID]}, self.ROWS, self.DEVICE)
        self.assertEqual(pg.calls[0][1]["limit"], "20001")
        self.assertEqual(pg.calls[2][1]["limit"], str(i3x_service.HISTORY_SEED_MAX_ROWS))
        self.assertLessEqual(i3x_service.HISTORY_SEED_MAX_ROWS, 6338)
        self.assertLessEqual(i3x_service.HISTORY_MAX_ROWS + 1, 6338)

    def test_a_device_quiet_through_the_window_costs_one_read(self):
        rows = _telemetry((_at("09:50"), "Temp", 20.0), (_at("11:30"), "Temp", 23.0))
        req, pg = self.history({"elementIds": [SID]}, rows)
        self.assertEqual(self.only(req)["values"], [])
        self.assertEqual(len(pg.calls), 1)

    def test_components_are_its_metrics_sliced_from_the_devices_own_rows(self):
        for depth in (0, 2):
            with self.subTest(maxDepth=depth):
                req, pg = self.history({"elementIds": [SID], "maxDepth": depth}, self.ROWS, self.DEVICE)
                result = self.only(req)
                self.assertEqual(len(result["values"]), 3)
                self.assertEqual(
                    {k: [(v["timestamp"], v["value"]) for v in c["values"]]
                     for k, c in result["components"].items()},
                    {
                        f"{SID}/Temp": [("2026-09-28T10:30:00Z", 22.0), ("2026-09-28T10:10:00Z", 21.0)],
                        f"{SID}/State": [("2026-09-28T10:20:00Z", "ACTIVE")],
                        f"{SID}/Running": [("2026-09-28T10:20:00Z", False)],
                        f"{SID}/Serial": [],
                    },
                )
                self.assertEqual(len(pg.calls), 3, "components add no reads")

    def test_every_value_lies_inside_the_window(self):
        req, _ = self.history({"elementIds": [SID, f"{SID}/Temp"], "maxDepth": 0}, self.ROWS, self.DEVICE)
        stamps = [v["timestamp"] for item in req.result for v in item["result"]["values"]]
        stamps += [v["timestamp"] for c in req.result[0]["result"]["components"].values() for v in c["values"]]
        self.assertTrue(stamps)
        for stamp in stamps:
            self.assertTrue(WINDOW["startTime"] <= stamp <= WINDOW["endTime"], stamp)

    def test_only_devices_and_their_metrics_have_series(self):
        req, pg = self.history(
            {"elementIds": ["cell-1", "nope", "cell-1/Temp", "dev0000000000000000000ff/Temp"]},
            self.ROWS, self.DEVICE,
        )
        self.assertEqual(req.result[0]["result"], {"isComposition": False, "values": []})
        for item in req.result[1:]:
            with self.subTest(elementId=item["elementId"]):
                self.assertFalse(item["success"])
                self.assertEqual(item["responseDetail"]["status"], 404)
        self.assertEqual(pg.calls, [])

    def test_todays_address_space_answers_without_error(self):
        # Read through _build_objects rather than the synthetic shape, so this holds whichever
        # containers compose what.
        rows = _telemetry((_at("10:10"), "Temp", 21.0), (_at("10:20"), "State", "ACTIVE"), sid="dev-explicit")
        pg = TelemetryPostgrest(rows, _seeded_rows())
        wanted = [A.SITE_ELEMENT_ID, CELL_A, A.UNASSIGNED_ELEMENT_ID, "gwy-1", "dev-explicit"]
        req = FakeRequest(body={**WINDOW, "elementIds": wanted, "maxDepth": 0}, pg=pg)
        i3x_service.h_objects_history(req)
        self.assertEqual(req.status, 200)
        self.assertTrue(all(item["success"] for item in req.result), req.result)
        by_id = {item["elementId"]: item["result"]["values"] for item in req.result}
        self.assertEqual([v["value"] for v in by_id["dev-explicit"]],
                         [{"State": "ACTIVE", "Temp": 21.0}, {"Temp": 21.0}])
        for element_id in wanted[:4]:
            self.assertEqual(by_id[element_id], [], element_id)


class TestHistoryIsNeverSilentlyCut(_HistoryCase):
    """Whatever a limit cuts is a 206, on the item and on the response, naming where it stopped."""

    TEMPS = _telemetry(*((_at(f"10:{m}0"), "Temp", float(m)) for m in range(1, 6)))

    def test_a_metric_past_the_limit_names_where_it_stops(self):
        req, pg = self.history({"elementIds": [f"{SID}/Temp"], "limit": 3}, self.TEMPS)
        self.assertEqual([v["value"] for v in self.only(req)["values"]], [5.0, 4.0, 3.0])
        self.assertCut(req, f"{SID}/Temp", "this request's limit of 3 rows",
                       "nothing at or before 2026-09-28T10:20:00.000000Z")
        self.assertEqual(pg.calls[0][1]["limit"], "4", "one row past the limit shows there is more")

    def test_the_limit_field_lowers_the_server_limit_and_never_raises_it(self):
        with mock.patch.object(i3x_service, "HISTORY_MAX_ROWS", 2):
            req, pg = self.history({"elementIds": [f"{SID}/Temp"], "limit": 100}, self.TEMPS)
            self.assertEqual(pg.calls[0][1]["limit"], "3")
            self.assertCut(req, f"{SID}/Temp", "the server limit (I3X_HISTORY_MAX_ROWS) of 2 rows")
            req, pg = self.history({"elementIds": [f"{SID}/Temp"]}, self.TEMPS)
            self.assertEqual(len(self.only(req)["values"]), 2)
            self.assertEqual(req.status, 206)

    def test_an_answer_nothing_cut_is_a_plain_200(self):
        req, _ = self.history({"elementIds": [f"{SID}/Temp", SID], "limit": 5, "maxDepth": 0}, self.TEMPS)
        self.assertEqual(req.status, 200)
        self.assertIsNone(req.detail)
        self.assertTrue(all("responseDetail" not in item for item in req.result))

    def test_a_device_cut_mid_instant_drops_that_instant_whole(self):
        rows = _telemetry((_at("10:10"), "A", 1.0), (_at("10:10"), "B", "x"), (_at("10:20"), "A", 2.0),
                          (_at("10:30"), "A", 3.0), (_at("10:40"), "A", 4.0))
        req, pg = self.history({"elementIds": [SID], "limit": 4, "maxDepth": 0}, rows, ((SID, ("A", "B")),))
        result = self.only(req)
        # Five rows for a limit of four: 10:10 may be incomplete, so nothing of it is served, but
        # its rows are still B's value at 10:20 onwards.
        self.assertEqual([(v["timestamp"], v["value"]) for v in result["values"]], [
            ("2026-09-28T10:40:00Z", {"A": 4.0, "B": "x"}),
            ("2026-09-28T10:30:00Z", {"A": 3.0, "B": "x"}),
        ])
        self.assertEqual([v["value"] for v in result["components"][f"{SID}/A"]["values"]], [4.0, 3.0, 2.0])
        self.assertEqual(result["components"][f"{SID}/B"]["values"], [])
        # Four values, two maps of two: 10:20 did not fit.
        self.assertCut(req, SID, "4 values (a map of N metrics counts as N)",
                       "nothing at or before 2026-09-28T10:20:00.000000Z",
                       f"{SID}/B: This series stops at this request's limit of 4 rows",
                       "nothing at or before 2026-09-28T10:10:00.000000Z")
        self.assertEqual([relation for relation, _ in pg.calls], ["telemetry", "telemetry_latest"])

    def test_a_cut_window_seeds_from_the_instant_it_was_cut_at(self):
        # Three rows read for a limit of two stop inside 10:10, before B's row there. B changes
        # again after the window, so only the rows up to and including 10:10 hold its value.
        rows = _telemetry((_at("10:10"), "A", 1.0), (_at("10:10"), "B", "b"), (_at("10:20"), "A", 2.0),
                          (_at("10:30"), "A", 3.0), (_at("11:30"), "B", "later"))
        req, pg = self.history({"elementIds": [SID], "limit": 2}, rows, ((SID, ("A", "B")),))
        self.assertEqual([(v["timestamp"], v["value"]) for v in self.only(req)["values"]],
                         [("2026-09-28T10:30:00Z", {"A": 3.0, "B": "b"})])
        self.assertEqual(pg.calls[2][1]["time"], "lte.2026-09-28T10:10:00.000000Z")
        self.assertCut(req, SID, "nothing at or before 2026-09-28T10:20:00.000000Z")

    def test_a_wide_device_is_cut_by_the_values_it_returns(self):
        rows = _telemetry((_at("09:00"), "Q1", 1.0), (_at("09:00"), "Q2", 2.0), (_at("09:00"), "Q3", 3.0),
                          (_at("10:10"), "X", 1.0), (_at("10:20"), "X", 2.0), (_at("10:30"), "X", 3.0))
        req, _ = self.history({"elementIds": [SID], "limit": 8}, rows, ((SID, ("Q1", "Q2", "Q3", "X")),))
        values = self.only(req)["values"]
        self.assertEqual([v["value"]["X"] for v in values], [3.0, 2.0], "two maps of four fit in eight")
        self.assertEqual(values[0]["value"], {"Q1": 1.0, "Q2": 2.0, "Q3": 3.0, "X": 3.0})
        self.assertCut(req, SID, "nothing at or before 2026-09-28T10:10:00.000000Z")

    def test_a_seed_the_rows_before_the_window_may_not_reach_is_a_206(self):
        # N changes every minute before the window, so five rows back do not reach Q's last value.
        rows = _telemetry(*((_at(f"09:5{m}"), "N", float(m)) for m in range(10)),
                          (_at("09:00"), "Q", "old"), (_at("10:05"), "N", 99.0), (_at("10:10"), "Q", "new"))
        req, _ = self.history({"elementIds": [SID], "limit": 5}, rows, ((SID, ("N", "Q")),))
        self.assertEqual([v["value"] for v in self.only(req)["values"]],
                         [{"N": 99.0, "Q": "new"}, {"N": 99.0}])
        self.assertCut(req, SID, "1 metric(s) changed here", ": Q.")

    def test_the_206_reaches_the_wire_with_its_responseDetail(self):
        import types

        sent = []
        handler = types.SimpleNamespace(_send=lambda status, payload: sent.append((status, payload)))
        detail = {"title": "Partial results returned", "status": 206, "detail": "cut"}
        i3x_service.Handler._bulk(handler, [{"success": True, "elementId": SID, "result": {}}], detail)
        i3x_service.Handler._bulk(handler, [{"success": False, "elementId": "x"}])
        self.assertEqual(sent[0], (206, {"success": True, "results": [{"success": True, "elementId": SID,
                                                                       "result": {}}],
                                         "responseDetail": detail}))
        self.assertEqual(sent[1][0], 200)
        self.assertNotIn("responseDetail", sent[1][1])


class TestComponentLimit(_HistoryCase):
    """A value or history read descends at most MAX_COMPONENTS objects, and says so when it stops."""

    DEVICES = ((SID, ("A", "B", "C")), ("dev0000000000000000000b2", ("D", "E", "F")))

    def values(self, body):
        space, objects = _device_space(*self.DEVICES)
        req = FakeRequest(body=body, pg=ColumnCheckingPostgrest())

        def current(objects_, space_, element_id, unfilled=frozenset()):
            if element_id not in objects_:
                return None
            return {"value": 1.0, "quality": "Good", "timestamp": "2026-09-28T10:00:00Z"}

        with mock.patch.object(i3x_service, "_load_address_space", return_value=space), \
                mock.patch.object(i3x_service, "_build_objects", return_value=objects), \
                mock.patch.object(i3x_service, "_current_value", side_effect=current):
            i3x_service.h_objects_value(req)
        return req

    def test_a_value_read_past_the_limit_is_a_206_naming_what_was_left_out(self):
        with mock.patch.object(i3x_service, "MAX_COMPONENTS", 2):
            req = self.values({"elementIds": [SID], "maxDepth": 0})
        self.assertEqual(list(req.result[0]["result"]["components"]), [f"{SID}/A", f"{SID}/B"])
        self.assertEqual(req.status, 206)
        self.assertIn(SID, req.detail["detail"])
        self.assertIn("1 of 3 components were left out", req.result[0]["responseDetail"]["detail"])
        self.assertIn("I3X_MAX_COMPONENTS", req.result[0]["responseDetail"]["detail"])

    def test_the_limit_is_shared_by_the_whole_request(self):
        other = self.DEVICES[1][0]
        with mock.patch.object(i3x_service, "MAX_COMPONENTS", 4):
            req = self.values({"elementIds": [SID, other], "maxDepth": 2})
        first, second = req.result
        self.assertEqual(len(first["result"]["components"]), 3)
        self.assertNotIn("responseDetail", first)
        self.assertEqual(list(second["result"]["components"]), [f"{other}/D"])
        self.assertIn("2 of 3 components", second["responseDetail"]["detail"])
        self.assertEqual(req.status, 206)

    def test_within_the_limit_or_without_descent_is_a_200(self):
        for body in ({"elementIds": [SID], "maxDepth": 0}, {"elementIds": [SID, SID], "maxDepth": 1}):
            with self.subTest(body=body), mock.patch.object(i3x_service, "MAX_COMPONENTS", 3):
                req = self.values(body)
                self.assertEqual(req.status, 200)
                self.assertIsNone(req.detail)

    def test_a_history_read_past_the_limit_is_a_206_too(self):
        rows = _telemetry((_at("10:10"), "A", 1.0), (_at("10:10"), "B", 2.0), (_at("10:10"), "C", 3.0))
        with mock.patch.object(i3x_service, "MAX_COMPONENTS", 2):
            req, _ = self.history({"elementIds": [SID], "maxDepth": 0}, rows, self.DEVICES)
        result = self.only(req)
        self.assertEqual(list(result["components"]), [f"{SID}/A", f"{SID}/B"])
        self.assertEqual(result["values"], [{"value": {"A": 1.0, "B": 2.0, "C": 3.0}, "quality": "Good",
                                             "timestamp": "2026-09-28T10:10:00Z"}])
        self.assertCut(req, SID, "1 of 3 components were left out")


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

        src = Path(path).read_text(encoding="utf-8")
        out = {}
        for name in ("MAX_ALIASES_PER_NODE",):
            m = re.search(rf"^{name} = (.+)$", src, re.M)
            if not m:
                continue
            # The LAST quoted string on the line, not the first. Either file may write the constant
            # as a bare literal (`= "5000"`) or as an override with a default
            # (`= int(os.getenv("MAX_ALIASES_PER_NODE", "5000"))`), and in the second form the
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
        for node in ast.parse(Path(path).read_text(encoding="utf-8")).body:
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

    @staticmethod
    def _function(path, name, **names):
        """
        Top-level function `name` from `path`, compiled alone with `names` as its globals: its
        behaviour, without importing the module.
        """
        import ast
        import types

        tree = ast.parse(Path(path).read_text(encoding="utf-8"))
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
        module = compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec")
        code = next(c for c in module.co_consts if isinstance(c, types.CodeType) and c.co_name == name)
        return types.FunctionType(code, dict(names))

    def test_alias_key_behaves_as_ingestions(self):
        """
        Both key the alias table on the (group, node) the topic names. i3X once put the site's
        group in for a missing one, so each is run with that group set to a real name.
        """
        here = Path(__file__).resolve().parent
        site = {"DEFAULT_SPARKPLUG_GROUP": "SiteGroup"}
        mine = self._function(here / "i3x_service.py", "alias_key", **site)
        theirs = self._function(INGESTION_DIR / "ingestion.py", "alias_key", **site)
        for group, node in (("Aber", "gwy1"), ("", "gwy1"), (None, "gwy1"), ("Aber", None),
                            (None, None), ("SiteGroup", "gwy1")):
            with self.subTest(group=group, node=node):
                self.assertEqual(mine(group, node), theirs(group, node))
        self.assertNotEqual(mine(None, "gwy1"), mine("SiteGroup", "gwy1"),
                            "a node with no group shares the site group's alias table")


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


class TestJsonValuesAgreeWithIngestion(unittest.TestCase):
    """
    A JSON payload is served as the historian stores it. Both services read a JSON metric through
    `json_metric_value`, mirrored rather than imported (see TestMirroredConstants), and both suites
    assert test-harness/fixtures/sparkplug-json-values.json through their own parser.
    """

    FIXTURE = Path(__file__).resolve().parents[1] / "test-harness" / "fixtures" / "sparkplug-json-values.json"
    DEVICE = TestSparkplugValues.DEVICE

    def setUp(self):
        for table in ("_values", "_alias_map", "_alias_datatypes", "_name_datatypes"):
            getattr(i3x_service, table).clear()

    tearDown = setUp

    @staticmethod
    def _function(path):
        import ast

        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == "json_metric_value":
                body = node.body[1:] if ast.get_docstring(node) else node.body
                return [ast.dump(node.args)] + [ast.dump(stmt) for stmt in body]
        return None

    def test_the_parser_is_the_same_code_in_both_services(self):
        here = Path(__file__).resolve().parent
        mine = self._function(here / "i3x_service.py")
        self.assertIsNotNone(mine)
        self.assertEqual(
            mine, self._function(INGESTION_DIR / "ingestion.py"),
            "json_metric_value has drifted between i3x_service.py and ingestion.py",
        )

    def test_every_case_is_served_as_the_fixture_says(self):
        cases = json.loads(self.FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 10)
        body = {"timestamp": 1790000000000, "metrics": [case["metric"] for case in cases]}
        topic = "spBv1.0/Aber/DDATA/%s/%s" % (TestSparkplugValues.NODE, self.DEVICE)
        i3x_service.on_message(None, None, _Message(topic, json.dumps(body).encode("utf-8")))
        served = {name: entry["value"] for name, entry in i3x_service.metrics_for(self.DEVICE).items()}
        for case in cases:
            name = case["metric"]["name"]
            with self.subTest(case=name):
                if case.get("dropped"):
                    self.assertNotIn(name, served)
                else:
                    self.assertEqual(served[name], case["reads"])
                    self.assertEqual(type(served[name]) is bool, type(case["reads"]) is bool)


class TestNamespaces(unittest.TestCase):
    """
    GET /namespaces lists the namespaces the served types belong to, and only those.

    i3X groups ObjectTypes and RelationshipTypes into namespaces, and an Object reaches one through
    its type (`typeNamespaceUri`), so a client reads the list as the set it will meet there. A
    schema's type is local. A metric's type is its catalog row, in the namespace its semantic id is
    defined in, so the space carries a metric from each standard, one with an id under another
    authority, and one with none.
    """

    SCHEMA = {
        "id": "schema-1",
        "schema_name": "Mill",
        "schema_definition": {"properties": {"Axes/X/POSITION": {}, "OEE/OEE": {}}},
        "semantic_id": "https://admin-shell.io/idta/example/1/0",
    }
    MACHINERY = "http://opcfoundation.org/UA/Machinery/"
    # Catalog name -> (semantic id, the namespace its type belongs to).
    CATALOG = {
        "Axes/X/POSITION": ("https://aber.local/semantics/mtconnect/v2.0/DataItemType/POSITION",
                            "https://aber.local/semantics/mtconnect/v2.0"),
        "OEE/OEE": ("https://aber.local/semantics/iso22400/OEE",
                    "https://aber.local/semantics/iso22400"),
        "Machine/OperatingMode": (MACHINERY + "MachineryOperationMode",
                                  MACHINERY + "?projection=i3X"),
        "Energy/Pressure": (MACHINERY + "Energy/Pressure", MACHINERY + "Energy/?projection=i3X"),
        "BMS/ZONE_TEMPERATURE": ("http://data.ashrae.org/standard223#TemperatureSensor",
                                 "http://data.ashrae.org/standard223?projection=i3X"),
        "Vendor/READING": ("https://example.com/ns/reading", A.NS_LOCAL),
        "Local/READING": (None, A.NS_LOCAL),
    }

    def rows(self):
        return [{"name": name, "datatype": 10, "semantic_id": semantic_id}
                for name, (semantic_id, _) in self.CATALOG.items()]

    def served(self):
        types = i3x_service._build_types({"schemas": [self.SCHEMA], "metric_catalog": self.rows()})
        objects = dict(_representative_space())
        typed = A.device_object({"sparkplug_id": "dev-typed", "_gateway_sparkplug_id": None}, None, "schema-1")
        objects[typed["elementId"]] = typed
        for row in self.rows():
            metric = A.metric_object("dev-typed", row["name"], A.metric_type_from_catalog(row))
            objects[metric["elementId"]] = metric
        return types, A.relationship_types(), objects

    def advertised(self):
        return A.namespaces(self.served()[0])

    def used(self):
        types, relationships, objects = self.served()
        return (
            {t["namespaceUri"] for t in types}
            | {r["namespaceUri"] for r in relationships}
            | {o["metadata"]["typeNamespaceUri"] for o in objects.values()}
        )

    def test_every_advertised_namespace_is_one_a_type_belongs_to(self):
        used = self.used()
        for namespace in self.advertised():
            self.assertIn(
                namespace["uri"], used,
                f"{namespace['uri']} is advertised but no type or object carries it",
            )

    def test_every_namespace_a_type_belongs_to_is_advertised(self):
        advertised = {n["uri"] for n in self.advertised()}
        self.assertLessEqual(self.used(), advertised)
        self.assertEqual(len(advertised), len(self.advertised()), "a namespace is listed twice")

    def test_an_objects_type_namespace_is_its_types(self):
        types, _, objects = self.served()
        by_id = {t["elementId"]: t["namespaceUri"] for t in types}
        for element_id, obj in objects.items():
            with self.subTest(element_id=element_id):
                self.assertEqual(
                    obj["metadata"]["typeNamespaceUri"], by_id[obj["typeElementId"]],
                )

    def test_a_metric_type_is_in_the_namespace_its_semantic_id_is_defined_in(self):
        types = {t["elementId"]: t for t in self.served()[0]}
        for name, (semantic_id, namespace) in self.CATALOG.items():
            with self.subTest(name=name):
                metric_type = types[A.metric_type_id(name)]
                self.assertEqual(metric_type["namespaceUri"], namespace)
                self.assertEqual(metric_type["sourceTypeId"], semantic_id or name)

    def test_a_standards_own_namespace_is_only_advertised_as_a_projection(self):
        # A type adapted from a standard is not that standard's: under the body's authority, the
        # guide's `?projection=` suffix says so. A bare mtconnect.org or opcfoundation.org URI
        # would claim the body defined it.
        for namespace in self.advertised():
            uri = namespace["uri"]
            with self.subTest(uri=uri):
                self.assertTrue(
                    uri.startswith("https://aber.local/") or uri.endswith("?projection=i3X"), uri
                )
                self.assertNotEqual(namespace["displayName"], uri, "no display name")

    def test_with_no_catalog_only_the_two_local_namespaces_are_listed(self):
        types = i3x_service._build_types({"schemas": [self.SCHEMA]})
        self.assertEqual([n["uri"] for n in A.namespaces(types)], [A.NS_LOCAL, A.NS_RELATIONSHIPS])

    # Vocabulary table -> the namespace its concepts land in; None is an OPC UA row's own
    # companion spec, read from its NodeId's `nsu=`.
    VOCABULARIES = {
        "mtconnect_vocabulary": "https://aber.local/semantics/mtconnect/v2.0",
        "iso22400_vocabulary": "https://aber.local/semantics/iso22400",
        "opcua_vocabulary": None,
        "ashrae223_vocabulary": "http://data.ashrae.org/standard223?projection=i3X",
    }

    def test_every_seeded_concept_lands_in_its_standards_namespace(self):
        """Every semantic id a vocabulary can hand a catalog row, from the applied migrations."""
        row = re.compile(
            r"^INSERT INTO public\.(\w+_vocabulary) VALUES \((.*)'((?:[^']|'')*)'\);?\s*$", re.M
        )
        seen = dict.fromkeys(self.VOCABULARIES, 0)
        for path in sorted(MIGRATIONS_DIR.glob("[0-9]*.sql")):
            for table, values, semantic_id in row.findall(path.read_text(encoding="utf-8")):
                expected = self.VOCABULARIES[table]
                if expected is None:
                    expected = re.search(r"'nsu=([^;']+);", values).group(1) + A.PROJECTION_SUFFIX
                if A.metric_type_namespace(semantic_id) != expected:
                    self.fail(f"{table}: {semantic_id} lands in "
                              f"{A.metric_type_namespace(semantic_id)}, not {expected}")
                seen[table] += 1
        for table, count in seen.items():
            self.assertGreater(count, 5, f"read no {table} rows: the seed's shape changed")

    def test_the_local_namespaces_are_where_the_dashboard_mints_ids(self):
        standards = Path(__file__).resolve().parents[1] / "frontend/src/utils/standards.js"
        constants = dict(re.findall(
            r"^export const (\w+_NAMESPACE) = [`']([^`']+)[`']",
            standards.read_text(encoding="utf-8"),
            re.M,
        ))
        base = constants["LOCAL_SEMANTIC_NAMESPACE"]
        minted = {constants[name].replace("${LOCAL_SEMANTIC_NAMESPACE}", base)
                  for name in ("MTCONNECT_SEMANTIC_NAMESPACE", "ISO22400_SEMANTIC_NAMESPACE")}
        self.assertEqual(set(A._LOCAL_STANDARD_NAMESPACES), minted)


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

    # With no schemas or catalog rows, the local types are the synthetic ones and the metric
    # fallbacks, which are always served.
    LOCAL_TYPES = len(A.SYNTHETIC_TYPES) + len(A.METRIC_FALLBACK_TYPES)

    def test_no_filter_returns_every_type(self):
        self.assertEqual(len(self.served(i3x_service.h_objecttypes)), self.LOCAL_TYPES)
        self.assertEqual(
            len(self.served(i3x_service.h_relationshiptypes)), len(A.RELATIONSHIP_TYPES)
        )

    def test_each_namespace_returns_only_its_own_types(self):
        encoded = "?namespaceUri=https%3A%2F%2Faber.local%2Fi3x"
        object_types = self.served(i3x_service.h_objecttypes, encoded)
        self.assertEqual(len(object_types), self.LOCAL_TYPES)
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

        # And the ordinary case still passes through, as the id each entry names.
        self.assertEqual(i3x_service._registration_entries({"elementIds": ["a"]}), ["a"])
        self.assertEqual(
            i3x_service._registration_entries({"objects": [{"elementId": "a"}, "b"]}), ["a", "b"]
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
