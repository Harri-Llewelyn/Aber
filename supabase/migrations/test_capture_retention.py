"""
A stored capture is never lost, never orphaned, and never taken on trust (0190).

    python supabase/migrations/test_capture_retention.py

Requires the Supabase database (54322 by default) with the chain applied, and supabase_admin (the
same password) to create a stand-in for storage.objects: the db lane has no storage-api, so the
table does not exist there. The suite skips itself where it does exist.

Five things are held here:

  * a recording and an upload each write a path of their own, and the row is repointed in one
    transaction, so a failure at any step leaves the stored capture whole;
  * whether an upload may replace the stored capture is decided before anything is written, an
    upload is refused while its subject is recording, and a capture stored after the upload began
    is not replaced;
  * register_uploaded_capture() takes the size from the object, not the browser, bounds the message
    count by it and caps the manifest; the Playback gateway and its lanes are not capture subjects;
  * an object nothing claims (no row, recording, open upload or playback) is listed for the
    ingestion daemon to delete, a deleted subject's included, and the bucket's DELETE policy admits
    nobody to an object something does claim;
  * the daemon is told a job is gone rather than to stop, Stop ends a recording whose progress went
    stale, and a swept job says whether it ever started.

Every test rolls back.
"""
import json
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
    "Administrator": "00000000-0000-4000-8000-00000000d932",
    "Shopfloor_Manager": "00000000-0000-4000-8000-00000000d933",
    "Auditor": "00000000-0000-4000-8000-00000000d934",
    "Operator": "00000000-0000-4000-8000-00000000d935",
}
# A second manager, whose page is the stale one.
OTHER_MANAGER = "00000000-0000-4000-8000-00000000d936"
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"
PLAYBACK_GATEWAY = "16000000-0000-4000-8000-000000000001"

