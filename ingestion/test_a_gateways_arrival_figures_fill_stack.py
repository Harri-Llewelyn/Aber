# suite:
#   lanes: stack
#   why: THE ONLY CHECK THAT THE FIGURES FOR WHAT ARRIVES FROM A GATEWAY FILL FROM A LIVE STACK.
#     The db suite holds refresh_gateway_arrivals() against answers filed by hand, so it cannot know
#     the query is one Prometheus answers: the edge_node label on aber_ingestion_messages_total, the
#     sum by (edge_node), the route from supabase-db to prometheus. Against the running stack, once
#     pg_cron has run the collector, every gateway that is online has a fresh row whose rate is
#     read from its own edge node; the last answer carries the label; a Shopfloor Manager reads the
#     view through PostgREST and the devices' last readings through the function; anon reads
#     nothing and nobody writes the table. With a gateway online it reads only. With none online, as
#     in CI, it publishes as a fixture Host gateway of its own and removes it afterwards. Needs the
#     stack up, the seeded Administrator and Shopfloor Manager and the owner connection
#     (SUPABASE_DB_*); two to four minutes for the scrape and the collector's first full cycle.

"""
A gateway's arrival figures fill from the live stack (0303).

    python ingestion/test_a_gateways_arrival_figures_fill_stack.py

The db suite (supabase/migrations/test_a_gateway_shows_what_arrives_from_it.py) holds the collector
against recorded answers. This suite holds the path that no recording can: the ingestion daemon
labels each message with its edge node, Prometheus holds the series, pg_net reaches it from the
database over the network policy's route, and the table fills. It walks:

  1. a gateway to read: any gateway that is online, and where none is, a Sparkplug 3.0.0 edge node
     in this process, publishing as a fixture Host gateway of the suite's own (credential issued as
     the Gateways page issues it, one device, a reading every few seconds);
  2. a wait for the table: every gateway to read has a row evaluated within the last 3 minutes and,
     for the fixture, a rate above zero. The wait is bounded and names what it waited for;
  3. the collector has run: pg_cron's last runs of `refresh-gateway-arrivals` succeeded;
  4. the rate of at least one gateway is above zero, the gap and missed counts are whole numbers, and
     the last answer Prometheus gave (read from net._http_response) carries each gateway's series,
     labelled with its edge node, and says ingestion was scraped;
  5. a Shopfloor Manager reads the same rows from `gateway_arrivals` through PostgREST, and each
     gateway's devices from `gateway_devices_last_reading()`, with a time that is not in the future;
  6. anon reads nothing, and the manager cannot write the table.

A gateway already online is only read: nothing is created or deleted. The fixture's gateway, device,
broker account, historian rows and audit rows are removed when the class ends, whatever happened.
The fixture ids are pinned, so a run killed before its cleanup leaves rows the next run reclaims.

Needs the stack up (npm run dev:up and the port-forwards), the environment test_playback_replay.py
reads, `SUPABASE_DB_*` for the owner connection, and the seeded Shopfloor Manager, and for the
fixture the seeded Administrator and paho-mqtt with the Sparkplug binding (npm run proto). It skips,
with its reason, when there is none of these. `REQUIRE_PLAYBACK_REPLAY=1` makes every skip a failure.
"""

import json
import os
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

INGESTION = Path(__file__).resolve().parent
sys.path.insert(0, str(INGESTION))
sys.path.insert(0, str(INGESTION.parent / "test-harness"))

import stack_sign_in  # noqa: E402
import test_a_derived_name_is_dropped_stack as edge  # noqa: E402 -- the fixture edge node, as a module
from test_playback_replay import (  # noqa: E402
    PUBLISHABLE_KEY, SUPABASE_URL, Session, _request, historian, sign_in, skip_or_fail,
)
from test_playback_replay import setUpModule as stack_is_up  # noqa: E402
from test_recorded_capture_replay import (  # noqa: E402
    BROKER_ACCEPT_TIMEOUT, MQTT_HOST, MQTT_PORT, delete_broker_account, owner_connection, poll,
)

PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
MANAGER = "manager@aber.local"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")

# Pinned, so a run killed before its cleanup leaves rows the next run reclaims. They differ from
# each other and from every other fixture in the first hex block: `sparkplug_id` is the first 21 hex
# characters of the uuid, so ids sharing a long prefix collide.
GATEWAY_ID = "0303a000-0000-4000-8000-000000000303"
DEVICE_ID = "0303b000-0000-4000-8000-000000000303"
METRIC = "T303/PART_COUNT"

