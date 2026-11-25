# suite:
#   lanes: db
#   why: 0329 -- a 3D model no device names is swept from storage. Each failure here is silent: a
#     replaced model left in a public bucket for ever; an upload swept before its device records it; the
#     last model of a retired device, or one an open proposal names, deleted; or a policy that lets the
#     sweep delete the model a device still shows. Runs the asset-3d-models policies and their
#     self-check verbatim on a stand-in, and needs supabase_admin to stand in for storage.objects, as
#     test_area_plan_sweep.py does.

"""
A 3D model no device names is swept from storage (0329).

    python supabase/migrations/test_device_model_sweep.py

Requires the Supabase database (54322 by default) with the chain applied, and supabase_admin (the
same password) to create a stand-in for storage.objects: the db lane has no storage-api, so the
table does not exist there. The suite skips itself where it does exist.

  * An object a device names is never listed for deletion, however old: archived, quarantined, a replay
    lane's machine that names a file under the lane's id. Nor is one that a retired device's tombstone
    or an open change proposal names.
  * An object nothing names is listed for the sweep, which runs as the ingestion principal, once it is a
    day old, and not before: one a replacement left, one whose delete failed, and the model of a device
    deleted without a tombstone.
  * Only the ingestion principal asks for the list, and anon may not ask whether an object is claimed.
  * While there is no device at all, nothing is unclaimed.
  * The asset-3d-models policies, verbatim on a stand-in table: the ingestion principal reads and
    deletes an object nothing names, writes nothing, and the file's self-check refuses an arm for it
    that is not confined, or none.

Every test rolls back.
"""
import json
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors, sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_ADMIN_USER = os.getenv("SUPABASE_DB_ADMIN_USER", "supabase_admin")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STORAGE_POLICIES = os.path.join(REPO, "supabase", "storage-policies.sql")

PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-0000000a0329",
    "Shopfloor_Manager": "00000000-0000-4000-8000-0000000b0329",
    "Auditor": "00000000-0000-4000-8000-0000000c0329",
    "Operator": "00000000-0000-4000-8000-0000000d0329",
}
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"

DAY = 24 * 60 * 60

# Not the bucket's schema: the policies' stand-in, which dies with the transaction.
PROBE = "device_model_sweep_probe"


