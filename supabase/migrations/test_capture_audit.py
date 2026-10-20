"""
Captures and replays leave an audit trail, and a playback's history outlives its target (0193).

    python supabase/migrations/test_capture_audit.py

Requires the Supabase database (54322 by default) with the chain applied, and supabase_admin (the
same password) for the upload tests, which need a stand-in for storage.objects: the db lane has no
storage-api, so the table does not exist there. Those tests skip themselves where it does exist.

Four things are held here:

  * each capture and playback act writes one audit row, in the asset lane, naming who did it and
    what it acted on: starting and stopping a recording, storing an upload or a recording, issuing
    a download link, deleting a capture (by hand, by a replacement, or with its subject), starting
    and stopping a playback. A refused act, a repeated call and a progress report write none;
  * a gateway a playback names cannot be deleted, nor can the last unarchived Playback gateway, for
    any role; such a gateway can still be archived, and the nightly purge skips it;
  * ending a RUNNING playback sets the Playback gateway and its lanes OFFLINE, as an applied NDEATH
    does, and a finish for a job that already ended changes nothing;
  * the rows are readable by the roles that read captures, and not by an Operator.

Every test rolls back.
"""
import json
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors
from psycopg2.extras import RealDictCursor

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_ADMIN_USER = os.getenv("SUPABASE_DB_ADMIN_USER", "supabase_admin")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-00000000a930",
    "Shopfloor_Manager": "00000000-0000-4000-8000-00000000a933",
    "Auditor": "00000000-0000-4000-8000-00000000a934",
    "Operator": "00000000-0000-4000-8000-00000000a935",
}
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"
PLAYBACK_GATEWAY = "16000000-0000-4000-8000-000000000001"

