# suite:
#   lanes: db
#   why: 0312 -- a setup issued for a Remote gateway whose appliance has enrolled revokes the
#     credential that appliance holds at once, stamps it in the one audited UPDATE, and owes it until
#     the credential service confirms it. The new appliance's enrolment replaces it, so the sweep never
#     disables the new credential. A setup that left the old credential working until the new one was
#     redeemed would leave a replaced appliance connected, and nothing would say so.

"""
Setting up an enrolled gateway again revokes its credential at once (0312).

    python supabase/migrations/test_setting_up_an_enrolled_gateway_again_revokes_its_credential.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * A setup for an enrolled appliance, waiting for its first birth or gone quiet after publishing,
    asks for the revocation, stamps it, records the debt and moves the gateway to PENDING_ENROLLMENT,
    in one audited UPDATE by the person who issued it.
  * A second setup straight after asks for nothing more and writes no row. A gateway that never
    enrolled, or whose enrolment a revocation already followed, is asked for nothing.
  * The new appliance's enrolment replaces the stamped credential: the sweep drops the debt and asks
    nothing, however its request was answered. A setup left unused keeps the old credential's
    revocation owed until a 2xx confirms it.
  * A setup issued while the credential service cannot be asked owes the revocation all the same.
  * The refusals stay: an Operator, a Host or Third-party gateway, and an archived gateway ask for
    nothing.

The setup is issued as a Shopfloor Manager, through the `authenticated` role. EVERY TEST ROLLS BACK:
net.http_post queues inside the caller's transaction, so nothing reaches a credential service.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class SetupBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.owe_gateway_revocation(text)');")
                if not cur.fetchone()[0]:
                    raise unittest.SkipTest("0311 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.conn.set_session(isolation_level="REPEATABLE READ")
        self.cur = self.conn.cursor()
        self.manager = self.person("Shopfloor_Manager")
        self.operator = self.person("Operator")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def person(self, role):
        user_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.users (instance_id, id, aud, role, email) "
            "VALUES ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s);",
            (user_id, f"{user_id}@setup-revokes.test"))
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles WHERE name = %s;",
            (user_id, role))
        return user_id

    def become(self, user_id):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;',
                         (json.dumps({"sub": user_id, "email": f"{user_id}@setup-revokes.test"}),))

    def owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute('RESET "request.jwt.claims";')

    def gateway(self, status="AWAITING_BIRTH", enrolled_minutes_ago=60, deployment="remote"):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, status, enrolled_at)"
            " VALUES (%s, %s, 'setup revokes suite', %s, %s,"
            "         CASE WHEN %s::int IS NOT NULL THEN now() - make_interval(mins => %s::int) END)"
            " RETURNING sparkplug_id;",
            (gid, f"Test_Setup_{gid[:8]}", deployment, status, enrolled_minutes_ago, enrolled_minutes_ago))
        return gid, self.cur.fetchone()[0]

    def issue_setup(self, gid, user=None):
        self.become(user or self.manager)
        try:
            self.cur.execute("SELECT token FROM public.issue_gateway_enrollment_token(%s, 30);", (gid,))
            return self.cur.fetchone()[0]
        finally:
            self.owner()

    def refused(self, gid, user=None):
        self.cur.execute("SAVEPOINT attempt;")
        try:
            with self.assertRaises(psycopg2.Error):
                self.issue_setup(gid, user)
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
            self.owner()

    def enrol(self, gid, raw, minutes_from_now=0):
        """What enroll-gateway does to the database: claim the token, then record the enrolment."""
        self.cur.execute("SELECT * FROM public.consume_gateway_enrollment_token(%s);", (raw,))
        self.assertEqual(len(self.cur.fetchall()), 1, "the new setup was not redeemable")
        self.cur.execute(
            "UPDATE public.gateways SET status = 'AWAITING_BIRTH',"
            " enrolled_at = now() + make_interval(mins => %s) WHERE id = %s;", (minutes_from_now, gid))

    def configured(self, value):
        self.cur.execute("SELECT id FROM vault.secrets WHERE name = 'gateway_revoke_secret';")
        secret_id = self.cur.fetchone()[0]
        self.cur.execute("SELECT vault.update_secret(%s, %s);", (secret_id, value or ""))

    def asked(self, sparkplug_id):
        self.cur.execute(
            "SELECT count(*) FROM net.http_request_queue"
            " WHERE url LIKE '%%/revoke-gateway-credential' AND position(%s::bytea IN body) > 0;",
            (sparkplug_id.encode(),))
        return self.cur.fetchone()[0]

    def row(self, gid):
        self.cur.execute(
            "SELECT g.status, g.credential_revoked_at, g.enrolled_at, public.gateway_has_broker_credential(g),"
            "       q.gateway_id IS NOT NULL, q.request_id"
            " FROM public.gateways g LEFT JOIN public.gateway_revocation_requests q ON q.gateway_id = g.id"
            " WHERE g.id = %s;", (gid,))
        return dict(zip(("status", "stamp", "enrolled_at", "held", "owed", "request_id"), self.cur.fetchone()))

    def trail(self, gid):
        self.cur.execute(
            "SELECT action, changed_by::text, new_data FROM public.audit_trail WHERE entity_id = %s ORDER BY id;", (gid,))
        return self.cur.fetchall()

    def reply(self, request_id, status):
        self.cur.execute("INSERT INTO net._http_response (id, status_code, content) VALUES (%s, %s, '{}');",
                         (request_id, status))

    def sweep(self):
        self.cur.execute("SELECT public.sweep_gateway_credential_revocations();")
        return self.cur.fetchone()[0]


class ASetupForAnEnrolledApplianceRevokesAtOnce(SetupBase):

    def test_waiting_for_its_first_birth(self):
        gid, sparkplug_id = self.gateway("AWAITING_BIRTH")
        enrolled_at = self.row(gid)["enrolled_at"]
        rows = len(self.trail(gid))

        self.issue_setup(gid)

        row = self.row(gid)
        self.assertEqual(self.asked(sparkplug_id), 1, "the credential the enrolled appliance holds was not revoked")
        self.assertIsNotNone(row["stamp"])
        self.assertEqual((row["status"], row["held"], row["owed"]), ("PENDING_ENROLLMENT", False, True))
        self.assertIsNotNone(row["request_id"])
        self.assertEqual(row["enrolled_at"], enrolled_at, "the enrolment stays, older than the stamp")
        trail = self.trail(gid)
        self.assertEqual(len(trail), rows + 1, "the status and the stamp are one row")
        action, changed_by, new_data = trail[-1]
        self.assertEqual((action, changed_by), ("UPDATE", self.manager))
        self.assertEqual(new_data["status"], "PENDING_ENROLLMENT")
        self.assertIsNotNone(new_data["credential_revoked_at"])

    def test_gone_quiet_after_publishing_as_a_rebuilt_appliance_is(self):
        for status in ("OFFLINE", "ONLINE"):
            with self.subTest(status=status):
                self.cur.execute("SAVEPOINT status;")
                gid, sparkplug_id = self.gateway(status)
                self.issue_setup(gid)
                row = self.row(gid)
                self.assertEqual(self.asked(sparkplug_id), 1)
                self.assertEqual((row["status"], row["held"], row["owed"]), ("PENDING_ENROLLMENT", False, True))
                self.cur.execute("ROLLBACK TO SAVEPOINT status;")

    def test_an_enrolment_a_re_issue_left_standing_before_the_upgrade_is_revoked_too(self):
        gid, sparkplug_id = self.gateway("PENDING_ENROLLMENT")
        rows = len(self.trail(gid))
        self.issue_setup(gid)
        self.assertEqual(self.asked(sparkplug_id), 1)
        self.assertIsNotNone(self.row(gid)["stamp"])
        self.assertEqual(len(self.trail(gid)), rows + 1, "the stamp is written though the status stays")

    def test_a_second_setup_straight_after_asks_for_nothing_more(self):
        gid, sparkplug_id = self.gateway("AWAITING_BIRTH")
        first = self.issue_setup(gid)
        stamp = self.row(gid)["stamp"]
        rows = len(self.trail(gid))

        second = self.issue_setup(gid)

        self.assertNotEqual(first, second)
        self.assertEqual(self.asked(sparkplug_id), 1)
        self.assertEqual(self.row(gid)["stamp"], stamp)
        self.assertEqual(len(self.trail(gid)), rows, "nothing changed, so nothing is recorded")

    def test_owed_while_the_credential_service_cannot_be_asked(self):
        self.cur.execute("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'gateway_revoke_secret';")
        secret = self.cur.fetchone()[0]
        gid, sparkplug_id = self.gateway("AWAITING_BIRTH")
        self.configured(None)
        self.issue_setup(gid)
        row = self.row(gid)
        self.assertIsNotNone(row["stamp"])
        self.assertEqual((row["owed"], row["request_id"]), (True, None))
        self.configured(secret)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), 1)


class WhatTheSetupLeavesAlone(SetupBase):

    def test_a_gateway_that_never_enrolled(self):
        for status in ("OFFLINE", "PENDING_ENROLLMENT"):
            with self.subTest(status=status):
                self.cur.execute("SAVEPOINT status;")
                gid, sparkplug_id = self.gateway(status, enrolled_minutes_ago=None)
                self.issue_setup(gid)
                row = self.row(gid)
                self.assertEqual(self.asked(sparkplug_id), 0)
                self.assertEqual((row["stamp"], row["owed"]), (None, False))
                self.cur.execute("ROLLBACK TO SAVEPOINT status;")

    def test_a_gateway_whose_enrolment_a_revocation_followed(self):
        gid, sparkplug_id = self.gateway("OFFLINE", enrolled_minutes_ago=120)
        self.cur.execute("UPDATE public.gateways SET credential_revoked_at = now() - interval '60 minutes' WHERE id = %s;", (gid,))
        stamp = self.row(gid)["stamp"]
        self.issue_setup(gid)
        self.assertEqual(self.asked(sparkplug_id), 0, "a credential already revoked was asked for again")
        self.assertEqual(self.row(gid)["stamp"], stamp)

    def test_the_refusals_ask_for_nothing(self):
        enrolled, enrolled_id = self.gateway("AWAITING_BIRTH")
        self.refused(enrolled, user=self.operator)
        self.assertEqual(self.asked(enrolled_id), 0, "an Operator's refused setup asked for a revocation")
        archived, archived_id = self.gateway("OFFLINE")
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (archived,))
        before = self.asked(archived_id)
        self.refused(archived)
        self.assertEqual(self.asked(archived_id), before)
        for deployment in ("host", "third_party"):
            with self.subTest(deployment=deployment):
                gid, sparkplug_id = self.gateway("OFFLINE", enrolled_minutes_ago=None, deployment=deployment)
                self.refused(gid)
                self.assertEqual(self.asked(sparkplug_id), 0)


class TheNewApplianceReplacesIt(SetupBase):

    def test_enrolling_with_the_new_setup_stops_the_sweep_whatever_the_reply(self):
        gid, sparkplug_id = self.gateway("AWAITING_BIRTH")
        raw = self.issue_setup(gid)
        request_id = self.row(gid)["request_id"]
        self.enrol(gid, raw, minutes_from_now=1)
        self.reply(request_id, 503)
        self.assertTrue(self.row(gid)["held"], "the new appliance's enrolment is newer than the stamp")

        for _ in range(3):
            self.sweep()
        self.assertEqual(self.asked(sparkplug_id), 1, "a retry would disable the new appliance's credential")
        self.assertFalse(self.row(gid)["owed"])

    def test_a_setup_left_unused_keeps_the_old_credential_owed_until_a_2xx(self):
        gid, sparkplug_id = self.gateway("OFFLINE")
        self.issue_setup(gid)
        request_id = self.row(gid)["request_id"]
        self.reply(request_id, 503)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), 2)
        retried = self.row(gid)["request_id"]
        self.assertNotEqual(retried, request_id)
        self.reply(retried, 200)
        self.sweep()
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), 2)
        self.assertFalse(self.row(gid)["owed"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
