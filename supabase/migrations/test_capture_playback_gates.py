"""
The capture and playback helpers answer only a caller who could read the job (0184).

    python supabase/migrations/test_capture_playback_gates.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

`is_active_capture_object()`, `is_active_playback_capture()` and `playback_stale_credentials()` are
SECURITY DEFINER and executable by `authenticated`: the broker-captures storage policies call the
first two as the caller, and the Start Playback dialog calls the third. Each answers only a caller
who could read the job rows: its machine principal, a role the tables' RLS admits (Administrator,
Shopfloor_Manager, Auditor), or a role RLS does not apply to (service_role, the owner). Anyone else,
an Operator above all, gets false and no rows.

The storage policies are evaluated from storage-policies.sql's own text, on a stand-in for
storage.objects this suite creates: the db lane has no storage-api, so the table does not exist
here. Every caller reaches what the file's header says it may, which is also what it reached before
0184, since each predicate call there is ANDed with its caller check.

Every test rolls back.
"""
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STORAGE_POLICIES = os.path.join(REPO, "supabase", "storage-policies.sql")

# People of this suite's own, one per role; the machine principals are the seeded ones, because
# is_ingestion_caller() and is_playback_caller() name them by id.
PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-00000000c926",
    "Shopfloor_Manager": "00000000-0000-4000-8000-00000000c927",
    "Auditor": "00000000-0000-4000-8000-00000000c928",
    "Operator": "00000000-0000-4000-8000-00000000c929",
}
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"

READERS = ("Administrator", "Shopfloor_Manager", "Auditor")
CALLERS = READERS + ("Operator", "ingestion", "playback")