# Not the bucket's schema: the policies' stand-in, which dies with the transaction.
PROBE = "capture_retention_probe"


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
            cur.execute("SELECT to_regprocedure('public.begin_capture_upload(text, uuid, boolean, uuid)'), "
                        "to_regclass('storage.objects');")
            fn, objects = cur.fetchone()
        finally:
            conn.rollback()
            conn.close()
        if not fn:
            raise unittest.SkipTest("0190 has not been applied")
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
        for role, user_id in list(PEOPLE.items()) + [("Shopfloor_Manager", OTHER_MANAGER)]:
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"retention-{user_id[-4:]}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )
        self.gw, self.gw_wire = self._gateway()
        self.dev, self.dev_wire = self._device(self.gw)

    # -- fixtures, as the owner ---------------------------------------------------------------

    def _gateway(self):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment) "
            "VALUES (%s, %s, 'cell', 'remote') RETURNING sparkplug_id;",
            (gid, f"Test_Retention_GW_{gid[:8]}"),
        )
        return gid, self.cur.fetchone()[0]

    def _device(self, gateway_id):
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, status) VALUES (%s, %s, %s, 'OFFLINE') "
            "RETURNING sparkplug_id;",
            (did, f"Test_Retention_Dev_{did[:8]}", gateway_id),
        )
        return did, self.cur.fetchone()[0]

    def _object(self, name, size=2048, age_seconds=0):
        self.cur.execute(
            "INSERT INTO storage.objects (bucket_id, name, metadata, created_at, updated_at) "
            "VALUES ('broker-captures', %s, jsonb_build_object('size', %s), "
            "now() - make_interval(secs => %s), now() - make_interval(secs => %s));",
            (name, size, age_seconds, age_seconds),
        )

    def _capture(self, path=None, note="rare fault baseline - keep", kind="gateway"):
        subject, wire = (self.gw, self.gw_wire) if kind == "gateway" else (self.dev, self.dev_wire)
        path = path or f"{wire}/capture.json"
        self.cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, device_id, subject_sparkplug_id, "
            "storage_path, size_bytes, message_count, note) "
            "VALUES (%s, %s, %s, %s, %s, 1507, 4, %s) RETURNING id;",
            (kind, self.gw, None if kind == "gateway" else subject, wire, path, note),
        )
        return self.cur.fetchone()[0]

    def _job(self, status="RECORDING", kind="gateway", started_ago=0, elapsed=0):
        jid = str(uuid.uuid4())
        wire = self.gw_wire if kind == "gateway" else self.dev_wire
        self.cur.execute(
            "INSERT INTO public.capture_jobs (id, subject_kind, gateway_id, device_id, sparkplug_group, "
            "edge_node_id, device_sparkplug_id, subject_sparkplug_id, storage_path, status, "
            "started_at, elapsed_seconds) VALUES (%s, %s, %s, %s, 'Aber', %s, %s, %s, %s, %s, "
            "CASE WHEN %s = 'PENDING' THEN NULL ELSE now() - make_interval(secs => %s) END, %s);",
            (jid, kind, self.gw, None if kind == "gateway" else self.dev, self.gw_wire,
             None if kind == "gateway" else self.dev_wire, wire, f"{wire}/{jid}.json", status,
             status, started_ago, elapsed),
        )
        return jid, f"{wire}/{jid}.json"

    def _row(self, sql, args=()):
        self.cur.execute(sql, args)
        return self.cur.fetchone()

    def _captures_of_gateway(self):
        self.cur.execute("SELECT id, storage_path, size_bytes, note FROM public.captures "
                         "WHERE subject_kind = 'gateway' AND gateway_id = %s;", (self.gw,))
        return self.cur.fetchall()

    # -- callers ------------------------------------------------------------------------------

    def _as(self, caller):
        if caller == "anon":
            self.cur.execute("SET LOCAL ROLE anon;")
            claims = '{"role": "anon"}'
        else:
            sub = {"ingestion": INGESTION, "playback": PLAYBACK, "other": OTHER_MANAGER}.get(caller) \
                or PEOPLE[caller]
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

    def begin(self, caller="Shopfloor_Manager", kind="gateway", subject=None, replace=False,
              expected=None):
        subject = subject or (self.gw if kind == "gateway" else self.dev)
        return self._run(caller, "SELECT public.begin_capture_upload(%s, %s, %s, %s);",
                         (kind, subject, replace, expected))[0][0]

    def register(self, path, caller="Shopfloor_Manager", kind="gateway", subject=None,
                 size=2048, count=4, manifest=None, replace=True):
        subject = subject or (self.gw if kind == "gateway" else self.dev)
        return self._run(
            caller, "SELECT public.register_uploaded_capture(%s, %s, %s, %s, %s, %s, %s, %s);",
            (kind, subject, path, size, count, json.dumps(manifest or {"device_ids": []}),
             "uploaded.json", replace))[0][0]

    def unclaimed(self, name, caller="ingestion"):
        return self._run(caller, "SELECT public.is_unclaimed_capture_object(%s);", (name,))[0][0]

    def listed(self, subject=None, min_age=0):
        return self._run("ingestion", "SELECT public.ingest_unclaimed_capture_objects(%s, %s);",
                         (subject, min_age))[0][0]


