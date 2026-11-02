"""
The System page shows what the stack is doing (0223).

    python supabase/migrations/test_the_system_page_shows_what_the_stack_is_doing.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. refresh_directory_figures() writes each directory_figures row from a 200
Prometheus answer, with the rate by message type and the largest refusal reason beside them, and
writes NULL for every figure the answer does not carry, and for every figure after a non-200, no
answer yet, unparseable content or no Prometheus at all: never the last value. Each run fires the
next request to directory_prometheus_url(). refresh_directory_liveness() takes its address from
the same helper, survives content that is not JSON, and sets a scraped service UNKNOWN when the
probe did not report it. Every signed-in user reads the figures; no role writes them, and anon
reads nothing. The gateway count is online of enrolled, read as the caller; the device count reads
the historian and raises when it is out, which leaves the gateway count standing.

The answers are written into net._http_response by hand under the probe's request id; the
transaction rolls back, so pg_net's worker never sees the queued request. EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
import uuid
from urllib.parse import parse_qs, urlsplit

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000223a1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000223a2"
ADMIN_ID = "a0d17070-0000-4000-8000-0000000223a3"

FIGURES = {
    "messages_per_second", "readings_per_second", "messages_refused_last_hour",
    "messages_shed_last_hour", "messages_missed_last_hour", "ingestion_broker_link",
    "ingestion_historian_link",
}
AT = 1730539200.5

# Each probe's two statements, written out: (point it at a request id, read what it queued).
PROBES = {
    "directory_figures_probe": (
        "UPDATE public.directory_figures_probe SET request_id = %s WHERE id;",
        "SELECT p.request_id, q.url FROM public.directory_figures_probe p"
        " LEFT JOIN net.http_request_queue q ON q.id = p.request_id WHERE p.id;",
    ),
    "directory_liveness_probe": (
        "UPDATE public.directory_liveness_probe SET request_id = %s WHERE id;",
        "SELECT p.request_id, q.url FROM public.directory_liveness_probe p"
        " LEFT JOIN net.http_request_queue q ON q.id = p.request_id WHERE p.id;",
    ),
}


def sample(figure, value, **labels):
    return {"metric": {"figure": figure, **labels}, "value": [AT, value]}


def vector(*samples):
    return json.dumps({"status": "success", "data": {"resultType": "vector", "result": list(samples)}})


EVERY_FIGURE = vector(
    sample("messages_per_second", "12.25"),
    sample("messages_by_type", "12", msg_type="DDATA"),
    sample("messages_by_type", "0.25", msg_type="NBIRTH"),
    sample("readings_per_second", "340.5"),
    sample("messages_refused_last_hour", "7"),
    sample("messages_refused_by_reason", "5", reason="write_queue_full"),
    sample("messages_refused_by_reason", "2", reason="gateway_binding"),
    sample("messages_refused_by_reason", "0", reason="db_unavailable"),
    sample("messages_shed_last_hour", "0"),
    sample("messages_missed_last_hour", "3"),
    sample("ingestion_broker_link", "1"),
    sample("ingestion_historian_link", "0"),
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class FiguresBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.directory_figures') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0223 is not applied to this database")
        self.next_id = 9_223_000_000

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- the probe ---------------------------------------------------------------------------
    def answered(self, probe, status, content, error=None):
        """Point `probe`'s request id at a fresh id, and file `content` under it as pg_net would.
        `status=None, content=None` is a request with no answer; `error` a failed one."""
        self.next_id += 1
        self.cur.execute(PROBES[probe][0], (self.next_id,))
        if status is not None or content is not None or error is not None:
            self.cur.execute(
                "INSERT INTO net._http_response (id, status_code, content, error_msg) VALUES (%s, %s, %s, %s);",
                (self.next_id, status, content, error),
            )
        return self.next_id

    def collect(self, status=200, content=EVERY_FIGURE, error=None):
        self.answered("directory_figures_probe", status, content, error)
        self.cur.execute("SELECT public.refresh_directory_figures();")
        return self.cur.fetchone()[0]

    def figures(self):
        self.cur.execute("SELECT key, value, observed_at, detail FROM public.directory_figures;")
        return {key: (value, at, detail) for key, value, at, detail in self.cur.fetchall()}

    def values(self):
        return {key: value for key, (value, _, _) in self.figures().items()}

    def queued(self, probe):
        self.cur.execute(PROBES[probe][1])
        return self.cur.fetchone()

    # ---- people ------------------------------------------------------------------------------
    def person(self, user_id, role=None):
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (user_id, f"{user_id}@system-figures.test"),
        )
        if role:
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id)"
                " SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    def as_person(self, user_id, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id` (or as anon). A refusal rolls
        back to the savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT figures_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT figures_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT figures_call;")
        return rows


class AnAnswer(FiguresBase):
    def test_a_200_writes_every_figure_it_carries(self):
        self.assertEqual(self.collect(), len(FIGURES))
        figures = self.figures()
        self.assertEqual(set(figures), FIGURES)
        self.assertEqual(self.values(), {
            "messages_per_second": 12.25, "readings_per_second": 340.5,
            "messages_refused_last_hour": 7, "messages_shed_last_hour": 0,
            "messages_missed_last_hour": 3, "ingestion_broker_link": 1,
            "ingestion_historian_link": 0,
        })
        self.cur.execute("SELECT to_timestamp(%s);", (AT,))
        evaluated = self.cur.fetchone()[0]
        self.assertTrue(all(at == evaluated for _, at, _ in figures.values()),
                        "observed_at is not when Prometheus evaluated the value")

    def test_the_tooltips_get_the_split_by_message_type_and_the_largest_reason(self):
        self.collect()
        figures = self.figures()
        self.assertEqual(figures["messages_per_second"][2], {"by_msg_type": {"DDATA": 12, "NBIRTH": 0.25}})
        self.assertEqual(figures["messages_refused_last_hour"][2],
                         {"largest_reason": "write_queue_full", "largest": 5})
        self.assertIsNone(figures["readings_per_second"][2])

    def test_no_refusal_names_no_reason(self):
        self.collect(content=vector(
            sample("messages_refused_last_hour", "0"),
            sample("messages_refused_by_reason", "0", reason="write_queue_full"),
        ))
        value, _, detail = self.figures()["messages_refused_last_hour"]
        self.assertEqual(value, 0)
        self.assertIsNone(detail)

    def test_a_figure_the_answer_does_not_carry_is_not_observed_never_its_last_value(self):
        self.collect()
        self.collect(content=vector(sample("readings_per_second", "41")))
        values = self.values()
        self.assertEqual(values.pop("readings_per_second"), 41)
        self.assertEqual(set(values.values()), {None}, "a figure kept the value of an earlier answer")
        self.assertIsNone(self.figures()["messages_per_second"][2], "the split outlived its figure")

    def test_infinity_nan_and_a_malformed_sample_are_not_figures(self):
        self.collect(content=vector(
            sample("messages_per_second", "NaN"),
            sample("readings_per_second", "+Inf"),
            sample("messages_missed_last_hour", "not a number"),
            {"metric": {"figure": "messages_shed_last_hour"}, "value": ["yesterday", "4"]},
            "not an object",
            sample("ingestion_broker_link", "1"),
        ))
        values = self.values()
        self.assertEqual(values.pop("ingestion_broker_link"), 1)
        self.assertEqual(set(values.values()), {None})

    def test_an_answer_that_cannot_be_read_clears_every_figure_and_still_fires(self):
        """A timestamp no column can hold raises inside the write; the run still ends normally."""
        self.collect()
        self.collect(content=vector(
            {"metric": {"figure": "readings_per_second"}, "value": [1e300, "4"]},
        ))
        self.assertEqual(set(self.values().values()), {None})
        request_id, url = self.queued("directory_figures_probe")
        self.assertNotEqual(request_id, self.next_id, "the run did not fire its next request")
        self.assertIsNotNone(url)


class NoFreshAnswer(FiguresBase):
    """Every way of not having an answer reads not observed, after a run that had one."""

    def setUp(self):
        super().setUp()
        self.collect()
        self.assertEqual(len([v for v in self.values().values() if v is not None]), len(FIGURES))

    def assert_not_observed(self):
        self.assertEqual(set(self.values().values()), {None}, "a figure kept its last value")
        self.assertTrue(all(at is None and detail is None for _, at, detail in self.figures().values()))

    def test_a_non_200(self):
        self.assertEqual(self.collect(status=503, content='{"status":"error","error":"unavailable"}'), 0)
        self.assert_not_observed()

    def test_no_row_yet(self):
        self.assertEqual(self.collect(status=None, content=None), 0)
        self.assert_not_observed()

    def test_unparseable_content(self):
        self.assertEqual(self.collect(content="<html>bad gateway</html>"), 0)
        self.assert_not_observed()

    def test_a_200_that_is_not_a_successful_vector(self):
        for content in ('{"status":"error"}', json.dumps({"status": "success", "data": {"result": {}}})):
            with self.subTest(content=content):
                self.collect()
                self.assertEqual(self.collect(content=content), 0)
                self.assert_not_observed()

    def test_no_prometheus_to_ask(self):
        """observability.enabled off: there is no prometheus Service, so the name does not resolve."""
        self.assertEqual(self.collect(status=None, content=None, error="Couldn't resolve host name"), 0)
        self.assert_not_observed()

    def test_no_request_ever_fired(self):
        self.cur.execute("UPDATE public.directory_figures_probe SET request_id = NULL WHERE id;")
        self.cur.execute("SELECT public.refresh_directory_figures();")
        self.assertEqual(self.cur.fetchone()[0], 0)
        self.assert_not_observed()


class TheNextRequest(FiguresBase):
    def test_every_run_fires_one_query_to_the_helper_s_address(self):
        self.cur.execute("SELECT public.directory_prometheus_url();")
        self.assertEqual(self.cur.fetchone()[0], "http://prometheus:9090")
        for status, content in ((200, EVERY_FIGURE), (503, "{}"), (None, None)):
            with self.subTest(status=status):
                before = self.answered("directory_figures_probe", status, content)
                self.cur.execute("SELECT public.refresh_directory_figures();")
                request_id, url = self.queued("directory_figures_probe")
                self.assertNotEqual(request_id, before)
                self.assertTrue(url.startswith("http://prometheus:9090/api/v1/query?query=label_replace"), url)
                self.cur.execute("SELECT requested_at > now() - interval '1 minute' FROM public.directory_figures_probe;")
                self.assertTrue(self.cur.fetchone()[0])

    def test_the_query_names_every_figure(self):
        self.cur.execute("SELECT public.refresh_directory_figures();")
        _, url = self.queued("directory_figures_probe")
        query = parse_qs(urlsplit(url).query)["query"][0]
        for key in FIGURES:
            self.assertIn(f'"figure", "{key}"', query)

    def test_it_is_scheduled_every_minute_once(self):
        self.cur.execute("SELECT schedule, command FROM cron.job WHERE jobname = 'refresh-directory-figures';")
        self.assertEqual(self.cur.fetchall(), [("* * * * *", "SELECT public.refresh_directory_figures()")])


class Liveness(FiguresBase):
    """refresh_directory_liveness() as 0223 redeclares it."""

    SCRAPED = ("Prometheus Metrics Store", "Grafana Dashboards")

    def setUp(self):
        super().setUp()
        self.cur.execute(
            "UPDATE public.directory_services SET status = 'ACTIVE', last_heartbeat = now() - interval '3 hours'"
            " WHERE service_name IN %s;", (self.SCRAPED,),
        )

    def liveness(self, status, content):
        self.answered("directory_liveness_probe", status, content)
        self.cur.execute("SELECT public.refresh_directory_liveness();")
        observed = self.cur.fetchone()[0]
        self.cur.execute(
            "SELECT service_name, status, last_heartbeat IS NOT NULL FROM public.directory_services"
            " WHERE service_name IN %s ORDER BY service_name;", (self.SCRAPED,),
        )
        return observed, self.cur.fetchall()

    def test_it_asks_the_helper_s_address(self):
        self.liveness(None, None)
        _, url = self.queued("directory_liveness_probe")
        self.assertEqual(url, "http://prometheus:9090/api/v1/query?query=up")

    def test_content_that_is_not_json_is_no_answer_and_the_next_probe_fires(self):
        before = self.next_id + 1
        observed, rows = self.liveness(502, "<html>bad gateway</html>")
        self.assertEqual(observed, 0)
        self.assertEqual(rows, [(name, "UNKNOWN", False) for name in sorted(self.SCRAPED)])
        request_id, _ = self.queued("directory_liveness_probe")
        self.assertNotEqual(request_id, before)

    def test_a_failed_probe_leaves_no_scraped_service_at_its_last_active(self):
        for status, content in ((503, '{"status":"error"}'), (None, None)):
            with self.subTest(status=status):
                self.cur.execute("UPDATE public.directory_services SET status = 'ACTIVE', last_heartbeat = now()"
                                 " WHERE service_name IN %s;", (self.SCRAPED,))
                _, rows = self.liveness(status, content)
                self.assertEqual(rows, [(name, "UNKNOWN", False) for name in sorted(self.SCRAPED)])

    def test_an_answer_writes_what_it_reports_and_unknown_for_what_it_does_not(self):
        observed, rows = self.liveness(200, json.dumps({"status": "success", "data": {"resultType": "vector", "result": [
            {"metric": {"job": "prometheus"}, "value": [AT, "1"]},
        ]}}))
        self.assertEqual(observed, 1)
        self.assertEqual(rows, [("Grafana Dashboards", "UNKNOWN", False), ("Prometheus Metrics Store", "ACTIVE", True)])

        observed, rows = self.liveness(200, json.dumps({"status": "success", "data": {"resultType": "vector", "result": [
            {"metric": {"job": "prometheus"}, "value": [AT, "1"]},
            {"metric": {"job": "grafana"}, "value": [AT, "0"]},
        ]}}))
        self.assertEqual(observed, 2)
        self.assertEqual(rows, [("Grafana Dashboards", "DOWN", False), ("Prometheus Metrics Store", "ACTIVE", True)])


class WhoReadsAndWrites(FiguresBase):
    def setUp(self):
        super().setUp()
        self.person(OPERATOR_ID, "Operator")
        self.person(NO_ROLE_ID)
        self.person(ADMIN_ID, "Administrator")
        self.collect()

    def test_any_signed_in_user_reads_every_figure(self):
        for user_id in (OPERATOR_ID, NO_ROLE_ID, ADMIN_ID):
            with self.subTest(user=user_id):
                rows = self.as_person(user_id, "SELECT key, value FROM public.directory_figures;")
                self.assertEqual({key for key, _ in rows}, FIGURES)
                self.assertEqual(dict(rows)["readings_per_second"], 340.5)

    def test_no_role_writes_them(self):
        writes = (
            "UPDATE public.directory_figures SET value = 1;",
            "INSERT INTO public.directory_figures (key) VALUES ('forged');",
            "DELETE FROM public.directory_figures;",
        )
        for role, user_id in (("authenticated", ADMIN_ID), ("service_role", ADMIN_ID), ("anon", NO_ROLE_ID)):
            for sql in writes:
                with self.subTest(role=role, sql=sql):
                    with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                        self.as_person(user_id, sql, role=role)
        self.assertEqual(self.values()["readings_per_second"], 340.5)

    def test_anon_reads_nothing(self):
        for sql in ("SELECT * FROM public.directory_figures;",
                    "SELECT * FROM public.directory_figures_probe;",
                    "SELECT * FROM public.directory_gateway_counts();",
                    "SELECT public.directory_devices_reporting();"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.as_person(NO_ROLE_ID, sql, role="anon")

    def test_no_signed_in_user_reads_the_probe_or_runs_a_collector(self):
        for sql in ("SELECT * FROM public.directory_figures_probe;",
                    "SELECT public.refresh_directory_figures();",
                    "SELECT public.refresh_directory_liveness();",
                    "SELECT public.directory_prometheus_url();"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.as_person(ADMIN_ID, sql)


class TheLiveReads(FiguresBase):
    def setUp(self):
        super().setUp()
        self.person(OPERATOR_ID, "Operator")

    def gateway(self, status, heartbeat_age="0 seconds", archived=False):
        """A gateway of this suite's own; `heartbeat_age=None` is one that has never reported."""
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, status, last_heartbeat, is_archived, deployment)"
            " VALUES (%s, %s, %s, now() - %s::interval, %s, 'host');",
            (gid, f"System_Figures_{gid[:8]}", status, heartbeat_age, archived),
        )

    def counts(self):
        return self.as_person(OPERATOR_ID, "SELECT online, enrolled FROM public.directory_gateway_counts();")[0]

    def test_gateways_online_of_those_enrolled(self):
        online, enrolled = self.counts()
        self.gateway("ONLINE")                                            # online
        self.gateway("ONLINE", heartbeat_age="5 minutes")      # stale: enrolled, not online
        self.gateway("OFFLINE")                                # enrolled, not online
        self.gateway("AWAITING_BIRTH", heartbeat_age=None)     # enrolled, no data yet
        self.gateway("PENDING_ENROLLMENT", heartbeat_age=None)  # a bundle not redeemed
        self.gateway("ONLINE", archived=True)                  # archived
        self.assertEqual(self.counts(), (online + 1, enrolled + 4))

    def test_the_playback_gateway_is_not_counted(self):
        self.cur.execute("SELECT count(*) FROM public.gateways WHERE is_shadow AND is_archived IS NOT TRUE;")
        self.assertGreaterEqual(self.cur.fetchone()[0], 1, "the seed's Playback gateway is missing")
        _, enrolled = self.counts()
        self.cur.execute("UPDATE public.gateways SET status = 'ONLINE', last_heartbeat = now() WHERE is_shadow;")
        self.assertEqual(self.counts()[1], enrolled)

    def test_the_counts_name_no_gateway(self):
        self.cur.execute("SELECT pg_get_function_result('public.directory_gateway_counts()'::regprocedure);")
        self.assertEqual(self.cur.fetchone()[0], "TABLE(online integer, enrolled integer)")

    def test_a_historian_outage_leaves_the_gateway_count_standing(self):
        """The db lane has no historian, so the foreign telemetry_latest raises on connect."""
        self.gateway("ONLINE")
        with self.assertRaises(psycopg2.OperationalError):
            self.as_person(OPERATOR_ID, "SELECT public.directory_devices_reporting();")
        online, enrolled = self.counts()
        self.assertGreaterEqual(online, 1)
        self.assertGreaterEqual(enrolled, online)
        rows = self.as_person(OPERATOR_ID, "SELECT count(*) FROM public.directory_figures;")
        self.assertEqual(rows[0][0], len(FIGURES))

    def test_devices_reporting_counts_assets_with_a_reading_in_the_last_five_minutes(self):
        # A local table stands in for the foreign one, inside the rolled-back transaction.
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry_latest CASCADE;"
            "CREATE TABLE timescale.telemetry_latest ("
            ' "time" timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,'
            " val_double double precision, val_string text, val_bool boolean);"
            "CREATE VIEW public.telemetry_latest WITH (security_invoker = true) AS"
            ' SELECT "time", asset_id, metric_name, val_double, val_string, val_bool FROM timescale.telemetry_latest;'
            "GRANT SELECT ON timescale.telemetry_latest, public.telemetry_latest TO authenticated;"
            "INSERT INTO timescale.telemetry_latest (time, asset_id, metric_name, val_double) VALUES"
            " (now() - interval '10 seconds', 'dev-a', 'temp', 1),"
            " (now() - interval '20 seconds', 'dev-a', 'speed', 2),"
            " (now() - interval '4 minutes', 'dev-b', 'temp', 3),"
            " (now() - interval '2 hours', 'dev-b', 'speed', 4),"
            " (now() - interval '6 minutes', 'dev-c', 'temp', 5);"
        )
        rows = self.as_person(OPERATOR_ID, "SELECT public.directory_devices_reporting();")
        self.assertEqual(rows[0][0], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