ROW = ("SELECT action, entity_type, new_data, changed_by::text AS changed_by, actor_source, "
       "audit_domain, causation_id FROM public.audit_trail WHERE entity_id = %s ORDER BY id;")


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
            cur.execute("SELECT to_regprocedure('public.issue_capture_download(text)');")
            applied = cur.fetchone()[0]
        finally:
            conn.rollback()
            conn.close()
        if not applied:
            raise unittest.SkipTest("0193_captures_and_replays_leave_an_audit_trail.sql has not been applied")

    def setUp(self):
        self.conn = connect()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor(cursor_factory=RealDictCursor)
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"capture-audit-{user_id[-4:]}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )
        # Nothing else in flight: the single-flight and one-per-target indexes.
        self.cur.execute("UPDATE public.capture_jobs SET status = 'FAILED', finished_at = now() "
                         "WHERE status IN ('PENDING', 'RECORDING');")
        self.cur.execute("UPDATE public.playback_jobs SET status = 'FAILED', finished_at = now() "
                         "WHERE status IN ('PENDING', 'RUNNING');")
        self.gw, self.gw_wire = self._gateway()
        self.dev, self.dev_wire = self._device(self.gw)

    # -- fixtures, as the owner ---------------------------------------------------------------

    def _gateway(self, simulated=False, shadow=False, archived=False):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, "
            "is_shadow, is_archived, archived_at) VALUES (%s, %s, 'cell', %s, %s, %s, %s, "
            "CASE WHEN %s THEN now() END) RETURNING sparkplug_id;",
            (gid, f"Test_Audit_GW_{gid[:8]}", "host" if simulated else "remote", simulated, shadow,
             archived, archived),
        )
        return gid, self.cur.fetchone()["sparkplug_id"]

    def _device(self, gateway_id, shadow_of=None, status="OFFLINE"):
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, shadow_of, status, first_dbirth_at) "
            "VALUES (%s, %s, %s, %s, %s, CASE WHEN %s = 'ONLINE' THEN now() END) "
            "RETURNING sparkplug_id;",
            (did, f"Test_Audit_Dev_{did[:8]}", gateway_id, shadow_of, status, status),
        )
        return did, self.cur.fetchone()["sparkplug_id"]

    def _capture(self, kind="gateway", note="kept for the fault study", device_ids=()):
        wire = self.gw_wire if kind == "gateway" else self.dev_wire
        path = f"{wire}/{uuid.uuid4()}.json"
        self.cur.execute(
            "INSERT INTO public.captures (subject_kind, gateway_id, device_id, subject_sparkplug_id, "
            "storage_path, size_bytes, message_count, note, manifest) "
            "VALUES (%s, %s, %s, %s, %s, 1507, 4, %s, %s::jsonb) RETURNING id::text AS id;",
            (kind, self.gw, None if kind == "gateway" else self.dev, wire, path, note,
             json.dumps({"device_ids": list(device_ids)})),
        )
        return self.cur.fetchone()["id"], path

    def _capture_job(self, status="RECORDING", started_ago=1, elapsed=1, stop_requested=False):
        jid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.capture_jobs (id, subject_kind, gateway_id, sparkplug_group, "
            "edge_node_id, subject_sparkplug_id, storage_path, status, started_at, elapsed_seconds, "
            "stop_requested, requested_by, note, messages) "
            "VALUES (%s, 'gateway', %s, 'Aber', %s, %s, %s, %s, "
            "CASE WHEN %s = 'PENDING' THEN NULL ELSE now() - make_interval(secs => %s) END, %s, %s, "
            "%s, 'line 3 start-up', 12);",
            (jid, self.gw, self.gw_wire, self.gw_wire, f"{self.gw_wire}/{jid}.json", status, status,
             started_ago, elapsed, stop_requested, PEOPLE["Shopfloor_Manager"]),
        )
        return jid

    def _playback_job(self, status="RUNNING", capture_id=None, reported_ago="1 second",
                      target=PLAYBACK_GATEWAY):
        jid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.playback_jobs (id, capture_id, capture_storage_path, target_gateway_id, "
            "  target_edge_node_id, sparkplug_group, status, started_at, progress_reported_at, "
            "  messages_sent, messages_total) "
            "SELECT %s, %s, %s, id, sparkplug_id, coalesce(sparkplug_group, 'Aber'), %s, "
            "       CASE WHEN %s = 'PENDING' THEN NULL ELSE now() - interval '5 seconds' END, "
            "       now() - %s::interval, 3, 9 "
            "  FROM public.gateways WHERE id = %s;",
            (jid, capture_id, f"{self.gw_wire}/{uuid.uuid4()}.json", status, status, reported_ago,
             target),
        )
        self.assertEqual(self.cur.rowcount, 1, "the target gateway is missing")
        return jid

    def _audit(self, entity_id):
        self.cur.execute(ROW, (entity_id,))
        return self.cur.fetchall()

    def _one(self, entity_id, action):
        rows = [r for r in self._audit(entity_id) if r["action"] == action]
        self.assertEqual(len(rows), 1, f"expected one {action} row for {entity_id}, found {len(rows)}")
        return rows[0]

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

    def _value(self, caller, sql, args=()):
        rows = self._run(caller, sql, args)
        return next(iter(rows[0].values()))


