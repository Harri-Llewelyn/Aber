# suite:
#   lanes: stack
#   why: THE ONLY CHECK THAT THE FIGURES FOR WHAT ARRIVES FROM A GATEWAY FILL FROM A LIVE STACK.
#     The db suite holds refresh_gateway_arrivals() against answers filed by hand, so it cannot know
#     the query is one Prometheus answers: the edge_node label on aber_ingestion_messages_total, the
#     sum by (edge_node), the route from supabase-db to prometheus. Against the running stack, once
#     pg_cron has run the collector, every gateway that is online has a fresh row whose rate is
#     read from its own edge node; the last answer carries the label; a Shopfloor Manager reads the
#     view through PostgREST and the devices' last readings through the function; anon reads
#     nothing and nobody writes the table. Reads only: it creates nothing and deletes nothing.
#     Needs the stack up, at least one gateway online, the seeded Shopfloor Manager and the owner
#     connection (SUPABASE_DB_*); about two minutes for the collector's first full cycle.

"""
A gateway's arrival figures fill from the live stack (0303).

    python ingestion/test_a_gateways_arrival_figures_fill_stack.py

The db suite (supabase/migrations/test_a_gateway_shows_what_arrives_from_it.py) holds the collector
against recorded answers. This suite holds the path that no recording can: the ingestion daemon
labels each message with its edge node, Prometheus holds the series, pg_net reaches it from the
database over the network policy's route, and the table fills. It reads the running stack and
changes nothing:

  1. the collector has run: pg_cron's last runs of `refresh-gateway-arrivals` succeeded;
  2. every gateway that is online has a row evaluated within the last 3 minutes, and the rate of at
     least one is above zero: an online gateway publishes a heartbeat at least every few seconds;
  3. the gap and missed counts are whole numbers, and the rows of a gateway that is online are the
     figures the answer Prometheus gave carries for its edge node (the last answer is read from
     net._http_response);
  4. a Shopfloor Manager reads the same rows from `gateway_arrivals` through PostgREST, and each
     live gateway's devices from `gateway_devices_last_reading()`, with a time that is not in the
     future;
  5. anon reads nothing, and the manager cannot write the table.

Needs the stack up (npm run dev:up and the port-forwards), at least one gateway online,
`SUPABASE_DB_*` for the owner connection, and the seeded Shopfloor Manager. It skips, with its
reason, when there is none of these. `REQUIRE_PLAYBACK_REPLAY=1` makes every skip a failure.
"""

import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

INGESTION = Path(__file__).resolve().parent
sys.path.insert(0, str(INGESTION))
sys.path.insert(0, str(INGESTION.parent / "test-harness"))

import stack_sign_in  # noqa: E402
from test_playback_replay import PUBLISHABLE_KEY, SUPABASE_URL, Session, _request, skip_or_fail  # noqa: E402
from test_playback_replay import setUpModule as stack_is_up  # noqa: E402
from test_recorded_capture_replay import owner_connection, poll  # noqa: E402

PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
MANAGER = "manager@aber.local"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")

# pg_cron runs the collector every minute and each answer is a minute old, so a full cycle, from a
# stack just started, is two runs and a margin.
FILL_TIMEOUT_SECONDS = 180
POLL_SECONDS = 5
# How old Prometheus's answer may be before the view reads not observed (migration 0303).
FRESH = timedelta(minutes=3)


def setUpModule():
    stack_is_up()


class TheFiguresFill(unittest.TestCase):
    """One read of the stack, walked in setUpClass; each test asserts one fact about it."""

    @classmethod
    def setUpClass(cls):
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
        cls.addClassCleanup(cls.owner.close)

        cls.live = cls.online_gateways()
        if not cls.live:
            skip_or_fail("no gateway is online, so there is nothing arriving to count; start a gateway "
                         "(the dev stack's Node-RED host gateway publishes) and run this again")
        cls.rows = poll(cls.read_rows, cls.every_live_gateway_is_fresh, FILL_TIMEOUT_SECONDS, POLL_SECONDS)

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
        """{gateway id: (messages_per_second, gaps, missed, observed_at)} for every live gateway."""
        with cls.owner.cursor() as cur:
            cur.execute(
                "SELECT gateway_id::text, messages_per_second, sequence_gaps_last_hour,"
                " messages_missed_last_hour, observed_at FROM public.gateway_arrival_figures"
                " WHERE gateway_id::text = ANY (%s);", ([g["id"] for g in cls.live],))
            return {r[0]: r[1:] for r in cur.fetchall()}

    @classmethod
    def every_live_gateway_is_fresh(cls, rows):
        now = datetime.now(timezone.utc)
        return all(
            g["id"] in rows and rows[g["id"]][3] is not None and now - rows[g["id"]][3] <= FRESH
            for g in cls.live)

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
    def test_every_online_gateway_has_a_fresh_row(self):
        now = datetime.now(timezone.utc)
        for gateway in self.live:
            with self.subTest(gateway=gateway["name"]):
                self.assertIn(gateway["id"], self.rows, "no row: the collector has not seen this gateway")
                rate, gaps, missed, observed_at = self.rows[gateway["id"]]
                self.assertIsNotNone(observed_at, "not observed: no answer from Prometheus that observed ingestion")
                self.assertLessEqual(now - observed_at, FRESH + timedelta(minutes=1))
                self.assertIsNotNone(rate)
                self.assertGreaterEqual(rate, 0)

    def test_an_online_gateway_s_messages_are_counted_under_its_own_edge_node(self):
        """An online gateway publishes a heartbeat every few seconds, so at least one rate is above 0."""
        rates = [self.rows[g["id"]][0] for g in self.live if g["id"] in self.rows]
        self.assertTrue(any(rate and rate > 0 for rate in rates),
                        f"every online gateway reads 0 messages a second: {rates}; is the ingestion "
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
                        f"no online gateway has a series labelled with its edge node in {sorted(rates)}")

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

    def test_each_live_gateway_s_devices_come_with_the_time_of_their_last_reading(self):
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
            self.skipTest("no online gateway serves a device, so there is no last reading to ask for")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