class EachCaptureHasAPathOfItsOwn(Base):

    def test_a_recording_is_written_under_its_job(self):
        job_id = self._run("Administrator", "SELECT public.start_capture_job('gateway', %s, NULL, 60, false);",
                           (self.gw,))[0][0]
        path = self._row("SELECT storage_path FROM public.capture_jobs WHERE id = %s;", (job_id,))[0]
        self.assertEqual(path, f"{self.gw_wire}/{job_id}.json")

    def test_an_upload_is_issued_a_path_under_its_subject(self):
        issued = self.begin()
        self.assertEqual(issued["storage_path"], f"{self.gw_wire}/{issued['upload_id']}.json")
        self.assertIsNone(issued["replaces_capture_id"])
        self.assertIsNone(issued["replaces_storage_path"])

    def test_register_repoints_the_row_and_leaves_the_old_file_unclaimed(self):
        old = self._capture()
        issued = self.begin(replace=True)
        self.assertEqual(issued["replaces_capture_id"], str(old))
        self.assertEqual(issued["replaces_storage_path"], f"{self.gw_wire}/capture.json")
        self._object(issued["storage_path"], size=3145)
        new = self.register(issued["storage_path"])
        self.assertEqual(self._captures_of_gateway(),
                         [(new, issued["storage_path"], 3145, "uploaded.json")])
        self.assertTrue(self.unclaimed(f"{self.gw_wire}/capture.json"),
                        "the replaced file is still claimed, so nothing may delete it")
        self.assertFalse(self.unclaimed(issued["storage_path"]))

    def test_a_repeated_register_answers_the_capture_it_made(self):
        issued = self.begin()
        self._object(issued["storage_path"])
        first = self.register(issued["storage_path"])
        self.assertEqual(self.register(issued["storage_path"]), first)

    def test_a_retried_finalise_answers_the_capture_it_made(self):
        job_id, _ = self._job()
        first = self._run("ingestion", "SELECT public.ingest_finalise_capture(%s, 10, 1, '{}');",
                          (job_id,))[0][0]
        again = self._run("ingestion", "SELECT public.ingest_finalise_capture(%s, 10, 1, '{}');",
                          (job_id,))[0][0]
        self.assertEqual(first, again)

    def test_a_path_begin_did_not_issue_is_refused(self):
        """Including <subject>/capture.json, the path the page uploaded to before 0190."""
        self._object(f"{self.gw_wire}/capture.json")
        with self.assertRaisesRegex(pg_errors.InvalidParameterValue, "begin_capture_upload"):
            self.register(f"{self.gw_wire}/capture.json")


class ReplaceIsDecidedFirst(Base):

    def test_an_upload_over_a_stored_capture_is_refused_unless_confirmed(self):
        self._capture()
        with self.assertRaisesRegex(pg_errors.UniqueViolation, "rare fault baseline - keep"):
            self.begin(replace=False)

    def test_an_upload_over_a_capture_the_page_did_not_show_is_refused(self):
        self._capture()
        with self.assertRaisesRegex(pg_errors.UniqueViolation, "changed after you chose"):
            self.begin(replace=True, expected=str(uuid.uuid4()))

    def test_an_upload_while_the_subject_records_is_refused(self):
        self._job(status="RECORDING")
        with self.assertRaisesRegex(pg_errors.UniqueViolation, "being recorded"):
            self.begin()

    def test_a_recording_queued_after_the_upload_began_refuses_the_register(self):
        issued = self.begin()
        self._object(issued["storage_path"])
        self._job(status="PENDING")
        with self.assertRaisesRegex(pg_errors.UniqueViolation, "being recorded"):
            self.register(issued["storage_path"])
        self.assertEqual(self._captures_of_gateway(), [])

    def test_a_stale_page_cannot_replace_a_capture_stored_since(self):
        """
        THE ONE THE AUDIT SAW. Operator 2's page showed no capture; operator 1 stored one; operator
        2's upload overwrote its file and the register answered 409, leaving the row describing the
        wrong bytes. Now the stale upload is refused and the stored capture's row and file stand.
        """
        stale = self.begin(caller="other")
        mine = self.begin()
        self._object(mine["storage_path"], size=1507)
        kept = self.register(mine["storage_path"])
        self._object(stale["storage_path"], size=3145)
        with self.assertRaises(pg_errors.UniqueViolation):
            self.register(stale["storage_path"], caller="other")
        self.assertEqual(self._captures_of_gateway(),
                         [(kept, mine["storage_path"], 1507, "uploaded.json")])
        self.assertTrue(self.unclaimed(stale["storage_path"]),
                        "the refused upload's file is still claimed")

    def test_a_capture_recorded_after_the_upload_began_is_kept(self):
        issued = self.begin()
        self._object(issued["storage_path"])
        recorded = self._capture(path=f"{self.gw_wire}/{uuid.uuid4()}.json", note="recorded since")
        with self.assertRaisesRegex(pg_errors.UniqueViolation, "recorded since"):
            self.register(issued["storage_path"])
        self.assertEqual([r[0] for r in self._captures_of_gateway()], [recorded])

    def test_an_upload_is_registered_only_by_whoever_began_it(self):
        issued = self.begin()
        self._object(issued["storage_path"])
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.register(issued["storage_path"], caller="other")

    def test_an_upload_expires_after_an_hour(self):
        issued = self.begin()
        self._object(issued["storage_path"])
        self.cur.execute("UPDATE public.capture_uploads SET created_at = now() - interval '61 minutes' "
                         "WHERE storage_path = %s;", (issued["storage_path"],))
        with self.assertRaisesRegex(pg_errors.InvalidParameterValue, "expired"):
            self.register(issued["storage_path"])