class RecordingIsAudited(Base):

    def test_starting_a_recording_writes_one_row_naming_the_subject_and_the_person(self):
        job = self._value("Shopfloor_Manager",
                          "SELECT public.start_capture_job('gateway', %s, 'before the retrofit', 60, false);",
                          (self.gw,))
        row = self._one(job, "CAPTURE_STARTED")
        self.assertEqual((row["entity_type"], row["changed_by"], row["actor_source"], row["audit_domain"]),
                         ("capture_jobs", PEOPLE["Shopfloor_Manager"], "user", "asset"))
        self.assertEqual(row["new_data"]["sparkplug_id"], self.gw_wire)
        self.assertEqual(row["new_data"]["name"], f"Test_Audit_GW_{self.gw[:8]}")
        self.assertEqual(row["new_data"]["note"], "before the retrofit")
        self.assertEqual(row["new_data"]["max_seconds"], 60)
        self.assertIsNone(row["new_data"]["replaces_capture_id"])

    def test_recording_again_names_the_capture_it_would_replace(self):
        old, _ = self._capture()
        job = self._value("Administrator",
                          "SELECT public.start_capture_job('gateway', %s, NULL, 60, true);", (self.gw,))
        self.assertEqual(self._one(job, "CAPTURE_STARTED")["new_data"]["replaces_capture_id"], old)

    def test_a_refused_start_writes_nothing(self):
        self._capture()
        before = self._count("CAPTURE_STARTED")
        with self.assertRaises(pg_errors.UniqueViolation):
            self._run("Shopfloor_Manager", "SELECT public.start_capture_job('gateway', %s, NULL, 60, false);",
                      (self.gw,))
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._run("Operator", "SELECT public.start_capture_job('gateway', %s, NULL, 60, true);",
                      (self.gw,))
        self.assertEqual(self._count("CAPTURE_STARTED"), before)

    def test_cancelling_a_queued_recording_is_one_row(self):
        job = self._capture_job(status="PENDING")
        self.assertIs(self._value("Shopfloor_Manager", "SELECT public.request_capture_stop(%s);", (job,)), True)
        row = self._one(job, "CAPTURE_STOPPED")
        self.assertEqual((row["new_data"]["status_before"], row["new_data"]["stop"]),
                         ("PENDING", "cancelled before the daemon claimed it"))
        self.assertEqual(row["changed_by"], PEOPLE["Shopfloor_Manager"])

    def test_asking_twice_writes_one_row(self):
        job = self._capture_job()
        self._run("Shopfloor_Manager", "SELECT public.request_capture_stop(%s);", (job,))
        self._run("Administrator", "SELECT public.request_capture_stop(%s);", (job,))
        row = self._one(job, "CAPTURE_STOPPED")
        self.assertEqual((row["new_data"]["status_before"], row["new_data"]["stop"], row["new_data"]["messages"]),
                         ("RECORDING", "stop requested", 12))

    def test_a_stale_recording_ended_here_says_so(self):
        job = self._capture_job(started_ago=600, elapsed=10)
        self._run("Shopfloor_Manager", "SELECT public.request_capture_stop(%s);", (job,))
        self.assertIn("had not reported for", self._one(job, "CAPTURE_STOPPED")["new_data"]["stop"])

    def test_stopping_a_finished_recording_writes_nothing(self):
        job = self._capture_job(status="COMPLETED")
        self.assertIs(self._value("Shopfloor_Manager", "SELECT public.request_capture_stop(%s);", (job,)), False)
        self.assertEqual(self._audit(job), [])

    def test_progress_is_not_audited(self):
        job = self._capture_job()
        for _ in range(3):
            self._run("ingestion",
                      "SELECT public.ingest_report_capture_progress(%s, 40, 4096, 2, true);", (job,))
        self.assertEqual(self._audit(job), [])

    def test_a_finished_recording_is_recorded_by_the_daemon_naming_who_asked(self):
        old, _ = self._capture()
        job = self._capture_job()
        new = self._value("ingestion", "SELECT public.ingest_finalise_capture(%s, 9000, 40, '{}')::text;", (job,))
        row = self._one(new, "CAPTURE_RECORDED")
        self.assertEqual((row["entity_type"], row["actor_source"], row["changed_by"]),
                         ("captures", "ingestion", INGESTION))
        self.assertEqual(row["new_data"]["capture_job_id"], job)
        self.assertEqual(row["new_data"]["requested_by"], PEOPLE["Shopfloor_Manager"])
        self.assertEqual(row["new_data"]["replaced_capture_id"], old)
        self.assertEqual((row["new_data"]["message_count"], row["new_data"]["size_bytes"]), (40, 9000))

        gone = self._one(old, "CAPTURE_DELETED")
        self.assertEqual((gone["new_data"]["reason"], gone["new_data"]["capture_job_id"]),
                         ("replaced by a recording", job))
        self.assertEqual(gone["new_data"]["note"], "kept for the fault study")
        self.assertEqual(gone["causation_id"], row["causation_id"], "the replacement is one act")

        # The daemon retries a finalise whose answer was lost: no second row.
        self._run("ingestion", "SELECT public.ingest_finalise_capture(%s, 9000, 40, '{}');", (job,))
        self.assertEqual(len(self._audit(new)), 1)

    def _count(self, action):
        self.cur.execute("SELECT count(*) AS n FROM public.audit_trail WHERE action = %s;", (action,))
        return self.cur.fetchone()["n"]