# How often the fixture publishes a reading. The counter rises with each one, so the rate Prometheus
# computes between two scrapes is above zero.
PUBLISH_SECONDS = 3
# Alloy scrapes the daemon every 15 s (observability.alloy scrapeInterval in the chart); pg_cron runs
# the collector every minute and each answer is a minute old.
SCRAPE_SECONDS = 15
COLLECTOR_SECONDS = 60
# The first reading is scraped within a scrape, the next scrape gives the rate, the collector's next
# run asks Prometheus and the run after collects the answer. Worst case with a margin.
FILL_TIMEOUT_SECONDS = 2 * SCRAPE_SECONDS + 2 * COLLECTOR_SECONDS + 90
POLL_SECONDS = 5
HISTORIAN_TIMEOUT = 60
# How old Prometheus's answer may be before the view reads not observed (migration 0303).
FRESH = timedelta(minutes=3)


def setUpModule():
    stack_is_up()


class Publisher(threading.Thread):
    """
    The fixture's DDATA, on one thread: SmallEdgeNode sends on the caller's thread, so `seq` reaches
    the wire in order only while one thread sends. The birth is made before this starts.
    """

    def __init__(self, node, device_id):
        super().__init__(name="arrival-figures-publisher", daemon=True)
        self.node = node
        self.device_id = device_id
        self.sent = 0
        self.failures = 0
        self._halt = threading.Event()

    def run(self):
        # The first reading follows the birth by a pause, so the daemon has registered the device.
        while not self._halt.wait(PUBLISH_SECONDS):
            if self.node.data(self.device_id, [METRIC], [float(self.sent)]):
                self.sent += 1
            else:
                self.failures += 1

    def stop(self):
        self._halt.set()
        self.join(10)


