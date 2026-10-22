"""
A plan no area names is swept from storage (0199).

    python supabase/migrations/test_area_plan_sweep.py

Requires the Supabase database (54322 by default) with the chain applied, and supabase_admin (the
same password) to create a stand-in for storage.objects: the db lane has no storage-api, so the
table does not exist there. The suite skips itself where it does exist.

Four things are held here:

  * an object an area names, archived or not, is never listed for deletion, however old;
  * an object no area names is listed for the sweep, which runs as the ingestion principal, once it
    is an hour old, and not before, which spares a plan uploaded and not yet recorded on its area.
    A replaced plan, a removed one and the plan of an area the nightly purge deleted are each
    listed;
  * only the ingestion principal asks for the list, and anon may not ask whether an object is
    claimed;
  * the area-plans policies, verbatim on a stand-in table: the ingestion principal deletes an object
    no area names and writes nothing, and the file's self-check refuses an arm for it that is not
    confined.

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
DB_ADMIN_USER = os.getenv("SUPABASE_DB_ADMIN_USER", "supabase_admin")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STORAGE_POLICIES = os.path.join(REPO, "supabase", "storage-policies.sql")

PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-0000000a1088",
    "Shopfloor_Manager": "00000000-0000-4000-8000-0000000b1088",
    "Auditor": "00000000-0000-4000-8000-0000000c1088",
    "Operator": "00000000-0000-4000-8000-0000000d1088",
}
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"

HOUR = 3600

# Not the bucket's schema: the policies' stand-in, which dies with the transaction.
PROBE = "area_plan_sweep_probe"


def connect(user=DB_USER):
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """The fixture as the owner, each call as a caller, and a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = connect()
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regprocedure('public.ingest_unclaimed_area_plan_objects(integer)'), "
                        "to_regclass('storage.objects');")
            fn, objects = cur.fetchone()
        finally:
            conn.rollback()
            conn.close()
        if not fn:
            raise unittest.SkipTest("0199 has not been applied")
        if objects:
            raise unittest.SkipTest("storage.objects exists here; this suite runs in the db lane, "
                                    "where storage-api has not created it")
        # Committed, because the owner may not create in the storage schema and supabase_admin's
        # connection is not the test's. Dropped by tearDownClass.
        admin = connect(DB_ADMIN_USER)
        try:
            cur = admin.cursor()
            cur.execute(
                "CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, "
                "bucket_id text NOT NULL, name text NOT NULL, metadata jsonb, "
                "created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());")
            cur.execute("GRANT ALL ON storage.objects TO postgres;")
            admin.commit()
        finally:
            admin.close()

    @classmethod
    def tearDownClass(cls):
        admin = connect(DB_ADMIN_USER)
        try:
            admin.cursor().execute("DROP TABLE IF EXISTS storage.objects;")
            admin.commit()
        finally:
            admin.close()

    def setUp(self):
        self.conn = connect()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"plan-sweep-{user_id[-6:]}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    # -- fixtures, as the owner ---------------------------------------------------------------

    def _area(self, plan=True, is_archived=False, archived_at=None, auto_delete_at=None):
        """An area, with a plan at <id>/plan-1.svg unless `plan` is False. Returns (id, path)."""
        area_id = str(uuid.uuid4())
        path = f"{area_id}/plan-1.svg"
        self.cur.execute(
            "INSERT INTO public.areas (id, name, plan_path, plan_aspect, is_archived, archived_at, "
            "auto_delete_at) VALUES (%s, %s, %s, %s, %s, %s, %s);",
            (area_id, f"Plan_Sweep_{area_id[:8]}", path if plan else None, 1.5 if plan else None,
             is_archived, archived_at, auto_delete_at),
        )
        return area_id, path

    def _object(self, name, age_seconds=0, bucket="area-plans"):
        self.cur.execute(
            "INSERT INTO storage.objects (bucket_id, name, metadata, created_at, updated_at) "
            "VALUES (%s, %s, '{}', now() - make_interval(secs => %s), now() - make_interval(secs => %s));",
            (bucket, name, age_seconds, age_seconds),
        )

    # -- callers ------------------------------------------------------------------------------

    def _as(self, caller):
        if caller == "anon":
            self.cur.execute("SET LOCAL ROLE anon;")
            claims = '{"role": "anon"}'
        else:
            sub = {"ingestion": INGESTION, "playback": PLAYBACK}.get(caller) or PEOPLE[caller]
            self.cur.execute("SET LOCAL ROLE authenticated;")
            claims = '{"sub": "%s", "role": "authenticated"}' % sub
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))

    def _run(self, caller, sql, args=()):
        """One statement as `caller`, kept on success; a refusal leaves the fixture standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self._as(caller)
            self.cur.execute(sql, args)
            result = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        except Exception:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT call;")
        return result

    def listed(self, min_age=HOUR):
        return self._run("ingestion", "SELECT public.ingest_unclaimed_area_plan_objects(%s);",
                         (min_age,))[0][0]

    def unclaimed(self, name, caller="ingestion"):
        return self._run(caller, "SELECT public.is_unclaimed_area_plan_object(%s);", (name,))[0][0]


class WhatAnAreaNames(Base):
    """A plan an area shows is never listed; a plan nothing names is, once the hour is up."""

    def test_a_plan_an_area_names_is_never_listed(self):
        _, live = self._area()
        _, kept = self._area(is_archived=True, archived_at="2026-01-01T00:00:00Z")
        for path in (live, kept):
            self._object(path, age_seconds=30 * 24 * HOUR)
        self.assertFalse(self.unclaimed(live))
        self.assertFalse(self.unclaimed(kept), "an archived area's plan would be swept")
        listed = self.listed(0)
        self.assertNotIn(live, listed)
        self.assertNotIn(kept, listed)

    def test_an_orphan_is_listed_after_the_hour_and_not_before(self):
        """The page uploads the plan before it writes plan_path: the hour covers that gap."""
        area, _ = self._area(plan=False)
        in_flight = f"{area}/plan-2.svg"
        stranded = f"{area}/plan-3.svg"
        self._object(in_flight, age_seconds=60)
        self._object(stranded, age_seconds=HOUR + 60)
        self.assertTrue(self.unclaimed(in_flight))
        listed = self.listed()
        self.assertNotIn(in_flight, listed, "an upload in flight would be swept")
        self.assertIn(stranded, listed)
        self.assertIn(in_flight, self.listed(0))

    def test_a_replaced_or_removed_plan_is_listed(self):
        """The page swallows a failed delete of the plan it replaced or removed."""
        replaced_area, replaced = self._area()
        removed_area, removed = self._area()
        self._object(replaced, age_seconds=2 * HOUR)
        self._object(removed, age_seconds=2 * HOUR)
        self.assertNotIn(replaced, self.listed())

        newer = f"{replaced_area}/plan-2.svg"
        self._object(newer, age_seconds=2 * HOUR)
        self.cur.execute("UPDATE public.areas SET plan_path = %s WHERE id = %s;", (newer, replaced_area))
        self.cur.execute("UPDATE public.areas SET plan_path = NULL, plan_aspect = NULL WHERE id = %s;",
                         (removed_area,))
        listed = self.listed()
        self.assertIn(replaced, listed)
        self.assertIn(removed, listed)
        self.assertNotIn(newer, listed)

    def test_the_plan_of_an_area_the_purge_deleted_is_listed(self):
        expired = {"is_archived": True, "archived_at": "2026-01-01T00:00:00Z",
                   "auto_delete_at": "2026-01-02T00:00:00Z"}
        purged_area, purged = self._area(**expired)
        _, kept = self._area(is_archived=True, archived_at="2026-01-01T00:00:00Z")
        for path in (purged, kept):
            self._object(path, age_seconds=30 * 24 * HOUR)
        self.assertNotIn(purged, self.listed())

        self.cur.execute("SELECT command FROM cron.job WHERE jobname = 'purge_expired_archives';")
        self.cur.execute(self.cur.fetchone()[0])

        self.cur.execute("SELECT count(*) FROM public.areas WHERE id = %s;", (purged_area,))
        self.assertEqual(self.cur.fetchone()[0], 0, "the purge kept an area nothing names")
        listed = self.listed()
        self.assertIn(purged, listed, "the purged area's plan stays in the bucket")
        self.assertNotIn(kept, listed, "the plan of an area with no timer would be swept")

    def test_only_the_area_plans_bucket_is_listed(self):
        area, _ = self._area(plan=False)
        elsewhere = f"{area}/plan-9.svg"
        self._object(elsewhere, age_seconds=2 * HOUR, bucket="broker-captures")
        self.assertNotIn(elsewhere, self.listed())


class WhoMayAsk(Base):

    def test_only_the_ingestion_principal_asks_for_the_list(self):
        for caller in ("Administrator", "Shopfloor_Manager", "Auditor", "Operator", "playback"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._run(caller, "SELECT public.ingest_unclaimed_area_plan_objects(0);")

    def test_anon_may_ask_neither(self):
        for sql in ("SELECT public.ingest_unclaimed_area_plan_objects(0);",
                    "SELECT public.is_unclaimed_area_plan_object('x');"):
            with self.subTest(sql=sql):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._run("anon", sql)

    def test_the_answer_does_not_depend_on_who_asks(self):
        """Every signed-in role reads areas, and the policy asks as the caller."""
        _, path = self._area()
        for caller in ("Operator", "Auditor", "ingestion"):
            with self.subTest(caller=caller):
                self.assertFalse(self.unclaimed(path, caller=caller))
                self.assertTrue(self.unclaimed(path + ".old", caller=caller))


class TheBucketPolicies(Base):
    """The area-plans policies from storage-policies.sql, verbatim, on a stand-in table."""

    INGESTION_ARM = ("OR (public.is_ingestion_caller()\n"
                  "             AND public.is_unclaimed_area_plan_object(storage.objects.name)))")

    def _section(self, edit=lambda text: text):
        """The bucket's policies and the DO block that checks them, pointed at the stand-in."""
        with open(STORAGE_POLICIES, encoding="utf-8") as f:
            text = edit(f.read())
        block = text[text.index("-- area-plans:"):]
        block = (block.replace("storage.objects", PROBE + ".objects")
                      .replace("schemaname = 'storage'", f"schemaname = '{PROBE}'"))
        self.assertNotIn("storage.", block)
        self.assertNotIn("'storage'", block)
        return block

    def setUp(self):
        super().setUp()
        self.cur.execute("CREATE SCHEMA area_plan_sweep_probe;")
        self.cur.execute("CREATE TABLE area_plan_sweep_probe.objects (bucket_id text NOT NULL, name text NOT NULL, metadata jsonb);")
        self.cur.execute("ALTER TABLE area_plan_sweep_probe.objects ENABLE ROW LEVEL SECURITY;")
        self.cur.execute("GRANT USAGE ON SCHEMA area_plan_sweep_probe TO authenticated;")
        self.cur.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON area_plan_sweep_probe.objects TO authenticated;")
        self.cur.execute(self._section())

        self.area_id, self.claimed = self._area()
        self.orphan = f"{self.area_id}/plan-0.svg"
        for name in (self.claimed, self.orphan):
            self.cur.execute("INSERT INTO area_plan_sweep_probe.objects (bucket_id, name) VALUES ('area-plans', %s);", (name,))

    def _deletes(self, caller, name):
        self.cur.execute("SAVEPOINT del;")
        try:
            return self._run(caller, "DELETE FROM area_plan_sweep_probe.objects WHERE bucket_id = 'area-plans' "
                                     "AND name = %s;", (name,)) == 1
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT del;")

    def _writes(self, caller, name):
        try:
            self._run(caller, "INSERT INTO area_plan_sweep_probe.objects (bucket_id, name) VALUES ('area-plans', %s);",
                      (name,))
            return True
        except pg_errors.InsufficientPrivilege:
            return False

    def test_the_sweep_deletes_a_plan_no_area_names_and_not_one_an_area_shows(self):
        self.assertTrue(self._deletes("ingestion", self.orphan))
        self.assertFalse(self._deletes("ingestion", self.claimed))

    def test_the_sweep_sees_what_it_deletes_and_writes_nothing(self):
        """storage-api reads a deleted row back, which Postgres checks against SELECT."""
        seen = self._run("ingestion", "SELECT count(*) FROM area_plan_sweep_probe.objects WHERE name = %s;",
                         (self.orphan,))[0][0]
        self.assertEqual(seen, 1)
        self.assertFalse(self._writes("ingestion", f"{self.area_id}/plan-9.svg"))
        updated = self._run("ingestion", "UPDATE area_plan_sweep_probe.objects SET metadata = '{}' WHERE name = %s;",
                            (self.orphan,))
        self.assertEqual(updated, 0)

    def test_the_writers_delete_an_orphan_and_the_others_delete_nothing(self):
        expected = {"Administrator": True, "Shopfloor_Manager": True,
                    "Auditor": False, "Operator": False, "playback": False}
        for caller, allowed in expected.items():
            with self.subTest(caller=caller):
                self.assertEqual(self._deletes(caller, self.orphan), allowed)

    def test_the_files_own_self_check_passes_on_what_it_states(self):
        """An arm the self-check misreads would fail the storage-policies Job on every boot."""
        self.cur.execute(self._section())

    def test_the_self_check_refuses_an_ingestion_arm_that_is_not_confined(self):
        def widen(text):
            self.assertIn(self.INGESTION_ARM, text, "the ingestion arm moved; update INGESTION_ARM")
            return text.replace(self.INGESTION_ARM, "OR public.is_ingestion_caller())")
        with self.assertRaisesRegex(pg_errors.RaiseException, "no area names"):
            self.cur.execute(self._section(widen))

    def test_the_self_check_refuses_an_ingestion_arm_beside_the_confined_one(self):
        def widen(text):
            self.assertIn(self.INGESTION_ARM, text, "the ingestion arm moved; update INGESTION_ARM")
            return text.replace(self.INGESTION_ARM, self.INGESTION_ARM[:-1] + "\n OR public.is_ingestion_caller())")
        with self.assertRaisesRegex(pg_errors.RaiseException, "still names"):
            self.cur.execute(self._section(widen))


if __name__ == "__main__":
    unittest.main(verbosity=2)