class NothingIsTakenOnTrust(Base):

    def test_there_must_be_an_object(self):
        issued = self.begin()
        with self.assertRaises(psycopg2.Error) as caught:
            self.register(issued["storage_path"])
        self.assertEqual(caught.exception.pgcode, "PGRST")
        self.assertIn("P0002", str(caught.exception))
        self.assertIn("no object", str(caught.exception))

    def test_the_size_is_the_objects(self):
        issued = self.begin()
        self._object(issued["storage_path"], size=3145)
        self.register(issued["storage_path"], size=10 ** 15)
        self.assertEqual(self._captures_of_gateway()[0][2], 3145)

    def test_a_message_count_the_file_cannot_hold_is_refused(self):
        issued = self.begin()
        self._object(issued["storage_path"], size=3145)
        with self.assertRaisesRegex(pg_errors.InvalidParameterValue, "cannot hold"):
            self.register(issued["storage_path"], count=2 ** 31 - 1)

    def test_a_manifest_over_64_kib_is_refused(self):
        issued = self.begin()
        self._object(issued["storage_path"])
        bloated = {"device_ids": [], "padding": "x" * (2 * 1024 * 1024)}
        with self.assertRaisesRegex(pg_errors.InvalidParameterValue, "manifest"):
            self.register(issued["storage_path"], manifest=bloated)

    def test_the_playback_gateway_and_its_lanes_are_not_subjects(self):
        lane, _ = self._lane()
        for kind, subject in (("gateway", PLAYBACK_GATEWAY), ("device", lane)):
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(pg_errors.InvalidParameterValue, "Playback gateway"):
                    self._run("Administrator",
                              "SELECT public.start_capture_job(%s, %s, NULL, 60, false);", (kind, subject))
                with self.assertRaisesRegex(pg_errors.InvalidParameterValue, "Playback gateway"):
                    self.begin(kind=kind, subject=subject)

    def _lane(self):
        """A replay lane of this suite's device, minted the one way a lane is (0187)."""
        capture = self._capture(kind="device", path=f"{self.dev_wire}/capture.json")
        self.cur.execute("UPDATE public.captures SET manifest = %s WHERE id = %s;",
                         (json.dumps({"device_ids": [self.dev_wire]}), capture))
        mapping = self._run("Administrator", "SELECT public.ensure_shadow_devices(%s);", (capture,))[0][0]
        lane_wire = mapping[self.dev_wire]
        return self._row("SELECT id FROM public.devices WHERE sparkplug_id = %s;", (lane_wire,))[0], lane_wire