class TheFiguresFill(unittest.TestCase):
    """One read of the stack, walked in setUpClass; each test asserts one fact about it."""

    @classmethod
    def setUpClass(cls):
        cls.session = cls.fixture = cls.device = cls.node = cls.publisher = cls.owner = None
        cls.addClassCleanup(cls._clean_up)
        status, body = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, MANAGER, PASSWORD)
        if status == stack_sign_in.NO_SUCH_ACCOUNT:
            reason = f"could not sign in as {MANAGER} ({status}); the seed personas are absent"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        if status != 200:
            raise AssertionError(stack_sign_in.describe(MANAGER, status, body))
        cls.manager = Session(body["access_token"])
        cls.owner = owner_connection()
        cls.owner.autocommit = True

        # ARRIVAL_FIGURES_OWN_GATEWAY=1 publishes as the fixture even while a gateway is online, so the
        # path CI takes can be run on a dev stack whose own gateways are publishing.
        forced = os.getenv("ARRIVAL_FIGURES_OWN_GATEWAY", "").lower() in ("1", "true", "yes")
        cls.live = [] if forced else cls.online_gateways()
        cls.own = not cls.live
        if cls.own:
            cls.live = [cls._publish_as_a_fixture_gateway()]
        cls.rows = poll(cls.read_rows, cls.is_filled, FILL_TIMEOUT_SECONDS, POLL_SECONDS)
        if not cls.is_filled(cls.rows):
            raise AssertionError(cls._what_was_waited_for())

    # ---- a gateway to read -------------------------------------------------------------------
    @classmethod
    def _publish_as_a_fixture_gateway(cls):
        """The suite's own Host gateway, publishing a rising count, as {id, edge_node, name}."""
        if edge.IMPORT_ERROR is not None:
            skip_or_fail(f"no gateway is online and paho-mqtt or the Sparkplug binding is unavailable "
                         f"({edge.IMPORT_ERROR}), so there is nothing to publish as; "
                         f"npm run proto generates ingestion/sparkplug_b_pb2.py")
        cls.session = Session(sign_in())
        gateway = cls.session.upsert("gateways", {
            "id": GATEWAY_ID, "name": "ARRIVAL_FIGURES_Gateway", "deployment": "host",
            "description": "Fixture for ingestion/test_a_gateways_arrival_figures_fill_stack.py. Safe to delete.",
        })
        cls.fixture = gateway
        cls.device = cls.session.upsert("devices", {
            "id": DEVICE_ID, "name": "ARRIVAL_FIGURES_Device", "gateway_id": gateway["id"],
            "description": "Fixture for ingestion/test_a_gateways_arrival_figures_fill_stack.py. Safe to delete.",
        })
        cls.node = cls._connect_edge_node(gateway, cls._issue_credential(gateway))
        cls.node.birth(cls.device["sparkplug_id"], cls.device["name"], [METRIC])
        cls.publisher = Publisher(cls.node, cls.device["sparkplug_id"])
        cls.publisher.start()
        return {"id": gateway["id"], "edge_node": gateway["sparkplug_id"], "name": gateway["name"]}

    @classmethod
    def _issue_credential(cls, gateway):
        status, body = _request(
            f"{SUPABASE_URL}/functions/v1/gateway-credential", method="POST",
            body={"gateway_id": gateway["id"]},
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {cls.session.token}",
                     "Content-Type": "application/json"},
        )
        if status != 200 or not (body or {}).get("password"):
            raise AssertionError(
                f"could not issue the fixture gateway's broker credential: {status} "
                f"{(body or {}).get('error')} {(body or {}).get('details')}")
        if body.get("mqtt_username") != gateway["sparkplug_id"]:
            raise AssertionError(f"the credential is for {body.get('mqtt_username')!r}, not the "
                                 f"gateway's sparkplug_id {gateway['sparkplug_id']!r}")
        return body["password"]

    @classmethod
    def _connect_edge_node(cls, gateway, password):
        """A new credential can take a moment to reach the running broker, so a refusal is retried."""
        deadline = time.monotonic() + BROKER_ACCEPT_TIMEOUT
        while True:
            node = edge.SmallEdgeNode(gateway["sparkplug_group"], gateway["sparkplug_id"], password)
            try:
                rc = node.connect()
            except OSError as err:
                node.stop()
                raise AssertionError(f"cannot reach the broker at {MQTT_HOST}:{MQTT_PORT} ({err})")
            if rc == 0 and node.subscribed.is_set():
                return node
            node.stop()
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"the broker did not accept the fixture gateway within {BROKER_ACCEPT_TIMEOUT}s "
                    f"(CONNACK {rc}, NCMD subscription granted: {node.subscribed.is_set()})")
            time.sleep(2)

    # ---- reads -------------------------------------------------------------------------------
    @classmethod
    def online_gateways(cls):
        with cls.owner.cursor() as cur:
            cur.execute(
                "SELECT id::text, sparkplug_id, name FROM public.gateway_status"
                " WHERE live_status = 'ONLINE' AND is_shadow IS NOT TRUE AND is_archived IS NOT TRUE"
                " ORDER BY name;")
            return [{"id": r[0], "edge_node": r[1], "name": r[2]} for r in cur.fetchall()]

    @classmethod
    def read_rows(cls):
        """{gateway id: (messages_per_second, gaps, missed, observed_at)} for every gateway to read."""
        with cls.owner.cursor() as cur:
            cur.execute(
                "SELECT gateway_id::text, messages_per_second, sequence_gaps_last_hour,"
                " messages_missed_last_hour, observed_at FROM public.gateway_arrival_figures"
                " WHERE gateway_id::text = ANY (%s);", ([g["id"] for g in cls.live],))
            return {r[0]: r[1:] for r in cur.fetchall()}

    @classmethod
    def is_filled(cls, rows):
        """Every gateway to read has a fresh row; the fixture's rate is above zero as well, since
        it is the one gateway known to be publishing."""
        now = datetime.now(timezone.utc)
        for gateway in cls.live:
            row = rows.get(gateway["id"])
            if row is None or row[3] is None or now - row[3] > FRESH:
                return False
            if cls.own and not (row[0] and row[0] > 0):
                return False
        return True

    @classmethod
    def _what_was_waited_for(cls):
        sent = f"; the fixture sent {cls.publisher.sent} readings ({cls.publisher.failures} refused)" if cls.publisher else ""
        with cls.owner.cursor() as cur:
            cur.execute(
                "SELECT d.status, left(coalesce(d.return_message, ''), 120) FROM cron.job_run_details d"
                " JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'refresh-gateway-arrivals'"
                " ORDER BY d.start_time DESC LIMIT 3;")
            runs = cur.fetchall()
        return (f"waited {FILL_TIMEOUT_SECONDS}s for a row evaluated within the last {FRESH} "
                f"{'with messages_per_second above 0 ' if cls.own else ''}for "
                f"{[g['name'] for g in cls.live]}, which needs Prometheus to scrape the daemon twice "
                f"(every {SCRAPE_SECONDS}s) and pg_cron to run the collector twice (every "
                f"{COLLECTOR_SECONDS}s). The rows read {cls.rows}; the collector's last runs {runs}{sent}. "
                f"Check that the daemon labels aber_ingestion_messages_total with edge_node, that "
                f"Prometheus answers pg_net, and that the daemon was reached by the fixture.")

    def last_answer(self):
        """What Prometheus last answered the collector, as the samples it carried, or None."""
        with self.owner.cursor() as cur:
            cur.execute(
                "SELECT r.status_code, r.content FROM public.gateway_arrival_probe p"
                " JOIN net._http_response r ON r.id = p.request_id WHERE p.id;")
            row = cur.fetchone()
        if not row or row[0] != 200:
            return None
        body = json.loads(row[1])
        return body["data"]["result"] if body.get("status") == "success" else None

    # ---- the collector ran -------------------------------------------------------------------
    def test_the_collector_s_last_runs_succeeded(self):
        with self.owner.cursor() as cur:
            cur.execute(
                "SELECT d.status, d.return_message FROM cron.job_run_details d"
                " JOIN cron.job j ON j.jobid = d.jobid WHERE j.jobname = 'refresh-gateway-arrivals'"
                " ORDER BY d.start_time DESC LIMIT 3;")
            runs = cur.fetchall()
        self.assertTrue(runs, "pg_cron has not run refresh-gateway-arrivals")
        self.assertEqual({status for status, _ in runs}, {"succeeded"}, runs)

    # ---- the figures ---------------------------------------------------------------------------
    def test_every_gateway_to_read_has_a_fresh_row(self):
        now = datetime.now(timezone.utc)
        for gateway in self.live:
            with self.subTest(gateway=gateway["name"]):
                self.assertIn(gateway["id"], self.rows, "no row: the collector has not seen this gateway")
                rate, gaps, missed, observed_at = self.rows[gateway["id"]]
                self.assertIsNotNone(observed_at, "not observed: no answer from Prometheus that observed ingestion")
                self.assertLessEqual(now - observed_at, FRESH + timedelta(minutes=1))
                self.assertIsNotNone(rate)
                self.assertGreaterEqual(rate, 0)

    def test_a_publishing_gateway_s_messages_are_counted_under_its_own_edge_node(self):
        """An online gateway publishes a heartbeat every few seconds, and the fixture a reading
        every few, so at least one rate is above 0."""
        rates = [self.rows[g["id"]][0] for g in self.live if g["id"] in self.rows]
        self.assertTrue(any(rate and rate > 0 for rate in rates),
                        f"every gateway reads 0 messages a second: {rates}; is the ingestion "
                        f"daemon on the build that labels aber_ingestion_messages_total by edge_node?")

    def test_the_gap_and_missed_counts_are_whole_numbers(self):
        for gateway in self.live:
            with self.subTest(gateway=gateway["name"]):
                _, gaps, missed, _ = self.rows[gateway["id"]]
                self.assertIsInstance(gaps, int)
                self.assertIsInstance(missed, int)
                self.assertGreaterEqual(gaps, 0)
                self.assertGreaterEqual(missed, 0)

    def test_the_last_answer_carries_each_gateway_s_series_and_says_ingestion_was_scraped(self):
        answer = poll(self.last_answer, lambda a: a is not None, 70, POLL_SECONDS)
        self.assertIsNotNone(answer, "net._http_response holds no answer to the collector's last request")
        figures = {}
        for sample in answer:
            metric = sample["metric"]
            figures.setdefault(metric.get("figure"), {})[metric.get("edge_node")] = float(sample["value"][1])
        self.assertIn("ingestion_scraped", figures, "Prometheus did not observe ingestion")
        rates = figures.get("messages_per_second", {})
        self.assertTrue(any(g["edge_node"] in rates for g in self.live),
                        f"no gateway has a series labelled with its edge node in {sorted(rates)}")

    # ---- who reads ---------------------------------------------------------------------------
    def test_a_manager_reads_the_view_through_postgrest(self):
        for gateway in self.live:
            with self.subTest(gateway=gateway["name"]):
                status, body = self.manager.rest(
                    f"/gateway_arrivals?gateway_id=eq.{gateway['id']}"
                    "&select=gateway_id,messages_per_second,sequence_gaps_last_hour,messages_missed_last_hour,observed_at")
                self.assertEqual(status, 200, body)
                self.assertEqual(len(body), 1, body)
                self.assertEqual(body[0]["gateway_id"], gateway["id"])
                # Fresh, so not blanked by the view's 3-minute rule.
                self.assertIsNotNone(body[0]["observed_at"], body)
                self.assertIsNotNone(body[0]["messages_per_second"], body)

    def test_each_gateway_s_devices_come_with_the_time_of_their_last_reading(self):
        asked = 0
        for gateway in self.live:
            with self.owner.cursor() as cur:
                cur.execute("SELECT id::text FROM public.devices WHERE gateway_id::text = %s"
                            " AND is_archived IS NOT TRUE;", (gateway["id"],))
                devices = {r[0] for r in cur.fetchall()}
            if not devices:
                continue
            asked += 1
            with self.subTest(gateway=gateway["name"]):
                status, body = self.manager.rpc("gateway_devices_last_reading", {"p_gateway_id": gateway["id"]})
                self.assertEqual(status, 200, body)
                self.assertEqual({row["device_id"] for row in body}, devices)
                now = datetime.now(timezone.utc)
                for row in body:
                    if row["last_reading_at"] is not None:
                        at = datetime.fromisoformat(row["last_reading_at"].replace("Z", "+00:00"))
                        self.assertLessEqual(at, now + timedelta(minutes=2), "a reading from the future")
        if asked == 0:
            self.skipTest("no gateway to read serves a device, so there is no last reading to ask for")

    def test_the_fixture_device_s_reading_reaches_the_historian_and_is_read_back(self):
        if not self.own:
            self.skipTest("a gateway was already online, so no fixture was published")
        status, body = self.manager.rpc("gateway_devices_last_reading", {"p_gateway_id": GATEWAY_ID})
        self.assertEqual(status, 200, body)
        self.assertEqual([row["device_id"] for row in body], [DEVICE_ID])
        self.assertIsNotNone(body[0]["last_reading_at"], "the historian holds no reading from the fixture device")

    def test_anon_reads_nothing(self):
        for path in ("/gateway_arrivals?select=gateway_id", "/gateway_arrival_figures?select=gateway_id"):
            with self.subTest(path=path):
                status, _ = _request(f"{SUPABASE_URL}/rest/v1{path}", headers={"apikey": PUBLISHABLE_KEY})
                self.assertIn(status, (401, 403))

    def test_nobody_signed_in_writes_the_table(self):
        gateway = self.live[0]
        for method, path, body in (
            ("PATCH", f"/gateway_arrival_figures?gateway_id=eq.{gateway['id']}", {"messages_per_second": 999}),
            ("POST", "/gateway_arrival_figures", {"gateway_id": gateway["id"], "messages_per_second": 999}),
            ("DELETE", f"/gateway_arrival_figures?gateway_id=eq.{gateway['id']}", None),
        ):
            with self.subTest(method=method):
                status, _ = self.manager.rest(path, method, body)
                self.assertIn(status, (401, 403))
        rate = self.read_rows()[gateway["id"]][0]
        self.assertNotEqual(rate, 999)

    # ---- everything the suite made -------------------------------------------------------------
    @classmethod
    def _clean_up(cls):
        if cls.publisher is not None:
            cls.publisher.stop()
        if cls.node is not None:
            cls.node.stop()

        def attempt(what, action):
            try:
                action()
            except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
                print(f"cleanup warning: {what}: {err}")

        if cls.session is not None:
            # The device explicitly: deleting a gateway leaves its devices unassigned rather than gone.
            # The gateway's row in the figures goes with it.
            attempt("the device", lambda: cls.session.rest(f"/devices?id=eq.{DEVICE_ID}", method="DELETE"))
            attempt("the gateway", lambda: cls.session.rest(f"/gateways?id=eq.{GATEWAY_ID}", method="DELETE"))
        if cls.fixture:
            def drop_account():
                result = delete_broker_account(cls.fixture["sparkplug_id"])
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.strip() or result.stdout.strip())
            attempt("the broker account", drop_account)
        if cls.device:
            attempt("the historian rows", cls._delete_telemetry)
        if cls.owner is not None:
            if cls.fixture:
                attempt("the audit rows", cls._delete_audit_rows)
            attempt("the owner connection", cls.owner.close)

    @classmethod
    def _delete_telemetry(cls):
        conn = historian()
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                # The id a literal, so only this asset's compressed batches are opened.
                cur.execute("DELETE FROM telemetry WHERE asset_id = %s", (cls.device["sparkplug_id"],))
                cur.execute("DELETE FROM assets WHERE asset_id = %s", (cls.device["sparkplug_id"],))
        except psycopg2.Error as err:
            print(f"cleanup warning: the historian rows: {err}")
        finally:
            conn.close()

    @classmethod
    def _delete_audit_rows(cls):
        with cls.owner.cursor() as cur:
            if cls.device:
                cur.execute("DELETE FROM public.asset_config WHERE asset_id = %s", (cls.device["sparkplug_id"],))
            # audit_trail takes no DELETE from any application role, so what the fixtures wrote
            # needs the owner.
            cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])",
                        ([GATEWAY_ID, DEVICE_ID],))


if __name__ == "__main__":
    unittest.main(verbosity=2)
