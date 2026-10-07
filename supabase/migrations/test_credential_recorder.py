"""
The machine-path credential recorder (0062), and the boundary it must not cross.

    python supabase/migrations/test_credential_recorder.py

Requires the Supabase database (54322 by default) and archived migration 0062 applied.

---------------------------------------------------------------------------------------------
WHAT THIS SUITE IS FOR.

A service-role caller issued broker credentials that nothing recorded, because 0041's recorder
gates on `has_role()` and a service-role key has no `auth.uid()`. Measured before the fix: five
live gateways, two `CREDENTIAL_ISSUED` rows.
The Access Control page then reported `No platform record` for three gateways whose accounts were
at the broker and publishing.

That is not a cosmetic gap. These credentials cannot be revoked in any general sense -- rotating
`SUPABASE_JWT_SECRET` invalidates every key in the stack -- so docs/security-model.md's Accepted risks section
names the inventory as the compensating control. An inventory that under-reports is that control
not working.

THE GRANT IS THE HALF THAT MATTERS MOST, and it is asserted in both directions. Unreachable by
`service_role` and provisioning silently records nothing again. Reachable by `authenticated` and any
signed-in user can write an unattributed CREDENTIAL_ISSUED row into a table whose rows cannot be
deleted -- a worse defect than the one being fixed, and one that would look like an operator's own
record until somebody read `actor_source`.

EVERY TEST ROLLS BACK. The suite writes audit rows on purpose and none of them survive: this table
is append-only and cannot be pruned, so a test that committed would leave a permanent record
asserting a credential was issued when none was. Same arrangement as test_gateway_enrollment.py.
"""
import json
import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

FUNC = "public.record_gateway_credential_issued_by_service(uuid, jsonb)"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class RecorderBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regprocedure(%s);", (FUNC,))
            if not cur.fetchone()[0]:
                raise unittest.SkipTest(
                    f"{FUNC} does not exist -- apply "
                    "0062_provisioning_records_what_it_issues.sql first"
                )
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def record(self, gateway_id, context="{}"):
        """
        Call the recorder, then read the row back in a SECOND statement.

        NOT `SELECT new_data ... WHERE id = record_...()`, which returns nothing at all: the
        function inserts during evaluation, and the outer SELECT is answering from a snapshot taken
        before that insert existed. The one-statement form looks tidier and silently tests nothing.
        """
        self.cur.execute(
            "SELECT public.record_gateway_credential_issued_by_service(%s, %s::jsonb);",
            (gateway_id, context),
        )
        row_id = self.cur.fetchone()[0]
        self.cur.execute(
            "SELECT entity_type, action, changed_by, actor_source, new_data "
            "FROM public.audit_trail WHERE id = %s;",
            (row_id,),
        )
        return self.cur.fetchone()

    def a_gateway(self, archived=False):
        """
        A gateway of this suite's own, rolled back with everything else.

        NOT ONE OF THE SEEDED FLEET. Recording against a real gateway would be indistinguishable
        from the thing being tested -- and if a rollback were ever lost, the row would assert
        something false about a gateway an operator relies on.
        """
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, is_archived) "
            "VALUES (%s, %s, %s, 'host', %s) RETURNING id, sparkplug_id;",
            (gid, f"Test_Recorder_{gid[:8]}", "credential recorder suite", archived),
        )
        return self.cur.fetchone()


