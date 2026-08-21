"""
PostgreSQL integration tests for `0026_digital_thread_causation_and_ingestion_rejections.sql`.

TWO THINGS, AND THE SECOND IS A SECURITY BOUNDARY.

  1. CAUSATION. Every row a single transaction writes now carries the same `causation_id`, so the
     several audit rows one operator action produces can be read back as one act rather than
     reassembled from timestamps -- which is guesswork the moment two operators work at once.

  2. THE NARROW GATE. `record_ingestion_rejection()` is a SECURITY DEFINER function that PINS
     `actor_source` to 'ingestion' and `changed_by` to NULL, and 0026 revokes `service_role`'s
     direct INSERT on `digital_thread` so the function is the only way in.

     THAT REVOKE IS THE POINT AND IT IS WHY THIS SUITE EXISTS. The service-role key ships in .env
     and is held by the ingestion daemon and every edge function. While it could INSERT directly,
     any holder could write an audit row claiming `actor_source = 'user'` with a `changed_by`
     naming an operator who was not there -- a forged entry in the one table the platform offers as
     evidence. A later migration re-granting INSERT would restore that silently, and nothing else
     in the repository would notice.

Runs against the Supabase database, not the historian. Requires the stack (or CI's Postgres
service) to be up:

    python supabase/migrations/test_ingestion_rejection_rpc.py
"""
import json
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class RejectionRpcTestCase(unittest.TestCase):
    """
    Every test runs inside one transaction and rolls back.

    ROLLBACK IS WHAT MAKES THIS SAFE TO RUN AGAINST A LIVE STACK, and it is not merely tidiness:
    `digital_thread` is append-only to every application role, so a committed scratch row could not
    be removed afterwards without the owner exemption this suite deliberately does not rely on.
    """

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'digital_thread'
                       AND column_name = 'causation_id'
                """)
                if not cur.fetchone():
                    raise RuntimeError(
                        "digital_thread.causation_id is missing -- 0026 has not been applied."
                    )

                cur.execute("SELECT to_regprocedure('public.record_ingestion_rejection(uuid, jsonb, timestamptz)')")
                if not cur.fetchone()[0]:
                    raise RuntimeError("record_ingestion_rejection() is not defined")
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT id, name FROM public.devices LIMIT 1")
        row = self.cur.fetchone()
        if not row:
            self.skipTest("no devices seeded; 0002 has not run")
        self.device_id, self.device_name = row

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    def record(self, violations, device_id=None):
        self.cur.execute(
            "SELECT public.record_ingestion_rejection(%s::uuid, %s::jsonb)",
            (device_id or self.device_id, json.dumps(violations)),
        )
        return self.cur.fetchone()[0]

    def row(self, audit_id):
        self.cur.execute(
            "SELECT entity_type, entity_id, action, old_data, new_data, changed_by, "
            "       actor_source, causation_id "
            "  FROM public.digital_thread WHERE id = %s",
            (audit_id,),
        )
        cols = ("entity_type", "entity_id", "action", "old_data", "new_data",
                "changed_by", "actor_source", "causation_id")
        return dict(zip(cols, self.cur.fetchone()))

    # -- causation -------------------------------------------------------------------------------

    def test_rows_from_one_transaction_share_a_causation_id(self):
        """
        The whole reason the column exists: an operator action that touches several rows must be
        reassemblable as one act, not N events that happen to share a second.
        """
        self.cur.execute(
            "UPDATE public.devices SET description = 'probe A' WHERE id = %s", (self.device_id,))
        self.cur.execute(
            "UPDATE public.devices SET description = 'probe B' WHERE id = %s", (self.device_id,))

        self.cur.execute(
            "SELECT count(*), count(DISTINCT causation_id) "
            "  FROM public.digital_thread WHERE causation_id = txid_current()")
        written, distinct = self.cur.fetchone()

        self.assertGreaterEqual(written, 2)
        self.assertEqual(distinct, 1)

    def test_a_rejection_shares_the_causation_of_the_transaction_that_wrote_it(self):
        self.cur.execute(
            "UPDATE public.devices SET description = 'probe' WHERE id = %s", (self.device_id,))
        audit_id = self.record([{"metric": "M", "code": "unmodelled_metric"}])

        self.cur.execute("SELECT txid_current()")
        txid = self.cur.fetchone()[0]
        self.assertEqual(self.row(audit_id)["causation_id"], txid)

    # -- the recorded refusal --------------------------------------------------------------------

    def test_the_row_is_attributed_to_ingestion_and_to_no_user(self):
        audit_id = self.record([{"metric": "Rogue/Metric", "code": "unmodelled_metric"}])
        row = self.row(audit_id)

        self.assertEqual(row["action"], "SCHEMA_REJECTION")
        self.assertEqual(row["entity_type"], "devices")
        self.assertEqual(str(row["entity_id"]), str(self.device_id))
        self.assertEqual(row["actor_source"], "ingestion")
        self.assertIsNone(row["changed_by"])
        # An observation has no prior state, and the UI renders a one-sided snapshot on that basis.
        self.assertIsNone(row["old_data"])

    def test_the_identity_is_captured_as_it_was_at_the_time(self):
        """
        `name` is mutable and a device can later be renamed or hard-purged. A row that could only be
        read by joining to a live row would lose its meaning in exactly the cases it matters most --
        which is the same argument the purged-entity fallback in DigitalThreadTab.jsx rests on.
        """
        audit_id = self.record([{"metric": "M", "code": "unmodelled_metric"}])
        payload = self.row(audit_id)["new_data"]

        self.assertEqual(payload["name"], self.device_name)
        self.assertIn("sparkplug_id", payload)
        self.assertIn("observed_at", payload)

    def test_an_empty_violation_list_writes_nothing(self):
        """
        The daemon computing an empty list is the ordinary healthy case. A caller should not have to
        guard against its own success, so this returns NULL rather than raising.
        """
        self.cur.execute("SELECT count(*) FROM public.digital_thread")
        before = self.cur.fetchone()[0]

        self.assertIsNone(self.record([]))

        self.cur.execute("SELECT count(*) FROM public.digital_thread")
        self.assertEqual(self.cur.fetchone()[0], before)

    def test_an_unknown_device_is_refused(self):
        """
        `entity_id` has no foreign key -- deliberately, so history survives a purge -- which means
        nothing else would catch a typo'd id, and the row would sit in an append-only table forever
        describing nothing.
        """
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.record([{"code": "x"}], device_id="00000000-0000-4000-8000-000000000000")

    def test_a_non_array_payload_is_refused(self):
        self.conn.rollback()
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.cur.execute(
                "SELECT public.record_ingestion_rejection(%s::uuid, %s::jsonb)",
                (self.device_id, json.dumps({"not": "an array"})),
            )

    def test_a_long_violation_list_is_capped_and_says_so(self):
        """
        The daemon deduplicates per device, but a payload with a thousand unmodelled metrics would
        otherwise put a thousand objects into one jsonb column of a table that cannot be pruned.
        The TRUE count is kept alongside, so the truncation is visible rather than silent.
        """
        audit_id = self.record(
            [{"metric": f"M{i}", "code": "unmodelled_metric"} for i in range(120)])
        payload = self.row(audit_id)["new_data"]

        self.assertEqual(payload["violation_count"], 120)
        self.assertTrue(payload["truncated"])
        self.assertEqual(len(payload["violations"]), 50)

    def test_a_short_violation_list_is_not_marked_truncated(self):
        audit_id = self.record([{"metric": "M", "code": "unmodelled_metric"}])
        payload = self.row(audit_id)["new_data"]

        self.assertEqual(payload["violation_count"], 1)
        self.assertFalse(payload["truncated"])
        self.assertEqual(len(payload["violations"]), 1)


class ServiceRoleCannotForgeAuditRowsTestCase(unittest.TestCase):
    """
    The boundary 0026 establishes, asserted from the outside.

    Each test SET LOCAL ROLE service_role -- the credential that ships in .env and is held by the
    ingestion daemon and all the edge functions -- and then tries to do what the RPC exists to
    prevent.
    """

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    def as_service_role(self):
        self.cur.execute("SET LOCAL ROLE service_role")

    def test_service_role_cannot_insert_an_audit_row(self):
        self.as_service_role()
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("""
                INSERT INTO public.digital_thread
                       (entity_type, entity_id, action, new_data, actor_source, changed_by)
                VALUES ('devices', gen_random_uuid(), 'SCHEMA_REJECTION',
                        '{"forged": true}'::jsonb, 'user', gen_random_uuid())
            """)

    def test_service_role_still_cannot_update_or_delete(self):
        """0003's append-only trigger, re-asserted because 0026 rewrites the grants around it."""
        for statement in (
            "UPDATE public.digital_thread SET action = 'TAMPERED' WHERE id = "
            "(SELECT id FROM public.digital_thread ORDER BY id DESC LIMIT 1)",
            "DELETE FROM public.digital_thread WHERE id = "
            "(SELECT id FROM public.digital_thread ORDER BY id DESC LIMIT 1)",
        ):
            with self.subTest(statement=statement.split()[0]):
                self.conn.rollback()
                self.as_service_role()
                with self.assertRaises(psycopg2.Error):
                    self.cur.execute(statement)

    def test_service_role_can_still_read_the_audit_trail(self):
        """
        The revoke is on writes only. Reading its own history back is ordinary, and the edge
        functions do it.
        """
        self.as_service_role()
        self.cur.execute("SELECT count(*) FROM public.digital_thread")
        self.assertIsNotNone(self.cur.fetchone()[0])

    def test_service_role_can_still_reach_the_rpc(self):
        """
        The other half of the boundary: closing the direct path is only correct if the sanctioned
        one is open. A revoke that also broke the RPC would leave the daemon unable to record
        anything, which is the failure this whole feature exists to end.
        """
        self.as_service_role()
        self.cur.execute(
            "SELECT has_function_privilege("
            "  'public.record_ingestion_rejection(uuid, jsonb, timestamptz)', 'EXECUTE')")
        self.assertTrue(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