class DeletingACaptureIsAudited(Base):

    def test_a_person_s_delete_is_one_row_with_the_capture_s_last_properties(self):
        capture, path = self._capture()
        self.assertEqual(self._run("Shopfloor_Manager", "DELETE FROM public.captures WHERE id = %s;", (capture,)), 1)
        row = self._one(capture, "CAPTURE_DELETED")
        self.assertEqual((row["changed_by"], row["actor_source"], row["audit_domain"]),
                         (PEOPLE["Shopfloor_Manager"], "user", "asset"))
        data = row["new_data"]
        self.assertEqual((data["reason"], data["storage_path"], data["message_count"], data["sparkplug_id"]),
                         ("deleted", path, 4, self.gw_wire))

    def test_a_delete_the_policy_refuses_writes_nothing(self):
        capture, _ = self._capture()
        self.assertEqual(self._run("Auditor", "DELETE FROM public.captures WHERE id = %s;", (capture,)), 0)
        self.assertEqual(self._audit(capture), [])

    def test_deleting_a_gateway_writes_one_row_for_each_capture_it_takes(self):
        """
        Both captures go: the gateway's own, and its device's, whose row names the gateway it was
        recorded through. The subject's name is gone with it; its sparkplug_id stays.
        """
        gateway_capture, _ = self._capture()
        device_capture, _ = self._capture(kind="device")
        self._run("Shopfloor_Manager", "DELETE FROM public.gateways WHERE id = %s;", (self.gw,))
        for capture, wire in ((gateway_capture, self.gw_wire), (device_capture, self.dev_wire)):
            row = self._one(capture, "CAPTURE_DELETED")
            self.assertEqual(row["new_data"]["reason"], "deleted with its gateway")
            self.assertEqual(row["new_data"]["sparkplug_id"], wire)
            self.assertEqual(row["changed_by"], PEOPLE["Shopfloor_Manager"])

    def test_deleting_a_device_says_so(self):
        capture, _ = self._capture(kind="device")
        self._run("Administrator", "DELETE FROM public.devices WHERE id = %s;", (self.dev,))
        row = self._one(capture, "CAPTURE_DELETED")
        self.assertEqual(row["new_data"]["reason"], "deleted with its device")
        self.assertIsNone(row["new_data"]["name"])


class DownloadingIsAudited(Base):

    def test_the_link_is_recorded_and_the_path_answered(self):
        capture, path = self._capture()
        for role in ("Administrator", "Shopfloor_Manager", "Auditor"):
            with self.subTest(role=role):
                self.assertEqual(self._value(role, "SELECT public.issue_capture_download(%s);", (path,)), path)
        rows = [r for r in self._audit(capture) if r["action"] == "CAPTURE_DOWNLOAD_ISSUED"]
        self.assertEqual([r["changed_by"] for r in rows],
                         [PEOPLE["Administrator"], PEOPLE["Shopfloor_Manager"], PEOPLE["Auditor"]])
        self.assertEqual(rows[0]["new_data"]["storage_path"], path)
        self.assertEqual(rows[0]["audit_domain"], "asset")

    def test_an_operator_is_refused_and_nothing_is_recorded(self):
        capture, path = self._capture()
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._run("Operator", "SELECT public.issue_capture_download(%s);", (path,))
        self.assertEqual(self._audit(capture), [])

    def test_a_path_no_capture_names_is_not_found(self):
        with self.assertRaisesRegex(psycopg2.Error, "no stored capture is at"):
            self._run("Shopfloor_Manager", "SELECT public.issue_capture_download(%s);",
                      (f"{self.gw_wire}/{uuid.uuid4()}.json",))

    def test_anon_may_not_call_it(self):
        _, path = self._capture()
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._run("anon", "SELECT public.issue_capture_download(%s);", (path,))