# Not the bucket's schema: a stand-in for storage.objects that dies with the transaction.
STAND_IN = "capture_gate_probe"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class GatesBase(unittest.TestCase):
    """One transaction per test: the fixture, then each call as a caller, then a rollback."""

    def setUp(self):
        self.conn = get_connection()
        # A cleanup, not tearDown: it also runs when the fixture below fails, and an open
        # transaction would hold its rows locked against the next test's identical fixture.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"gates-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

        recorded_gw, recorded_wire = self._gateway(shadow=False)
        self.recording = f"{recorded_wire}/capture.json"
        self.cur.execute(
            "INSERT INTO public.capture_jobs (subject_kind, gateway_id, sparkplug_group, "
            "edge_node_id, subject_sparkplug_id, storage_path, status, started_at) "
            "VALUES ('gateway', %s, 'Aber', %s, %s, %s, 'RECORDING', now());",
            (recorded_gw, recorded_wire, recorded_wire, self.recording),
        )

        replayed_gw, replayed_wire = self._gateway(shadow=False)
        self.replaying = f"{replayed_wire}/capture.json"
        self.cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, subject_sparkplug_id, "
            "storage_path, size_bytes, message_count) "
            "VALUES ('gateway', %s, %s, %s, 1, 1) RETURNING id;",
            (replayed_gw, replayed_wire, self.replaying),
        )
        self.capture_id = self.cur.fetchone()[0]
        running_target, running_wire = self._gateway(shadow=True)
        self.cur.execute(
            "INSERT INTO public.playback_jobs (capture_id, capture_storage_path, "
            "target_gateway_id, target_edge_node_id, sparkplug_group, status, started_at) "
            "VALUES (%s, %s, %s, %s, 'Aber', 'RUNNING', now());",
            (self.capture_id, self.replaying, running_target, running_wire),
        )

        # Two playback targets with a credential: one re-issued since the worker last picked it
        # up, one not. Only the first is stale.
        self.stale_gw, self.stale_wire = self._gateway(shadow=True)
        self.fresh_gw, fresh_wire = self._gateway(shadow=True)
        for gid in (self.stale_gw, self.fresh_gw):
            self.cur.execute(
                "SELECT public.record_gateway_credential_issued_by_service(%s);", (gid,))
        self.cur.execute(
            "INSERT INTO public.playback_worker_status (id, held_edge_nodes, reported_at, "
            "credential_observed_at) VALUES (true, %s, now(), jsonb_build_object("
            "%s::text, (now() - interval '1 hour')::text, %s::text, now()::text)) "
            "ON CONFLICT (id) DO UPDATE SET held_edge_nodes = EXCLUDED.held_edge_nodes, "
            "reported_at = EXCLUDED.reported_at, "
            "credential_observed_at = EXCLUDED.credential_observed_at;",
            ([self.stale_wire, fresh_wire], self.stale_wire, fresh_wire),
        )

    # -- fixtures ---------------------------------------------------------------------------

    def _gateway(self, shadow):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, "
            "is_shadow) VALUES (%s, %s, 'cell', %s, %s, %s) RETURNING sparkplug_id;",
            (gid, f"Test_Gates_GW_{gid[:8]}", "host" if shadow else "remote", shadow, shadow),
        )
        return gid, self.cur.fetchone()[0]

    # -- callers ----------------------------------------------------------------------------

    def _as(self, caller):
        """Become `caller` for what follows, as PostgREST and storage-api do: role, then claims."""
        if caller == "service_role":
            self.cur.execute("SET LOCAL ROLE service_role;")
            claims = '{"role": "service_role"}'
        elif caller == "anon":
            self.cur.execute("SET LOCAL ROLE anon;")
            claims = '{"role": "anon"}'
        else:
            sub = {"ingestion": INGESTION, "playback": PLAYBACK}.get(caller) or PEOPLE[caller]
            self.cur.execute("SET LOCAL ROLE authenticated;")
            claims = '{"sub": "%s", "role": "authenticated"}' % sub
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))

    def _call(self, caller, sql, args=()):
        """One statement as `caller`, in a savepoint, so a refusal leaves the fixture standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self._as(caller)
            self.cur.execute(sql, args)
            return self.cur.fetchall() if self.cur.description else self.cur.rowcount
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")

    def _recording(self, caller, path=None):
        return self._call(caller, "SELECT public.is_active_capture_object(%s);",
                          (path or self.recording,))[0][0]

    def _replaying(self, caller, path=None):
        return self._call(caller, "SELECT public.is_active_playback_capture(%s);",
                          (path or self.replaying,))[0][0]

    def _stale(self, caller):
        rows = self._call(caller, "SELECT sparkplug_id FROM public.playback_stale_credentials();")
        return sorted(r[0] for r in rows)


class TheThreeHelpers(GatesBase):

    def test_an_operator_learns_nothing(self):
        """THE ONE THAT MATTERS. Before 0184 an Operator got true, true and the stale gateway."""
        self.assertFalse(self._recording("Operator"),
                         "an Operator can tell which object is being recorded right now")
        self.assertFalse(self._replaying("Operator"),
                         "an Operator can tell which capture is being replayed right now")
        self.assertEqual(self._stale("Operator"), [],
                         "an Operator can read when playback credentials were issued")

    def test_each_role_that_reads_the_jobs_still_gets_the_answer(self):
        for role in READERS:
            with self.subTest(role=role):
                self.assertTrue(self._recording(role))
                self.assertTrue(self._replaying(role))
                self.assertEqual(self._stale(role), [self.stale_wire])

    def test_the_ingestion_daemon_sees_only_its_recording(self):
        self.assertTrue(self._recording("ingestion"),
                        "the daemon cannot see the object it records: every capture upload fails")
        self.assertFalse(self._replaying("ingestion"))
        self.assertEqual(self._stale("ingestion"), [])

    def test_the_playback_worker_sees_only_its_capture(self):
        self.assertFalse(self._recording("playback"))
        self.assertTrue(self._replaying("playback"),
                        "the worker cannot see the capture it plays: every playback fails")
        self.assertEqual(self._stale("playback"), [])

    def test_service_role_is_unchanged(self):
        """RLS hides no row from service_role, so neither do the helpers."""
        self.assertTrue(self._recording("service_role"))
        self.assertTrue(self._replaying("service_role"))
        self.assertEqual(self._stale("service_role"), [self.stale_wire])

    def test_a_path_no_job_names_is_false_for_everyone(self):
        """The control: a reader's true comes from the job, not from the gate alone."""
        other = self.recording.replace("capture.json", "other.json")
        for caller in CALLERS + ("service_role",):
            with self.subTest(caller=caller):
                self.assertFalse(self._recording(caller, other))
                self.assertFalse(self._replaying(caller, other))

    def test_anon_may_not_call_them(self):
        for sql in ("SELECT public.is_active_capture_object('x');",
                    "SELECT public.is_active_playback_capture('x');",
                    "SELECT * FROM public.playback_stale_credentials();"):
            with self.subTest(sql=sql):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call("anon", sql)

    def test_each_is_a_plpgsql_definer_with_its_declared_shape(self):
        """A "may this caller" answer is plpgsql, and a redeclaration keeps the return type."""
        expected = {
            "public.is_active_capture_object(text)": "boolean",
            "public.is_active_playback_capture(text)": "boolean",
            "public.playback_stale_credentials()":
                "TABLE(sparkplug_id text, observed_at timestamp with time zone, "
                "issued_at timestamp with time zone)",
        }
        for signature, result in expected.items():
            with self.subTest(function=signature):
                self.cur.execute(
                    "SELECT l.lanname, p.prosecdef, pg_get_function_result(p.oid) "
                    "  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang "
                    " WHERE p.oid = %s::regprocedure;", (signature,))
                self.assertEqual(self.cur.fetchone(), ("plpgsql", True, result))