class TestTheRowItWrites(RecorderBase):

    def test_writes_a_credential_issued_row_naming_no_person(self):
        gid, sparkplug_id = self.a_gateway()
        entity_type, action, changed_by, actor_source, new_data = self.record(
            gid, '{"os_user": "ci", "host": "runner-7", "script": "test"}'
        )

        self.assertEqual(entity_type, "gateways")
        # THE SAME ACTION THE OPERATOR PATH WRITES. An inventory asking "does this gateway hold a
        # credential" must not need to know which route minted it.
        self.assertEqual(action, "CREDENTIAL_ISSUED")
        # NULL, and pinned to 'service'. The caller holds a machine credential; a row naming a
        # person would be an attribution the database cannot support.
        self.assertIsNone(changed_by)
        self.assertEqual(actor_source, "service")
        self.assertEqual(new_data["sparkplug_id"], sparkplug_id)
        self.assertEqual(new_data["mqtt_username"], sparkplug_id)

    def test_the_host_and_os_user_are_labelled_as_claims(self):
        gid, _ = self.a_gateway()
        new_data = self.record(gid, '{"os_user": "ci", "host": "runner-7", "script": "test"}')[4]
        # Under `claimed`, because the database can verify neither. A key named `issued_by` would
        # have read as an attribution -- 0043's convention, and this follows it rather than
        # inventing a second one.
        self.assertEqual(new_data["claimed"]["os_user"], "ci")
        self.assertEqual(new_data["claimed"]["host"], "runner-7")

    def test_stores_only_the_two_claim_keys_a_caller_may_assert(self):
        gid, _ = self.a_gateway()
        new_data = self.record(
            gid, '{"os_user": "ci", "host": "h", "issued_by": "Administrator", "verified": true}'
        )[4]
        # A caller must not be able to add fields that look authoritative. p_context is read key by
        # key for exactly this reason rather than stored wholesale.
        self.assertNotIn("issued_by", new_data)
        self.assertNotIn("verified", new_data)
        self.assertNotIn("issued_by", new_data["claimed"])

    def test_carries_no_password_and_nothing_shaped_like_one(self):
        gid, _ = self.a_gateway()
        body = json.dumps(self.record(gid, '{"os_user": "ci", "host": "h", "password": "hunter2"}')[4])
        # The row lands in an append-only table readable by any holder of `audit_trail:read`.
        # A secret in it would be a secret with no revocation story at all.
        self.assertNotIn("hunter2", body)
        self.assertNotIn("password", body)

    def test_a_rotation_says_so(self):
        gid, _ = self.a_gateway()
        rotated = self.record(gid, '{"rotated": true}')[4]
        # mosquitto holds ONE password per username, so reissuing replaces rather than adds.
        # Without this flag a reader counting two rows for one gateway would report two live
        # credentials -- wrong in the opposite direction from the bug this closes.
        self.assertTrue(rotated["rotated"])

    def test_defaults_to_not_a_rotation_when_the_caller_says_nothing(self):
        gid, _ = self.a_gateway()
        self.assertFalse(self.record(gid)[4]["rotated"])


class TestWhatItRefuses(RecorderBase):

    def test_refuses_a_gateway_that_does_not_exist(self):
        with self.assertRaises(psycopg2.Error) as caught:
            self.cur.execute(
                "SELECT public.record_gateway_credential_issued_by_service(%s, '{}'::jsonb);",
                (str(uuid.uuid4()),),
            )
        self.assertIn("does not exist", str(caught.exception))

    def test_refuses_an_archived_gateway(self):
        gid, _ = self.a_gateway(archived=True)
        with self.assertRaises(psycopg2.Error) as caught:
            self.cur.execute(
                "SELECT public.record_gateway_credential_issued_by_service(%s, '{}'::jsonb);",
                (gid,),
            )
        # 0037 withdraws enrolment on archive so a decommissioned appliance cannot return through a
        # credential. Recording one as routine would document, in the table an auditor reads to
        # check it did not happen, exactly the thing 0037 exists to prevent.
        self.assertIn("archived", str(caught.exception).lower())

    def test_refuses_a_null_subject(self):
        with self.assertRaises(psycopg2.Error):
            self.cur.execute(
                "SELECT public.record_gateway_credential_issued_by_service(NULL, '{}'::jsonb);"
            )


class TestWhoMayReachIt(RecorderBase):
    """
    The grant, in both directions. This is the half that decides whether the fix is a fix.
    """

    def test_service_role_may_execute_it(self):
        self.cur.execute("SELECT has_function_privilege('service_role', %s, 'EXECUTE');", (FUNC,))
        self.assertTrue(
            self.cur.fetchone()[0],
            "provisioning authenticates as service_role; without this grant it goes back to "
            "issuing credentials that nothing records.",
        )

    def test_authenticated_may_not(self):
        self.cur.execute("SELECT has_function_privilege('authenticated', %s, 'EXECUTE');", (FUNC,))
        self.assertFalse(
            self.cur.fetchone()[0],
            "a signed-in user could write a CREDENTIAL_ISSUED row attributed to nobody, into a "
            "table whose rows cannot be deleted. Operators record through 0041's function, which "
            "names them.",
        )

    def test_anon_may_not(self):
        self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE');", (FUNC,))
        self.assertFalse(self.cur.fetchone()[0])

    def test_the_operator_path_still_requires_a_role(self):
        # 0041's function is untouched by 0062, and this asserts that rather than assuming it: the
        # rejected alternative was widening it to serve both callers, which would have left one
        # function whose authorisation depended on which caller reached it.
        self.cur.execute(
            "SELECT prosrc FROM pg_proc WHERE oid = "
            "'public.record_gateway_credential_issued(uuid)'::regprocedure;"
        )
        self.assertIn("has_role", self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