class UploadingIsAudited(Base):
    """register_uploaded_capture() reads the object's size, so storage.objects needs a stand-in."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        conn = connect()
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regclass('storage.objects');")
            exists = cur.fetchone()[0]
        finally:
            conn.rollback()
            conn.close()
        if exists:
            raise unittest.SkipTest("storage.objects exists here; these tests run in the db lane")
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

    def _upload(self, replace=True):
        issued = self._value("Shopfloor_Manager", "SELECT public.begin_capture_upload('gateway', %s, %s, NULL);",
                             (self.gw, replace))
        self.cur.execute("INSERT INTO storage.objects (bucket_id, name, metadata) "
                         "VALUES ('broker-captures', %s, '{\"size\": 3145}'::jsonb);", (issued["storage_path"],))
        register = ("SELECT public.register_uploaded_capture('gateway', %s, %s, 1, 4, "
                    "'{\"device_ids\": []}'::jsonb, 'from the commissioning laptop', %s)::text;")
        return issued, lambda: self._value("Shopfloor_Manager", register, (self.gw, issued["storage_path"], replace))

    def test_an_upload_is_one_row_and_the_capture_it_replaced_says_so(self):
        old, _ = self._capture()
        issued, register = self._upload()
        new = register()
        row = self._one(new, "CAPTURE_UPLOADED")
        self.assertEqual((row["changed_by"], row["actor_source"]), (PEOPLE["Shopfloor_Manager"], "user"))
        self.assertEqual((row["new_data"]["size_bytes"], row["new_data"]["note"], row["new_data"]["replaced_capture_id"]),
                         (3145, "from the commissioning laptop", old))
        gone = self._one(old, "CAPTURE_DELETED")
        self.assertEqual((gone["new_data"]["reason"], gone["new_data"]["upload_id"]),
                         ("replaced by an upload", str(issued["upload_id"])))
        self.assertEqual(gone["causation_id"], row["causation_id"])

        # A repeated register answers the same capture and records nothing more.
        self.assertEqual(register(), new)
        self.assertEqual(len(self._audit(new)), 1)

    def test_the_setting_does_not_outlive_the_swap(self):
        """A delete later in the same transaction is a person's delete, not a replacement."""
        self._capture()
        _, register = self._upload()
        new = register()
        self._run("Shopfloor_Manager", "DELETE FROM public.captures WHERE id = %s;", (new,))
        self.assertEqual(self._one(new, "CAPTURE_DELETED")["new_data"]["reason"], "deleted")


class PlaybackIsAudited(Base):

    def setUp(self):
        super().setUp()
        self.lane, self.lane_wire = self._device(PLAYBACK_GATEWAY, shadow_of=self.dev)
        self.cur.execute("SELECT public.record_gateway_credential_issued_by_service(%s);", (PLAYBACK_GATEWAY,))
        self.capture, self.path = self._capture(device_ids=[self.dev_wire])

    START = "SELECT public.start_playback_job(%s, %s, %s::jsonb, 2.0)::text;"

    def test_starting_a_playback_names_the_capture_and_the_target(self):
        job = self._value("Shopfloor_Manager", self.START,
                          (self.capture, PLAYBACK_GATEWAY, json.dumps({self.dev_wire: self.lane_wire})))
        row = self._one(job, "PLAYBACK_STARTED")
        data = row["new_data"]
        self.assertEqual((row["entity_type"], row["changed_by"], row["audit_domain"]),
                         ("playback_jobs", PEOPLE["Shopfloor_Manager"], "asset"))
        self.assertEqual((data["capture_id"], data["capture_storage_path"], data["sparkplug_id"]),
                         (self.capture, self.path, self.gw_wire))
        self.assertEqual((data["target_gateway_id"], data["device_map"], float(data["speed"])),
                         (PLAYBACK_GATEWAY, {self.dev_wire: self.lane_wire}, 2.0))

    def test_a_refused_start_writes_nothing(self):
        before = self._audit(self.capture)
        with self.assertRaisesRegex(pg_errors.ForeignKeyViolation, "not an active device"):
            self._run("Shopfloor_Manager", self.START,
                      (self.capture, PLAYBACK_GATEWAY, json.dumps({self.dev_wire: self.dev_wire})))
        self.cur.execute("SELECT count(*) AS n FROM public.audit_trail WHERE action = 'PLAYBACK_STARTED' "
                         "AND new_data ->> 'capture_id' = %s;", (self.capture,))
        self.assertEqual(self.cur.fetchone()["n"], 0)
        self.assertEqual(self._audit(self.capture), before)

    def test_the_credential_refusal_no_longer_sends_the_operator_for_the_worker_s_password(self):
        target, _ = self._gateway(simulated=True)
        with self.assertRaises(pg_errors.CheckViolation) as refused:
            self._run("Shopfloor_Manager", self.START, (self.capture, target, "{}"))
        message = str(refused.exception)
        self.assertIn("holds no broker credential", message)
        self.assertIn("delivers the password", message)
        self.assertNotIn("how you obtain", message)

    def test_stopping_a_playback_is_one_row_and_progress_is_none(self):
        job = self._playback_job(capture_id=self.capture)
        self._run("playback", "SELECT public.playback_progress(%s, 4, 9, 2);", (job,))
        self._run("Shopfloor_Manager", "SELECT public.request_playback_stop(%s);", (job,))
        self._run("Administrator", "SELECT public.request_playback_stop(%s);", (job,))
        row = self._one(job, "PLAYBACK_STOPPED")
        self.assertEqual(len(self._audit(job)), 1, "progress or the second Stop wrote a row")
        self.assertEqual((row["new_data"]["stop"], row["new_data"]["messages_sent"], row["new_data"]["capture_id"]),
                         ("stop requested", 4, self.capture))

    def test_a_stop_after_the_capture_was_deleted_still_names_its_subject(self):
        job = self._playback_job(status="PENDING", capture_id=self.capture)
        self.cur.execute("DELETE FROM public.captures WHERE id = %s;", (self.capture,))
        self._run("Shopfloor_Manager", "SELECT public.request_playback_stop(%s);", (job,))
        row = self._one(job, "PLAYBACK_STOPPED")
        self.assertEqual((row["new_data"]["sparkplug_id"], row["new_data"]["stop"]),
                         (self.gw_wire, "cancelled before the worker claimed it"))

    def test_the_rows_are_read_by_the_roles_that_read_captures(self):
        job = self._value("Shopfloor_Manager", self.START,
                          (self.capture, PLAYBACK_GATEWAY, json.dumps({self.dev_wire: self.lane_wire})))
        query = "SELECT count(*) AS n FROM public.audit_trail WHERE entity_id = %s;"
        for role, seen in (("Administrator", 1), ("Shopfloor_Manager", 1), ("Auditor", 1), ("Operator", 0)):
            with self.subTest(role=role):
                self.assertEqual(self._value(role, query, (job,)), seen)