class WhatNothingClaims(Base):
    """A file goes when nothing names it; until then nobody may delete it."""

    def test_each_claim_holds_the_file(self):
        path = f"{self.gw_wire}/held.json"
        self.assertTrue(self.unclaimed(path))
        claims = (
            ("a stored capture", "INSERT INTO public.captures (subject_kind, gateway_id, "
             "subject_sparkplug_id, storage_path, size_bytes, message_count) VALUES ('gateway', %s, "
             "%s, %s, 1, 1);", (self.gw, self.gw_wire, path)),
            ("an open upload", "INSERT INTO public.capture_uploads (subject_kind, gateway_id, "
             "subject_sparkplug_id, storage_path) VALUES ('gateway', %s, %s, %s);",
             (self.gw, self.gw_wire, path)),
        )
        for label, sql, args in claims:
            with self.subTest(claim=label):
                self.cur.execute("SAVEPOINT claim;")
                self.cur.execute(sql, args)
                self.assertFalse(self.unclaimed(path), f"{label} does not hold its file")
                self.cur.execute("ROLLBACK TO SAVEPOINT claim;")

        _, recording = self._job()
        self.assertFalse(self.unclaimed(recording), "a recording does not hold its file")

    def test_a_queued_or_running_playback_holds_its_file(self):
        capture = self._capture()
        path = f"{self.gw_wire}/capture.json"
        self.cur.execute("DELETE FROM public.captures WHERE id = %s;", (capture,))
        self.assertTrue(self.unclaimed(path))
        self.cur.execute(
            "INSERT INTO public.playback_jobs (capture_storage_path, target_gateway_id, "
            "target_edge_node_id, sparkplug_group, status) VALUES (%s, %s, 'gwy160000000000400080000', "
            "'Aber', 'PENDING');", (path, PLAYBACK_GATEWAY))
        self.assertFalse(self.unclaimed(path), "a queued playback would find its file gone")

    def test_an_upload_open_two_hours_no_longer_holds_its_file(self):
        issued = self.begin()
        self.cur.execute("UPDATE public.capture_uploads SET created_at = now() - interval '121 minutes' "
                         "WHERE storage_path = %s;", (issued["storage_path"],))
        self.assertTrue(self.unclaimed(issued["storage_path"]))

    def test_a_deleted_subjects_capture_is_listed_for_the_daemon_to_delete(self):
        """The user's decision: a capture is deleted with its subject."""
        self._capture()
        self._object(f"{self.gw_wire}/capture.json", age_seconds=7200)
        self.assertEqual(self.listed(self.gw_wire), [])
        self.cur.execute("DELETE FROM public.devices WHERE gateway_id = %s;", (self.gw,))
        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (self.gw,))
        self.assertEqual(self.listed(self.gw_wire), [f"{self.gw_wire}/capture.json"])
        self.assertIn(f"{self.gw_wire}/capture.json", self.listed(None, 3600))

    def test_a_fresh_orphan_waits_out_the_hour_unless_asked_for_by_subject(self):
        self._object(f"{self.gw_wire}/fresh.json", age_seconds=60)
        self.assertNotIn(f"{self.gw_wire}/fresh.json", self.listed(None, 3600))
        self.assertEqual(self.listed(self.gw_wire, 0), [f"{self.gw_wire}/fresh.json"])
        self.assertEqual(self.listed(self.dev_wire, 0), [])

    def test_only_the_daemon_asks_for_the_list(self):
        for caller in ("Administrator", "Shopfloor_Manager", "Auditor", "Operator", "playback"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._run(caller, "SELECT public.ingest_unclaimed_capture_objects(NULL, 0);")

    def test_an_operator_learns_nothing_and_anon_may_not_ask(self):
        self.assertFalse(self.unclaimed(f"{self.gw_wire}/x.json", caller="Operator"))
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._run("anon", "SELECT public.is_unclaimed_capture_object('x');")


class TheBucketPolicies(Base):
    """The broker-captures policies from storage-policies.sql, verbatim, on a stand-in table."""

    def setUp(self):
        super().setUp()
        self.cur.execute(f"CREATE SCHEMA {PROBE};")
        self.cur.execute(
            f"CREATE TABLE {PROBE}.objects (bucket_id text NOT NULL, name text NOT NULL, metadata jsonb);")
        self.cur.execute(
            f"CREATE FUNCTION {PROBE}.foldername(name text) RETURNS text[] LANGUAGE plpgsql AS $f$ "
            "DECLARE _parts text[]; BEGIN SELECT string_to_array(name, '/') INTO _parts; "
            "RETURN _parts[1:array_length(_parts, 1) - 1]; END $f$;")
        self.cur.execute(f"ALTER TABLE {PROBE}.objects ENABLE ROW LEVEL SECURITY;")
        self.cur.execute(f"GRANT USAGE ON SCHEMA {PROBE} TO authenticated;")
        self.cur.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {PROBE}.objects TO authenticated;")
        with open(STORAGE_POLICIES, encoding="utf-8") as f:
            text = f.read()
        start = text.index("-- broker-captures:")
        block = text[start:text.index("DO $$", start)]
        block = block.replace("storage.objects", PROBE + ".objects").replace("storage.foldername",
                                                                             PROBE + ".foldername")
        self.assertNotIn("storage.", block)
        self.cur.execute(block)

        self.stored = f"{self.gw_wire}/capture.json"
        self._capture(path=self.stored)
        self.orphan = f"{self.gw_wire}/orphan.json"
        for name in (self.stored, self.orphan):
            self.cur.execute(f"INSERT INTO {PROBE}.objects (bucket_id, name) VALUES ('broker-captures', %s);",
                             (name,))

    def _inserts(self, caller, name):
        try:
            self._run(caller, f"INSERT INTO {PROBE}.objects (bucket_id, name) VALUES ('broker-captures', %s);",
                      (name,))
            return True
        except pg_errors.InsufficientPrivilege:
            return False

    def _deletes(self, caller, name):
        self.cur.execute("SAVEPOINT del;")
        try:
            return self._run(caller, f"DELETE FROM {PROBE}.objects WHERE bucket_id = 'broker-captures' "
                                     "AND name = %s;", (name,)) == 1
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT del;")

    def _sees(self, caller, name):
        return self._run(caller, f"SELECT count(*) FROM {PROBE}.objects WHERE name = %s;", (name,))[0][0] == 1

    def test_a_person_writes_only_the_path_issued_to_them(self):
        issued = self.begin(replace=True)
        self.assertTrue(self._inserts("Shopfloor_Manager", issued["storage_path"]))
        for caller, name in (
            ("Shopfloor_Manager", f"{self.gw_wire}/capture.json"),
            ("Shopfloor_Manager", f"{self.gw_wire}/anything.json"),
            ("Administrator", issued["storage_path"]),
            ("other", issued["storage_path"]),
        ):
            with self.subTest(caller=caller, name=name):
                self.assertFalse(self._inserts(caller, name))

    def test_a_registered_upload_cannot_be_written_again(self):
        issued = self.begin(replace=True)
        self.cur.execute("INSERT INTO storage.objects (bucket_id, name, metadata) "
                         "VALUES ('broker-captures', %s, '{\"size\": 2048}');", (issued["storage_path"],))
        self.register(issued["storage_path"])
        self.assertFalse(self._inserts("Shopfloor_Manager", issued["storage_path"] + ".again"))
        updated = self._run("Shopfloor_Manager", f"UPDATE {PROBE}.objects SET metadata = '{{}}' "
                                                 "WHERE name = %s;", (issued["storage_path"],))
        self.assertEqual(updated, 0)

    def test_nobody_deletes_a_file_a_capture_names(self):
        for caller in ("Administrator", "Shopfloor_Manager", "Auditor", "Operator", "ingestion", "playback"):
            with self.subTest(caller=caller):
                self.assertFalse(self._deletes(caller, self.stored))

    def test_the_writers_and_the_daemon_delete_an_orphan_and_nobody_else_does(self):
        expected = {"Administrator": True, "Shopfloor_Manager": True, "ingestion": True,
                    "Auditor": False, "Operator": False, "playback": False}
        for caller, allowed in expected.items():
            with self.subTest(caller=caller):
                self.assertEqual(self._deletes(caller, self.orphan), allowed)

    def test_the_daemon_sees_an_orphan_but_not_a_stored_capture(self):
        self.assertTrue(self._sees("ingestion", self.orphan))
        self.assertFalse(self._sees("ingestion", self.stored))


class TheDaemonIsToldWhatHappened(Base):

    def report(self, job_id):
        return self._run("ingestion", "SELECT public.ingest_report_capture_progress(%s, 3, 300, 2, true);",
                         (job_id,))[0][0]

    def test_continue_stop_ended_and_gone(self):
        job_id, _ = self._job()
        self.assertEqual(self.report(job_id), "continue")
        self.cur.execute("UPDATE public.capture_jobs SET stop_requested = true WHERE id = %s;", (job_id,))
        self.assertEqual(self.report(job_id), "stop")
        self.cur.execute("UPDATE public.capture_jobs SET status = 'CANCELLED' WHERE id = %s;", (job_id,))
        self.assertEqual(self.report(job_id), "ended")
        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (self.gw,))
        self.assertEqual(self.report(job_id), "gone", "a deleted subject reads as a stop request")

    def test_the_previous_gate_still_answers_a_daemon_of_the_last_release(self):
        missing = str(uuid.uuid4())
        self.assertIs(self._run("ingestion", "SELECT public.ingest_capture_progress(%s, 0, 0, 0, false);",
                                (missing,))[0][0], True)

    def test_only_the_daemon_reports(self):
        job_id, _ = self._job()
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._run("Administrator", "SELECT public.ingest_report_capture_progress(%s, 0, 0, 0, false);",
                      (job_id,))