class StartPlayback(GatesBase):
    """start_playback_job() consults playback_stale_credentials() as its caller."""

    START = "SELECT public.start_playback_job(%s, %s);"

    def test_a_stale_target_is_still_refused_for_each_role_that_may_start_one(self):
        for role in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(role=role):
                with self.assertRaisesRegex(pg_errors.CheckViolation, "re-issued"):
                    self._call(role, self.START, (self.capture_id, self.stale_gw))

    def test_a_current_target_is_still_accepted(self):
        for role in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(role=role):
                self.assertIsNotNone(
                    self._call(role, self.START, (self.capture_id, self.fresh_gw))[0][0])

    def test_everyone_else_is_refused_before_the_credential_is_looked_at(self):
        for caller in ("Auditor", "Operator", "ingestion", "playback", "service_role"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._call(caller, self.START, (self.capture_id, self.stale_gw))


class BrokerCapturePolicies(GatesBase):
    """The four broker_captures_* policies, verbatim, on a stand-in table."""

    def setUp(self):
        super().setUp()
        self.cur.execute("CREATE SCHEMA capture_gate_probe;")
        self.cur.execute(
            "CREATE TABLE capture_gate_probe.objects (bucket_id text NOT NULL, name text NOT NULL, "
            "metadata jsonb);")
        # storage-api's own definition: every path segment but the last.
        self.cur.execute(
            "CREATE FUNCTION capture_gate_probe.foldername(name text) RETURNS text[] "
            "LANGUAGE plpgsql AS $f$ DECLARE _parts text[]; BEGIN "
            "SELECT string_to_array(name, '/') INTO _parts; "
            "RETURN _parts[1:array_length(_parts, 1) - 1]; END $f$;")
        self.cur.execute("ALTER TABLE capture_gate_probe.objects ENABLE ROW LEVEL SECURITY;")
        self.cur.execute("GRANT USAGE ON SCHEMA capture_gate_probe TO authenticated;")
        self.cur.execute(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON capture_gate_probe.objects TO authenticated;")
        self.cur.execute(self._policies())

        self.other = self.recording.replace("capture.json", "other.json")
        for name in (self.recording, self.replaying, self.other):
            self.cur.execute(
                "INSERT INTO capture_gate_probe.objects (bucket_id, name) "
                "VALUES ('broker-captures', %s);", (name,))

    @staticmethod
    def _policies():
        """The broker-captures section of storage-policies.sql, pointed at the stand-in."""
        with open(STORAGE_POLICIES, encoding="utf-8") as f:
            text = f.read()
        start = text.index("-- broker-captures:")
        block = text[start:text.index("DO $$", start)]
        block = block.replace("storage.objects", STAND_IN + ".objects")
        block = block.replace("storage.foldername", STAND_IN + ".foldername")
        if "storage." in block:
            raise AssertionError("the broker-captures policies name a storage object this "
                                 "suite has no stand-in for")
        return block

    def _sees(self, caller, name):
        return self._call(
            caller, "SELECT count(*) FROM capture_gate_probe.objects "
                    "WHERE bucket_id = 'broker-captures' AND name = %s;", (name,))[0][0] == 1

    def _inserts(self, caller, name):
        try:
            self._call(caller, "INSERT INTO capture_gate_probe.objects (bucket_id, name) "
                               "VALUES ('broker-captures', %s);", (name,))
            return True
        except pg_errors.InsufficientPrivilege:
            return False

    def _updates(self, caller, name):
        return self._call(
            caller, "UPDATE capture_gate_probe.objects SET metadata = '{}'::jsonb "
                    "WHERE bucket_id = 'broker-captures' AND name = %s;", (name,)) == 1

    def _deletes(self, caller, name):
        return self._call(
            caller, "DELETE FROM capture_gate_probe.objects "
                    "WHERE bucket_id = 'broker-captures' AND name = %s;", (name,)) == 1

    def test_the_stand_in_carries_all_four_policies(self):
        self.cur.execute(
            "SELECT count(*) FROM pg_policies WHERE schemaname = %s AND tablename = 'objects' "
            "AND policyname LIKE 'broker_captures_%%';", (STAND_IN,))
        self.assertEqual(self.cur.fetchone()[0], 4)

    def test_each_caller_reaches_what_the_file_says(self):
        """
        Read: the three reader roles everything; the daemon its recording; the worker the capture
        it plays; an Operator nothing. Write: Administrator and Shopfloor_Manager anywhere under a
        subject, the daemon its recording and nothing else. Delete: the two writer roles alone.
        """
        new_object = self.recording.replace("capture.json", "new.json")
        writer = {"see": (1, 1, 1), "insert": (1, 1), "update": (1, 1), "delete": 1}
        expected = {
            "Administrator": writer,
            "Shopfloor_Manager": writer,
            "Auditor": {"see": (1, 1, 1), "insert": (0, 0), "update": (0, 0), "delete": 0},
            "Operator": {"see": (0, 0, 0), "insert": (0, 0), "update": (0, 0), "delete": 0},
            "ingestion": {"see": (1, 0, 0), "insert": (1, 0), "update": (1, 0), "delete": 0},
            "playback": {"see": (0, 1, 0), "insert": (0, 0), "update": (0, 0), "delete": 0},
        }
        for caller, want in expected.items():
            with self.subTest(caller=caller):
                got = {
                    "see": tuple(int(self._sees(caller, n))
                                 for n in (self.recording, self.replaying, self.other)),
                    "insert": (int(self._inserts(caller, self.recording)),
                               int(self._inserts(caller, new_object))),
                    "update": (int(self._updates(caller, self.recording)),
                               int(self._updates(caller, self.other))),
                    "delete": int(self._deletes(caller, self.other)),
                }
                self.assertEqual(got, want)


if __name__ == "__main__":
    unittest.main(verbosity=2)