class APlaybackGatewayKeepsItsHistory(Base):

    DELETE = "DELETE FROM public.gateways WHERE id = %s;"

    def test_the_last_playback_gateway_cannot_be_deleted(self):
        for caller in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(caller=caller):
                with self.assertRaisesRegex(pg_errors.RestrictViolation, "is the Playback gateway"):
                    self._run(caller, self.DELETE, (PLAYBACK_GATEWAY,))
        with self.assertRaises(pg_errors.RestrictViolation):
            self.cur.execute(self.DELETE, (PLAYBACK_GATEWAY,))

    def test_a_gateway_with_replay_history_cannot_be_deleted_by_anyone(self):
        """THE BUG. Measured before 0193: the delete took playback_jobs from one row to none."""
        second, _ = self._gateway(simulated=True, shadow=True)
        job = self._playback_job(status="COMPLETED", target=second)
        for caller in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(caller=caller):
                with self.assertRaisesRegex(pg_errors.ForeignKeyViolation, "1 playback"):
                    self._run(caller, self.DELETE, (second,))
        self.cur.execute("SAVEPOINT owner;")
        with self.assertRaises(pg_errors.ForeignKeyViolation):
            self.cur.execute(self.DELETE, (second,))
        self.cur.execute("ROLLBACK TO SAVEPOINT owner;")
        self.cur.execute("SELECT count(*) AS n FROM public.playback_jobs WHERE id = %s;", (job,))
        self.assertEqual(self.cur.fetchone()["n"], 1)

    def test_it_can_still_be_archived_and_its_replays_stay_linked(self):
        second, _ = self._gateway(simulated=True, shadow=True)
        job = self._playback_job(status="COMPLETED", target=second)
        self.assertEqual(self._run("Shopfloor_Manager",
                                   "UPDATE public.gateways SET is_archived = true, archived_at = now() "
                                   "WHERE id = %s;", (second,)), 1)
        self.cur.execute("SELECT target_gateway_id::text AS t FROM public.playback_jobs WHERE id = %s;", (job,))
        self.assertEqual(self.cur.fetchone()["t"], second)

    def test_a_second_playback_gateway_without_history_can_be_deleted(self):
        second, _ = self._gateway(simulated=True, shadow=True)
        self.assertEqual(self._run("Shopfloor_Manager", self.DELETE, (second,)), 1)

    def test_an_ordinary_gateway_is_deleted_as_before(self):
        self.assertEqual(self._run("Shopfloor_Manager", self.DELETE, (self.gw,)), 1)

    def test_the_nightly_purge_skips_a_gateway_with_replay_history(self):
        """
        One transaction: a refused delete would abort the purge of every archive that is due. The
        job's own text is run, as pg_cron runs it, as the owner.
        """
        kept, _ = self._gateway(simulated=True, shadow=True, archived=True)
        self._playback_job(status="COMPLETED", target=kept)
        purged, _ = self._gateway(archived=True)
        self.cur.execute("UPDATE public.gateways SET auto_delete_at = now() - interval '1 day' "
                         "WHERE id IN (%s, %s);", (kept, purged))
        self.cur.execute("SELECT command FROM cron.job WHERE jobname = 'purge_expired_archives';")
        self.cur.execute(self.cur.fetchone()["command"])
        self.cur.execute("SELECT id::text AS id FROM public.gateways WHERE id IN (%s, %s);", (kept, purged))
        self.assertEqual([r["id"] for r in self.cur.fetchall()], [kept])


