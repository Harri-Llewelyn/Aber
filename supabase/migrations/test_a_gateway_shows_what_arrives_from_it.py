# suite:
#   lanes: db
#   why: 0303's figures for what arrives from a gateway, against answers filed in
#     net._http_response by hand: a 200 writes each gateway's messages per second, sequence gaps and
#     messages missed, 0 for a gateway with no series while ingestion was scraped and NULL for a
#     sample that is no figure; a non-200, no answer yet, unparseable content, no Prometheus or an
#     answer that did not observe ingestion clears every row rather than leaving the last value, and
#     a row older than 3 minutes reads NULL in the view the dashboard reads. Whoever can read a
#     gateway reads its row, by the gateways table's own policy; no role writes it. Each device's
#     last reading is read live as the caller. A replay keeps one cron job.

"""
A gateway shows what arrives from it (0303).

    python supabase/migrations/test_a_gateway_shows_what_arrives_from_it.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here. refresh_gateway_arrivals() writes a row for every gateway from a 200 Prometheus
answer: the rate of its edge node's messages, its sequence gaps and messages missed in the last
hour. A gateway the answer names no series for reads 0, because ingestion was scraped, and a sample
that is not a figure (NaN, Infinity, a time that is not one) reads NULL, never a 0 nobody observed.
Every way of not having a usable answer, or an answer that did not observe ingestion, reads NULL
after a run that had one. The view the dashboard reads blanks a row evaluated more than 3 minutes
ago. The next request goes to directory_prometheus_url() and the job is scheduled once, also after
the migration is applied again. Anyone who can read a gateway reads its row (the policy asks
gateways, so a restriction there hides the row too), anon reads nothing and no role writes. The
device list's last readings come from the historian as the caller: a device with no reading has
none, an archived device is not listed, and an outage raises while the figures stand.

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

MIGRATION = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "0303_a_gateway_shows_what_arrives_from_it.sql")

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000303a1"
NO_ROLE_ID = "a0d17070-0000-4000-8000-0000000303a2"
ADMIN_ID = "a0d17070-0000-4000-8000-0000000303a3"

AT = 1730539200.5
FIGURES = ("messages_per_second", "sequence_gaps_last_hour", "messages_missed_last_hour")


def sample(figure, value, edge_node=None, at=AT):
    metric = {"figure": figure}
    if edge_node is not None:
        metric["edge_node"] = edge_node
    return {"metric": metric, "value": [at, value]}


def vector(*samples):
    return json.dumps({"status": "success", "data": {"resultType": "vector", "result": list(samples)}})


SCRAPED = sample("ingestion_scraped", "1")


class ArrivalsBase(unittest.TestCase):
    def setUp(self):
        self.conn = psycopg2.connect(
            host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
        self.conn.autocommit = False
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.gateway_arrival_figures') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0303 is not applied to this database")
        self.next_id = 9_303_000_000

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- gateways and devices ----------------------------------------------------------------
    def gateway(self, name=None):
        """A gateway of this suite's own, as (id, sparkplug_id)."""
        gateway_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, deployment) VALUES (%s, %s, 'host') RETURNING sparkplug_id;",
            (gateway_id, name or f"Arrival_{gateway_id[:8]}"))
        return gateway_id, self.cur.fetchone()[0]

    def device(self, gateway_id, archived=False):
        """A device on `gateway_id`, as (id, sparkplug_id)."""
        device_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, is_archived) VALUES (%s, %s, %s, %s)"
            " RETURNING sparkplug_id;", (device_id, f"Arrival_{device_id[:8]}", gateway_id, archived))
        return device_id, self.cur.fetchone()[0]

    # ---- the probe ---------------------------------------------------------------------------
    def answered(self, status, content, error=None):
        """Point the probe at a fresh request id, and file `content` under it as pg_net would.
        `status=None, content=None` is a request with no answer; `error` a failed one."""
        self.next_id += 1
        self.cur.execute("UPDATE public.gateway_arrival_probe SET request_id = %s WHERE id;", (self.next_id,))
        if status is not None or content is not None or error is not None:
            self.cur.execute(
                "INSERT INTO net._http_response (id, status_code, content, error_msg) VALUES (%s, %s, %s, %s);",
                (self.next_id, status, content, error))
        return self.next_id

    def collect(self, content=None, status=200, error=None):
        self.answered(status, content, error)
        self.cur.execute("SELECT public.refresh_gateway_arrivals();")
        return self.cur.fetchone()[0]

    def row(self, gateway_id):
        self.cur.execute(
            "SELECT messages_per_second, sequence_gaps_last_hour, messages_missed_last_hour, observed_at"
            " FROM public.gateway_arrival_figures WHERE gateway_id = %s;", (gateway_id,))
        return self.cur.fetchone()

    def figures(self, gateway_id):
        return self.row(gateway_id)[:3]

    def queued(self):
        self.cur.execute(
            "SELECT p.request_id, q.url FROM public.gateway_arrival_probe p"
            " LEFT JOIN net.http_request_queue q ON q.id = p.request_id WHERE p.id;")
        return self.cur.fetchone()

    # ---- people ------------------------------------------------------------------------------
    def person(self, user_id, role=None):
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
            (user_id, f"{user_id}@gateway-arrivals.test"))
        if role:
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id)"
                " SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;", (user_id, role))

    def as_person(self, user_id, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id` (or as anon). A refusal rolls
        back to the savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT arrivals_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT arrivals_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT arrivals_call;")
        return rows


class AnAnswer(ArrivalsBase):
    def test_a_200_writes_each_gateway_s_three_figures(self):
        a, edge_a = self.gateway()
        b, edge_b = self.gateway()
        c, _ = self.gateway()
        self.cur.execute("SELECT count(*) FROM public.gateways;")
        every_gateway = self.cur.fetchone()[0]
        observed = self.collect(vector(
            SCRAPED,
            sample("messages_per_second", "12.25", edge_a),
            sample("messages_per_second", "0.5", edge_b),
            sample("sequence_gaps_last_hour", "2", edge_a),
            sample("messages_missed_last_hour", "5", edge_a),
        ))
        self.assertEqual(self.figures(a), (12.25, 2, 5))
        self.assertEqual(self.figures(b), (0.5, 0, 0))
        self.assertEqual(self.figures(c), (0.0, 0, 0), "a gateway with no series reads 0 while ingestion is scraped")
        self.assertEqual(observed, every_gateway)
        self.cur.execute("SELECT to_timestamp(%s);", (AT,))
        evaluated = self.cur.fetchone()[0]
        for gateway_id in (a, b, c):
            self.assertEqual(self.row(gateway_id)[3], evaluated, "observed_at is not when Prometheus evaluated it")

    def test_a_count_is_rounded_to_the_whole_number_increase_extrapolated_to(self):
        a, edge_a = self.gateway()
        self.collect(vector(
            SCRAPED,
            sample("sequence_gaps_last_hour", "6.98", edge_a),
            sample("messages_missed_last_hour", "0.4", edge_a),
        ))
        self.assertEqual(self.figures(a), (0.0, 7, 0))

    def test_an_edge_node_that_is_no_gateway_and_a_sample_with_none_are_left_out(self):
        a, edge_a = self.gateway()
        self.collect(vector(
            SCRAPED,
            sample("messages_per_second", "3", edge_a),
            sample("messages_per_second", "99", "gwy-nobody-has"),
            sample("messages_per_second", "98"),
        ))
        self.assertEqual(self.figures(a)[0], 3)
        self.cur.execute(
            "SELECT (SELECT count(*) FROM public.gateway_arrival_figures), (SELECT count(*) FROM public.gateways);")
        rows, gateways = self.cur.fetchone()
        self.assertEqual(rows, gateways, "a row was written for something that is no gateway")

    def test_a_sample_that_is_no_figure_reads_not_observed_for_that_figure_alone(self):
        a, edge_a = self.gateway()
        b, edge_b = self.gateway()
        c, edge_c = self.gateway()
        self.collect(vector(
            SCRAPED,
            sample("messages_per_second", "NaN", edge_a),
            sample("sequence_gaps_last_hour", "4", edge_a),
            sample("messages_per_second", "+Inf", edge_b),
            {"metric": {"figure": "sequence_gaps_last_hour", "edge_node": edge_c}, "value": ["yesterday", "4"]},
            "not an object",
        ))
        self.assertEqual(self.figures(a), (None, 4, 0))
        self.assertEqual(self.figures(b), (None, 0, 0))
        self.assertEqual(self.figures(c), (0.0, None, 0))

    def test_an_answer_that_did_not_observe_ingestion_observes_no_gateway(self):
        """Prometheus still answers a rate for minutes after a target goes away."""
        a, edge_a = self.gateway()
        self.assertEqual(self.collect(vector(sample("messages_per_second", "12", edge_a))), 0)
        self.assertEqual(self.row(a), (None, None, None, None))
        self.assertEqual(self.collect(vector(sample("ingestion_scraped", "NaN"),
                                             sample("messages_per_second", "12", edge_a))), 0)
        self.assertEqual(self.row(a), (None, None, None, None))

    def test_an_answer_that_cannot_be_read_clears_every_row_and_still_fires(self):
        """A timestamp no column can hold raises inside the write; the run still ends normally."""
        a, edge_a = self.gateway()
        self.collect(vector(SCRAPED, sample("messages_per_second", "5", edge_a)))
        self.assertEqual(self.figures(a)[0], 5)
        before = self.collect(vector(sample("ingestion_scraped", "1", at=1e300)))
        self.assertEqual(before, 0)
        self.assertEqual(self.row(a), (None, None, None, None))
        request_id, url = self.queued()
        self.assertNotEqual(request_id, self.next_id, "the run did not fire its next request")
        self.assertIsNotNone(url)

    def test_a_gateway_added_since_the_last_run_gets_its_row(self):
        self.collect(vector(SCRAPED))
        later, edge_later = self.gateway()
        self.assertIsNone(self.row(later))
        self.collect(vector(SCRAPED, sample("messages_per_second", "1.5", edge_later)))
        self.assertEqual(self.figures(later), (1.5, 0, 0))

    def test_deleting_a_gateway_deletes_its_row(self):
        a, _ = self.gateway()
        self.collect(vector(SCRAPED))
        self.assertIsNotNone(self.row(a))
        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (a,))
        self.assertIsNone(self.row(a))


class NoFreshAnswer(ArrivalsBase):
    """Every way of not having an answer reads not observed, after a run that had one."""

    def setUp(self):
        super().setUp()
        self.gw, edge = self.gateway()
        self.assertGreaterEqual(self.collect(vector(
            SCRAPED, sample("messages_per_second", "12.25", edge),
            sample("sequence_gaps_last_hour", "3", edge))), 1)
        self.assertEqual(self.figures(self.gw), (12.25, 3, 0))

    def assert_not_observed(self):
        self.cur.execute("SELECT count(*) FROM public.gateway_arrival_figures"
                         " WHERE messages_per_second IS NOT NULL OR sequence_gaps_last_hour IS NOT NULL"
                         " OR messages_missed_last_hour IS NOT NULL OR observed_at IS NOT NULL;")
        self.assertEqual(self.cur.fetchone()[0], 0, "a row kept the value of an earlier answer")

    def test_a_non_200(self):
        self.assertEqual(self.collect('{"status":"error","error":"unavailable"}', status=503), 0)
        self.assert_not_observed()

    def test_no_row_yet(self):
        self.assertEqual(self.collect(None, status=None), 0)
        self.assert_not_observed()

    def test_unparseable_content(self):
        self.assertEqual(self.collect("<html>bad gateway</html>"), 0)
        self.assert_not_observed()

    def test_a_200_that_is_not_a_successful_vector(self):
        for content in ('{"status":"error"}', json.dumps({"status": "success", "data": {"result": {}}})):
            with self.subTest(content=content):
                self.collect(vector(SCRAPED, sample("messages_per_second", "1", "x")))
                self.assertEqual(self.collect(content), 0)
                self.assert_not_observed()

    def test_no_prometheus_to_ask(self):
        """observability.enabled off: there is no prometheus Service, so the name does not resolve."""
        self.assertEqual(self.collect(None, status=None, error="Couldn't resolve host name"), 0)
        self.assert_not_observed()

    def test_no_request_ever_fired(self):
        self.cur.execute("UPDATE public.gateway_arrival_probe SET request_id = NULL WHERE id;")
        self.cur.execute("SELECT public.refresh_gateway_arrivals();")
        self.assertEqual(self.cur.fetchone()[0], 0)
        self.assert_not_observed()


class TheNextRequest(ArrivalsBase):
    def test_every_run_fires_one_query_to_the_helper_s_address(self):
        for status, content in ((200, vector(SCRAPED)), (503, "{}"), (None, None)):
            with self.subTest(status=status):
                before = self.answered(status, content)
                self.cur.execute("SELECT public.refresh_gateway_arrivals();")
                request_id, url = self.queued()
                self.assertNotEqual(request_id, before)
                self.assertTrue(url.startswith("http://prometheus:9090/api/v1/query?query="), url)
                self.cur.execute("SELECT requested_at > now() - interval '1 minute' FROM public.gateway_arrival_probe;")
                self.assertTrue(self.cur.fetchone()[0])

    def test_the_query_has_one_vector_for_each_figure_summed_by_edge_node(self):
        self.cur.execute("SELECT public.refresh_gateway_arrivals();")
        _, url = self.queued()
        query = parse_qs(urlsplit(url).query)["query"][0]
        for key in FIGURES + ("ingestion_scraped",):
            self.assertIn(f'"figure", "{key}"', query)
        self.assertEqual(query.count("label_replace("), len(FIGURES) + 1)
        self.assertEqual(query.count("sum by (edge_node) ("), len(FIGURES))
        for series in ("aber_ingestion_messages_total", "aber_ingestion_sequence_gaps_total",
                       "aber_ingestion_sequence_messages_missed_total", "aber_ingestion_up"):
            self.assertIn(series, query)

    def test_the_address_is_the_one_the_liveness_probe_reads(self):
        self.cur.execute("SELECT public.directory_prometheus_url();")
        self.assertEqual(self.cur.fetchone()[0], "http://prometheus:9090")

    def test_it_is_scheduled_every_minute_once(self):
        self.cur.execute("SELECT schedule, command FROM cron.job WHERE jobname = 'refresh-gateway-arrivals';")
        self.assertEqual(self.cur.fetchall(), [("* * * * *", "SELECT public.refresh_gateway_arrivals()")])

    def test_a_replay_keeps_one_job_one_probe_and_the_request_in_flight(self):
        self.answered(200, vector(SCRAPED))
        a, edge_a = self.gateway()
        self.cur.execute("SELECT public.refresh_gateway_arrivals();")
        in_flight = self.queued()[0]
        with open(MIGRATION, encoding="utf-8") as migration:
            self.cur.execute(migration.read())
        self.cur.execute("SELECT count(*) FROM cron.job WHERE jobname = 'refresh-gateway-arrivals';")
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.cur.execute("SELECT count(*) FROM public.gateway_arrival_probe;")
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.assertEqual(self.queued()[0], in_flight, "the replay reset the request in flight")
        self.cur.execute("SELECT count(*) FROM pg_policy WHERE polrelid = 'public.gateway_arrival_figures'::regclass;")
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.assertIsNotNone(self.row(a))


class Freshness(ArrivalsBase):
    """The view the dashboard reads: a figure is observed for 3 minutes, never as its last value."""

    def setUp(self):
        super().setUp()
        self.gw, edge = self.gateway()
        self.collect(vector(SCRAPED, sample("messages_per_second", "12.25", edge),
                            sample("sequence_gaps_last_hour", "3", edge),
                            sample("messages_missed_last_hour", "9", edge)))

    def seen(self):
        self.cur.execute(
            "SELECT messages_per_second, sequence_gaps_last_hour, messages_missed_last_hour, observed_at IS NOT NULL"
            " FROM public.gateway_arrivals WHERE gateway_id = %s;", (self.gw,))
        return self.cur.fetchone()

    def age(self, interval):
        self.cur.execute("UPDATE public.gateway_arrival_figures SET observed_at = now() - %s::interval"
                         " WHERE gateway_id = %s;", (interval, self.gw))

    def test_an_answer_evaluated_this_minute_or_the_last_two_reads(self):
        for age in ("1 second", "90 seconds", "2 minutes 50 seconds"):
            with self.subTest(age=age):
                self.age(age)
                self.assertEqual(self.seen(), (12.25, 3, 9, True))

    def test_an_answer_older_than_three_minutes_reads_not_observed_in_every_column(self):
        for age in ("3 minutes 10 seconds", "4 minutes", "2 days"):
            with self.subTest(age=age):
                self.age(age)
                self.assertEqual(self.seen(), (None, None, None, False))

    def test_a_row_that_was_never_observed_reads_not_observed(self):
        self.cur.execute("UPDATE public.gateway_arrival_figures SET observed_at = NULL WHERE gateway_id = %s;", (self.gw,))
        self.assertEqual(self.seen(), (None, None, None, False))

    def test_the_view_has_a_row_for_a_gateway_with_nothing_observed(self):
        self.age("1 hour")
        self.cur.execute("SELECT count(*) FROM public.gateway_arrivals WHERE gateway_id = %s;", (self.gw,))
        self.assertEqual(self.cur.fetchone()[0], 1)


class WhoReadsAndWrites(ArrivalsBase):
    def setUp(self):
        super().setUp()
        self.person(OPERATOR_ID, "Operator")
        self.person(NO_ROLE_ID)
        self.person(ADMIN_ID, "Administrator")
        self.gw, edge = self.gateway()
        self.collect(vector(SCRAPED, sample("messages_per_second", "7", edge)))
        self.cur.execute("UPDATE public.gateway_arrival_figures SET observed_at = now();")

    def test_any_signed_in_user_reads_the_gateway_s_row(self):
        for user_id in (OPERATOR_ID, NO_ROLE_ID, ADMIN_ID):
            for relation in ("gateway_arrival_figures", "gateway_arrivals"):
                with self.subTest(user=user_id, relation=relation):
                    rows = self.as_person(
                        user_id, f"SELECT messages_per_second FROM public.{relation} WHERE gateway_id = %s;", (self.gw,))
                    self.assertEqual(rows, [(7.0,)])

    def test_the_row_follows_the_gateways_table_s_own_policy(self):
        """A restriction on who reads a gateway hides its figures: the policy asks gateways."""
        hidden, edge_hidden = self.gateway("Arrival_Hidden")
        self.collect(vector(SCRAPED, sample("messages_per_second", "2", edge_hidden)))
        self.cur.execute("UPDATE public.gateway_arrival_figures SET observed_at = now();")
        self.cur.execute(
            "CREATE POLICY arrival_hides_one ON public.gateways AS RESTRICTIVE FOR SELECT TO authenticated"
            " USING (name <> 'Arrival_Hidden');")
        for relation in ("gateway_arrival_figures", "gateway_arrivals"):
            with self.subTest(relation=relation):
                shown = {str(r[0]) for r in self.as_person(OPERATOR_ID, f"SELECT gateway_id FROM public.{relation};")}
                self.assertIn(self.gw, shown)
                self.assertNotIn(hidden, shown)
        self.cur.execute("SELECT count(*) FROM public.gateway_arrival_figures WHERE gateway_id = %s;", (hidden,))
        self.assertEqual(self.cur.fetchone()[0], 1, "the owner still holds the row; only the readers' view changed")

    def test_no_role_writes_the_figures(self):
        writes = (
            "UPDATE public.gateway_arrival_figures SET messages_per_second = 1;",
            "INSERT INTO public.gateway_arrival_figures (gateway_id) VALUES (gen_random_uuid());",
            "DELETE FROM public.gateway_arrival_figures;",
            "UPDATE public.gateway_arrivals SET gateway_id = gateway_id;",
            "DELETE FROM public.gateway_arrivals;",
        )
        for role, user_id in (("authenticated", ADMIN_ID), ("service_role", ADMIN_ID), ("anon", NO_ROLE_ID)):
            for sql in writes:
                with self.subTest(role=role, sql=sql):
                    with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                        self.as_person(user_id, sql, role=role)
        self.assertEqual(self.figures(self.gw)[0], 7.0)

    def test_anon_reads_nothing(self):
        for sql in ("SELECT * FROM public.gateway_arrival_figures;",
                    "SELECT * FROM public.gateway_arrivals;",
                    "SELECT * FROM public.gateway_arrival_probe;",
                    "SELECT * FROM public.gateway_devices_last_reading(gen_random_uuid());"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.as_person(NO_ROLE_ID, sql, role="anon")

    def test_no_signed_in_user_reads_the_probe_or_runs_the_collector(self):
        for sql in ("SELECT * FROM public.gateway_arrival_probe;", "SELECT public.refresh_gateway_arrivals();"):
            with self.subTest(sql=sql):
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.as_person(ADMIN_ID, sql)


class EachDevicesLastReading(ArrivalsBase):
    def setUp(self):
        super().setUp()
        self.person(OPERATOR_ID, "Operator")

    def last_readings(self, gateway_id):
        return self.as_person(
            OPERATOR_ID, "SELECT device_id, last_reading_at FROM public.gateway_devices_last_reading(%s);",
            (gateway_id,))

    def stand_in_for_the_historian(self, *readings):
        """A local table for the foreign one, inside the rolled-back transaction: (asset, age, metric)."""
        self.cur.execute(
            "DROP FOREIGN TABLE timescale.telemetry_latest CASCADE;"
            "CREATE TABLE timescale.telemetry_latest ("
            ' "time" timestamptz NOT NULL, asset_id text NOT NULL, metric_name text NOT NULL,'
            " val_double double precision, val_string text, val_bool boolean);"
            "CREATE VIEW public.telemetry_latest WITH (security_invoker = true) AS"
            ' SELECT "time", asset_id, metric_name, val_double, val_string, val_bool FROM timescale.telemetry_latest;'
            "GRANT SELECT ON timescale.telemetry_latest, public.telemetry_latest TO authenticated;")
        for asset, age, metric in readings:
            self.cur.execute(
                "INSERT INTO timescale.telemetry_latest (time, asset_id, metric_name, val_double)"
                " VALUES (now() - %s::interval, %s, %s, 1);", (age, asset, metric))

    def test_each_device_has_the_time_of_its_newest_reading_and_one_with_none_has_none(self):
        gw, _ = self.gateway()
        other, _ = self.gateway()
        reporting, reporting_id = self.device(gw)
        quiet, _ = self.device(gw)
        archived, archived_id = self.device(gw, archived=True)
        elsewhere, elsewhere_id = self.device(other)
        self.stand_in_for_the_historian(
            (reporting_id, "20 seconds", "speed"), (reporting_id, "10 seconds", "temp"),
            (reporting_id, "2 hours", "load"), (archived_id, "5 seconds", "temp"),
            (elsewhere_id, "1 second", "temp"))
        rows = dict(self.last_readings(gw))
        self.assertEqual(set(rows), {reporting, quiet}, "a device that is archived or elsewhere was listed")
        self.assertIsNone(rows[quiet])
        self.cur.execute("SELECT %s > now() - interval '15 seconds';", (rows[reporting],))
        self.assertTrue(self.cur.fetchone()[0], "the newest of the device's series was not the one it chose")

    def test_a_gateway_with_no_device_does_not_touch_the_historian(self):
        """The db lane has no historian, so a read of it raises; this call makes none."""
        gw, _ = self.gateway()
        self.assertEqual(self.last_readings(gw), [])
        self.device(gw, archived=True)
        self.assertEqual(self.last_readings(gw), [])

    def test_a_historian_outage_raises_and_the_figures_stand(self):
        gw, edge = self.gateway()
        self.device(gw)
        self.collect(vector(SCRAPED, sample("messages_per_second", "4", edge)))
        self.cur.execute("UPDATE public.gateway_arrival_figures SET observed_at = now();")
        with self.assertRaises(psycopg2.OperationalError):
            self.last_readings(gw)
        rows = self.as_person(OPERATOR_ID, "SELECT messages_per_second FROM public.gateway_arrivals WHERE gateway_id = %s;", (gw,))
        self.assertEqual(rows, [(4.0,)])

    def test_it_reads_as_the_caller(self):
        self.cur.execute("SELECT prosecdef FROM pg_proc WHERE oid = 'public.gateway_devices_last_reading(uuid)'::regprocedure;")
        self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