class StopEndsAStaleRecording(Base):

    def stop(self, job_id):
        return self._run("Shopfloor_Manager", "SELECT public.request_capture_stop(%s);", (job_id,))[0][0]

    def status(self, job_id):
        return self._row("SELECT status, stop_requested, error FROM public.capture_jobs WHERE id = %s;",
                         (job_id,))

    def test_a_recording_that_reports_is_asked_to_finish(self):
        job_id, _ = self._job(started_ago=30, elapsed=29)
        self.assertTrue(self.stop(job_id))
        self.assertEqual(self.status(job_id)[:2], ("RECORDING", True))

    def test_a_recording_silent_for_two_minutes_is_ended_with_nothing_stored(self):
        """A daemon whose last write failed leaves the job RECORDING, and the single-flight index
        then refuses every capture on the stack. Stop ends it."""
        old = self._capture()
        job_id, _ = self._job(started_ago=600, elapsed=40)
        self.assertTrue(self.stop(job_id))
        status, stop_requested, error = self.status(job_id)
        self.assertEqual((status, stop_requested), ("CANCELLED", True))
        self.assertIn("had not reported", error)
        self.assertEqual([r[0] for r in self._captures_of_gateway()], [old])
        self.assertEqual(self._run("ingestion", "SELECT public.ingest_report_capture_progress("
                                                "%s, 0, 0, 0, false);", (job_id,))[0][0], "ended")