class APlaybackEndsItsSession(Base):
    """playback_finish() makes the change an applied NDEATH makes, since the broker sent none."""

    def setUp(self):
        super().setUp()
        self.lane, _ = self._device(PLAYBACK_GATEWAY, shadow_of=self.dev, status="ONLINE")
        self.cur.execute("UPDATE public.gateways SET status = 'ONLINE', last_heartbeat = now() "
                         "WHERE id = %s;", (PLAYBACK_GATEWAY,))

    def _state(self):
        self.cur.execute("SELECT (SELECT status FROM public.gateways WHERE id = %s) AS gateway, "
                         "(SELECT status FROM public.devices WHERE id = %s) AS lane;",
                         (PLAYBACK_GATEWAY, self.lane))
        row = self.cur.fetchone()
        return row["gateway"], row["lane"]

    def _finish(self, job, error=None):
        self._run("playback", "SELECT public.playback_finish(%s, 3, %s, 0);", (job, error))

    def test_a_lost_connection_leaves_the_gateway_and_its_lanes_offline(self):
        job = self._playback_job()
        self._finish(job, "publishing stopped after 3 message(s): the broker connection was lost")
        self.assertEqual(self._state(), ("OFFLINE", "OFFLINE"))

    def test_every_terminal_state_does_it(self):
        for stop_requested, error in ((False, None), (True, None)):
            with self.subTest(stop_requested=stop_requested):
                self.cur.execute("SAVEPOINT outcome;")
                job = self._playback_job()
                self.cur.execute("UPDATE public.playback_jobs SET stop_requested = %s WHERE id = %s;",
                                 (stop_requested, job))
                self._finish(job, error)
                self.assertEqual(self._state(), ("OFFLINE", "OFFLINE"))
                self.cur.execute("ROLLBACK TO SAVEPOINT outcome;")

    def test_the_change_is_attributed_to_the_worker(self):
        job = self._playback_job()
        self._finish(job, "publishing stopped after 3 message(s): the broker connection was lost")
        self.cur.execute("SELECT actor_source, changed_by::text AS changed_by FROM public.audit_trail "
                         "WHERE entity_id = %s AND action = 'UPDATE' ORDER BY id DESC LIMIT 1;",
                         (PLAYBACK_GATEWAY,))
        self.assertEqual(dict(self.cur.fetchone()), {"actor_source": "service", "changed_by": PLAYBACK})

    def test_a_job_that_already_ended_changes_nothing(self):
        """
        Stop ended this job while its worker was silent, so the target was free for the next
        playback, whose NBIRTH has set the gateway ONLINE. The old worker's late finish must not
        undo that.
        """
        old = self._playback_job(reported_ago="5 minutes")
        self._run("Shopfloor_Manager", "SELECT public.request_playback_stop(%s);", (old,))
        self._playback_job(status="RUNNING")
        self._finish(old)
        self.assertEqual(self._state(), ("ONLINE", "ONLINE"))

    def test_a_job_never_claimed_opened_no_session_to_end(self):
        job = self._playback_job(status="PENDING")
        self._finish(job, "the capture could not be read")
        self.assertEqual(self._state(), ("ONLINE", "ONLINE"))

    def test_a_newer_playback_cannot_start_until_the_finish_commits(self):
        """The one-per-target index, which is why the OFFLINE write cannot land after a newer NBIRTH."""
        self._playback_job()
        with self.assertRaises(pg_errors.UniqueViolation):
            self.cur.execute("SAVEPOINT second;")
            try:
                self._playback_job(status="PENDING")
            finally:
                self.cur.execute("ROLLBACK TO SAVEPOINT second;")


if __name__ == "__main__":
    unittest.main(verbosity=2)