def probe(text):
    """`text` with the stand-in's schema for {s} and its table for {t}."""
    return sql.SQL(text).format(s=sql.Identifier(PROBE), t=sql.Identifier(PROBE, "objects"))


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
            cur.execute("SELECT to_regprocedure('public.ingest_unclaimed_device_model_objects(integer)'), "
                        "to_regclass('storage.objects');")
            fn, objects = cur.fetchone()
        finally:
            conn.rollback()
            conn.close()
        if not fn:
            raise unittest.SkipTest("0329 has not been applied")
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
            self.cur.execute("INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                             (user_id, f"model-sweep-{user_id[-6:]}@test.local"))
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;", (user_id, role))

    # -- fixtures, as the owner ---------------------------------------------------------------

    def device(self, model="model.glb", archived=False, held=False, folder=None):
        """A device that names <id>/<model>, or nothing where `model` is None. Returns (id, path)."""
        device_id = str(uuid.uuid4())
        path = f"{folder or device_id}/{model}" if model else None
        self.cur.execute(
            "INSERT INTO public.devices (id, name, model_3d_path, is_archived, archived_at, is_quarantined)"
            " VALUES (%s, %s, %s, %s, CASE WHEN %s THEN now() END, %s);",
            (device_id, f"Model_Sweep_{device_id[:8]}", path, archived, archived, held))
        return device_id, path

    def stored(self, name, age_seconds=0, bucket="asset-3d-models"):
        self.cur.execute(
            "INSERT INTO storage.objects (bucket_id, name, metadata, created_at, updated_at) "
            "VALUES (%s, %s, '{}', now() - make_interval(secs => %s), now() - make_interval(secs => %s));",
            (bucket, name, age_seconds, age_seconds))
        return name

    # -- callers ------------------------------------------------------------------------------

    def _as(self, caller):
        if caller == "anon":
            self.cur.execute("SET LOCAL ROLE anon;")
            claims = {"role": "anon"}
        else:
            sub = {"ingestion": INGESTION, "playback": PLAYBACK}.get(caller) or PEOPLE[caller]
            self.cur.execute("SET LOCAL ROLE authenticated;")
            claims = {"sub": sub, "role": "authenticated"}
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))

    def run_as(self, caller, statement, args=()):
        """One statement as `caller`, kept on success; a refusal leaves the fixture standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self._as(caller)
            self.cur.execute(statement, args)
            result = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        except Exception:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT call;")
        return result

    def listed(self, min_age=DAY):
        return self.run_as("ingestion", "SELECT public.ingest_unclaimed_device_model_objects(%s);", (min_age,))[0][0]

    def unclaimed(self, name, caller="ingestion"):
        return self.run_as(caller, "SELECT public.is_unclaimed_device_model_object(%s);", (name,))[0][0]


class WhatIsNamed(Base):
    """A model something names is never listed; one nothing names is, once the day is up."""

    def test_a_model_a_device_names_is_never_listed(self):
        lane = str(uuid.uuid4())
        kept = [self.device()[1], self.device(archived=True)[1], self.device(held=True)[1], self.device(folder=lane)[1]]
        for path in kept:
            self.stored(path, age_seconds=90 * DAY)
            self.assertFalse(self.unclaimed(path), path)
        listed = self.listed(0)
        for path in kept:
            self.assertNotIn(path, listed)

    def test_what_a_replacement_left_is_listed_after_a_day_and_not_before(self):
        device_id, path = self.device()
        left = self.stored(f"{device_id}/model-old.glb", age_seconds=DAY + 60)
        in_flight = self.stored(f"{device_id}/model-new.glb", age_seconds=DAY - 3600)
        self.stored(path, age_seconds=2 * DAY)
        self.assertTrue(self.unclaimed(left))
        self.assertTrue(self.unclaimed(in_flight))
        listed = self.listed()
        self.assertIn(left, listed)
        self.assertNotIn(in_flight, listed, "an upload in flight would be swept")
        self.assertNotIn(path, listed)
        self.assertIn(in_flight, self.listed(0))

    def test_a_model_removed_whose_delete_failed_is_listed(self):
        device_id, path = self.device()
        self.stored(path, age_seconds=2 * DAY)
        self.assertNotIn(path, self.listed())
        self.cur.execute("UPDATE public.devices SET model_3d_path = NULL WHERE id = %s;", (device_id,))
        self.assertIn(path, self.listed())

    def test_a_file_written_over_is_as_old_as_its_last_write(self):
        device_id, _ = self.device(model=None)
        path = self.stored(f"{device_id}/model.glb", age_seconds=30 * DAY)
        self.cur.execute("UPDATE storage.objects SET updated_at = now() WHERE name = %s;", (path,))
        self.assertNotIn(path, self.listed())

    def test_only_the_models_bucket_is_listed(self):
        device_id, _ = self.device(model=None)
        elsewhere = self.stored(f"{device_id}/plan-9.svg", age_seconds=2 * DAY, bucket="area-plans")
        self.assertNotIn(elsewhere, self.listed())

    def test_a_file_in_no_devices_folder_is_listed(self):
        self.device()
        stray = self.stored("__gateway_probe__.bin", age_seconds=2 * DAY)
        self.assertIn(stray, self.listed())


class ADeletedDevice(Base):
    def test_the_last_model_of_a_retired_device_is_kept_and_an_earlier_one_is_not(self):
        device_id, path = self.device(archived=True)
        earlier = self.stored(f"{device_id}/model-old.glb", age_seconds=2 * DAY)
        self.stored(path, age_seconds=2 * DAY)
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device_id,))
        self.device()
        self.cur.execute("SELECT old_data ->> 'model_3d_path' FROM public.retired_entities WHERE entity_id = %s;", (device_id,))
        self.assertEqual(self.cur.fetchone()[0], path, "a tombstone no longer names the model")
        self.assertFalse(self.unclaimed(path))
        listed = self.listed()
        self.assertNotIn(path, listed, "the last model of a retired device would be swept")
        self.assertIn(earlier, listed)

    def test_the_model_of_a_device_deleted_without_a_tombstone_is_listed(self):
        for device in (self.device(held=True), self.device()):
            with self.subTest(device=device[0]):
                device_id, path = device
                self.stored(path, age_seconds=2 * DAY)
                self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device_id,))
                self.device()
                self.cur.execute("SELECT count(*) FROM public.retired_entities WHERE entity_id = %s;", (device_id,))
                self.assertEqual(self.cur.fetchone()[0], 0)
                self.assertIn(path, self.listed())

    def test_another_kinds_tombstone_names_no_model(self):
        path = self.stored(f"{uuid.uuid4()}/model.glb", age_seconds=2 * DAY)
        self.device()
        self.cur.execute("INSERT INTO public.retired_entities (entity_type, entity_id, name, old_data)"
                         " VALUES ('areas', %s, 'x', %s);", (str(uuid.uuid4()), json.dumps({"model_3d_path": path})))
        self.assertIn(path, self.listed())


class AProposal(Base):
    def propose(self, device_id, path, status="open", entity_type="devices"):
        decided = status != "open"
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, status, proposed_by, decided_by, decided_at,"
            " decision_reason) VALUES (%s, %s, %s, %s, %s, %s, CASE WHEN %s THEN now() END, %s);",
            (entity_type, device_id, json.dumps({"model_3d_path": path}), status, PEOPLE["Operator"],
             PEOPLE["Administrator"] if decided else None, decided, "no" if decided else None))

    def test_a_model_an_open_proposal_names_is_kept_until_it_is_decided(self):
        device_id, _ = self.device()
        path = self.stored(f"{device_id}/proposed.glb", age_seconds=9 * DAY)
        self.propose(device_id, path)
        self.assertFalse(self.unclaimed(path))
        self.assertNotIn(path, self.listed())

    def test_a_decided_proposal_names_nothing(self):
        device_id, _ = self.device()
        for status in ("rejected", "withdrawn", "expired"):
            with self.subTest(status=status):
                path = self.stored(f"{device_id}/{status}.glb", age_seconds=9 * DAY)
                self.propose(device_id, path, status)
                self.assertIn(path, self.listed())


class NoDeviceAtAll(Base):
    def test_nothing_is_unclaimed_while_there_is_no_device(self):
        """A restore makes the table before it fills it, and the sweep may run between."""
        path = self.stored(f"{uuid.uuid4()}/model.glb", age_seconds=9 * DAY)
        self.device()
        self.assertTrue(self.unclaimed(path))
        self.cur.execute("SET LOCAL session_replication_role = replica;")
        self.cur.execute("DELETE FROM public.devices;")
        self.cur.execute("SET LOCAL session_replication_role = origin;")
        self.assertFalse(self.unclaimed(path))
        self.assertEqual(self.listed(0), [])


class WhoMayAsk(Base):
    def test_only_the_ingestion_principal_asks_for_the_list(self):
        for caller in ("Administrator", "Shopfloor_Manager", "Auditor", "Operator", "playback"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self.run_as(caller, "SELECT public.ingest_unclaimed_device_model_objects(0);")

    def test_anon_may_ask_neither(self):
        for statement in ("SELECT public.ingest_unclaimed_device_model_objects(0);",
                          "SELECT public.is_unclaimed_device_model_object('x');"):
            with self.subTest(statement=statement):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self.run_as("anon", statement)

    def test_the_answer_does_not_depend_on_who_asks(self):
        """A tombstone and a proposal are hidden from most callers, and the policy asks as the caller."""
        device_id, retired = self.device(archived=True)
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device_id,))
        _, live = self.device()
        for caller in ("Operator", "Auditor", "playback", "ingestion"):
            with self.subTest(caller=caller):
                self.assertFalse(self.unclaimed(live, caller))
                self.assertFalse(self.unclaimed(retired, caller))
                self.assertTrue(self.unclaimed(f"{device_id}/other.glb", caller))

    def test_the_list_stops_at_five_hundred(self):
        device_id, _ = self.device(model=None)
        self.cur.execute(
            "INSERT INTO storage.objects (bucket_id, name, created_at, updated_at)"
            " SELECT 'asset-3d-models', %s || '/m' || i || '.glb', now() - interval '9 days', now() - interval '9 days'"
            "   FROM generate_series(1, 503) i;", (device_id,))
        self.assertEqual(len(self.listed()), 500)


class TheBucketPolicies(Base):
    """The asset-3d-models policies and their self-check from storage-policies.sql, verbatim, on a stand-in."""

    ARM = ("OR (public.is_ingestion_caller()\n"
           "             AND public.is_unclaimed_device_model_object(storage.objects.name)))")

    def section(self, edit=lambda text: text):
        with open(STORAGE_POLICIES, encoding="utf-8") as handle:
            text = edit(handle.read())
        policies = text[text.index("-- asset-3d-models."):text.index("-- On the PG17 image")]
        check = text[text.index("-- Self-check, by name and not by count"):text.index("-- broker-captures: private.")]
        block = (policies + check).replace("storage.objects", PROBE + ".objects")
        block = block.replace("schemaname = 'storage'", f"schemaname = '{PROBE}'")
        self.assertNotIn("storage.", block)
        self.assertNotIn("'storage'", block)
        return block

    def setUp(self):
        super().setUp()
        self.cur.execute(probe("CREATE SCHEMA {s};"))
        self.cur.execute(probe("CREATE TABLE {t} (bucket_id text NOT NULL, name text NOT NULL, metadata jsonb);"))
        self.cur.execute(probe("ALTER TABLE {t} ENABLE ROW LEVEL SECURITY;"))
        self.cur.execute(probe("GRANT USAGE ON SCHEMA {s} TO authenticated;"))
        self.cur.execute(probe("GRANT SELECT, INSERT, UPDATE, DELETE ON {t} TO authenticated;"))
        self.cur.execute(self.section())
        self.device_id, self.claimed = self.device()
        self.orphan = f"{self.device_id}/model-old.glb"
        for name in (self.claimed, self.orphan):
            self.cur.execute(probe("INSERT INTO {t} (bucket_id, name) VALUES ('asset-3d-models', %s);"), (name,))
        self.cur.execute(probe("INSERT INTO {t} (bucket_id, name) VALUES ('broker-captures', %s);"), (self.orphan + ".json",))

    def deletes(self, caller, name):
        self.cur.execute("SAVEPOINT del;")
        try:
            return self.run_as(caller, probe("DELETE FROM {t} WHERE name = %s RETURNING name;"), (name,)) == [(name,)]
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT del;")

    def test_the_sweep_deletes_a_model_nothing_names_and_not_one_a_device_shows(self):
        """RETURNING, as storage-api's delete reads the row back, which Postgres checks against SELECT."""
        self.assertTrue(self.deletes("ingestion", self.orphan))
        self.assertFalse(self.deletes("ingestion", self.claimed))
        self.assertFalse(self.deletes("ingestion", self.orphan + ".json"))

    def test_the_sweep_sees_what_it_may_delete_and_nothing_else(self):
        seen = self.run_as("ingestion", probe("SELECT name FROM {t};"))
        self.assertEqual(seen, [(self.orphan,)])

    def test_the_sweep_writes_nothing(self):
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.run_as("ingestion", probe("INSERT INTO {t} (bucket_id, name) VALUES ('asset-3d-models', %s);"),
                        (f"{self.device_id}/model-9.glb",))
        self.assertEqual(self.run_as("ingestion", probe("UPDATE {t} SET metadata = '{{}}' WHERE name = %s;"),
                                     (self.orphan,)), 0)

    def test_the_writers_are_as_they_were_and_the_others_delete_and_see_nothing(self):
        expected = {"Administrator": True, "Shopfloor_Manager": True, "Auditor": False, "Operator": False, "playback": False}
        for caller, allowed in expected.items():
            with self.subTest(caller=caller):
                self.assertEqual(self.deletes(caller, self.orphan), allowed)
                self.assertEqual(self.deletes(caller, self.claimed), allowed)
                seen = self.run_as(caller, probe("SELECT count(*) FROM {t} WHERE bucket_id = 'asset-3d-models';"))[0][0]
                self.assertEqual(seen, 2 if allowed else 0)

    def test_the_files_own_self_check_passes_on_what_it_states(self):
        """An arm the self-check misreads would fail the storage-policies Job on every boot."""
        self.cur.execute(self.section())

    def refused(self, edit, pattern):
        with self.assertRaisesRegex(pg_errors.RaiseException, pattern):
            self.cur.execute(self.section(edit))

    def test_the_self_check_refuses_an_ingestion_arm_that_is_not_confined(self):
        def widen(text):
            self.assertEqual(text.count(self.ARM), 2, "the ingestion arms moved; update ARM")
            return text.replace(self.ARM, "OR public.is_ingestion_caller())")
        self.refused(widen, "nothing names")

    def test_the_self_check_refuses_an_ingestion_arm_beside_the_confined_one(self):
        self.refused(lambda text: text.replace(self.ARM, self.ARM[:-1] + "\n OR public.is_ingestion_caller())"), "still names")

    def test_the_self_check_refuses_a_select_or_a_delete_without_the_arm(self):
        for keep in (0, 1):
            with self.subTest(dropped="SELECT" if keep else "DELETE"):
                def drop(text, keep=keep):
                    first = text.index(self.ARM)
                    at = first if keep else text.index(self.ARM, first + 1)
                    return text[:at] + ")" + text[at + len(self.ARM):]
                self.cur.execute("SAVEPOINT check_;")
                self.refused(drop, "does not admit the device-model sweep")
                self.cur.execute("ROLLBACK TO SAVEPOINT check_;")

    def test_the_self_check_refuses_an_ingestion_arm_on_a_write(self):
        def widen(text):
            arm = "    AND NOT public.is_replay_lane_model_path(storage.objects.name)\n  );\n\nDROP POLICY IF EXISTS \"asset_3d_models_update_privileged\""
            self.assertIn(arm, text, "the insert arm moved; update this test")
            return text.replace(arm, arm.replace("\n  );", "\n    OR (public.is_ingestion_caller() AND public.is_unclaimed_device_model_object(storage.objects.name))\n  );", 1))
        self.refused(widen, "still names")


if __name__ == "__main__":
    unittest.main(verbosity=2)