class ASweptJobSaysWhetherItStarted(Base):

    def reconcile(self):
        return self._run("ingestion", "SELECT public.ingest_reconcile_capture_jobs();")[0][0]

    def test_a_queued_job_never_started(self):
        job_id, _ = self._job(status="PENDING")
        self.assertEqual(self.reconcile(), 1)
        error = self._row("SELECT error FROM public.capture_jobs WHERE id = %s;", (job_id,))[0]
        self.assertIn("never started", error)
        self.assertNotIn("did not survive", error)

    def test_a_recording_job_did_not_survive(self):
        job_id, _ = self._job(status="RECORDING")
        self.assertEqual(self.reconcile(), 1)
        error = self._row("SELECT error FROM public.capture_jobs WHERE id = %s;", (job_id,))[0]
        self.assertIn("did not survive", error)


class NothingToReplay(Base):

    def lanes(self, capture):
        with self.assertRaises(psycopg2.Error) as caught:
            self._run("Administrator", "SELECT public.ensure_shadow_devices(%s);", (capture,))
        self.assertEqual(caught.exception.pgcode, "PGRST")
        return str(caught.exception)

    def test_a_device_capture_with_none_of_its_devices_messages_says_so(self):
        capture = self._capture(kind="device", path=f"{self.dev_wire}/capture.json")
        message = self.lanes(capture)
        self.assertIn(f"of device {self.dev_wire} holds none of that device", message)
        self.assertNotIn("gateway-scoped", message)

    def test_a_gateway_capture_with_no_devices_says_so(self):
        message = self.lanes(self._capture())
        self.assertIn("names no devices", message)

    def test_a_device_this_stack_does_not_know_is_from_elsewhere(self):
        capture = self._capture()
        self.cur.execute("UPDATE public.captures SET manifest = %s WHERE id = %s;",
                         (json.dumps({"device_ids": ["dev999999999999999999999"]}), capture))
        with self.assertRaisesRegex(pg_errors.ForeignKeyViolation, "another site"):
            self._run("Administrator", "SELECT public.ensure_shadow_devices(%s);", (capture,))


if __name__ == "__main__":
    unittest.main(verbosity=2)
