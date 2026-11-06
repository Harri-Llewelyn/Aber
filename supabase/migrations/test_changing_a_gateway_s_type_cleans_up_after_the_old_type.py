"""
Changing a gateway's type cleans up after the old type (0252).

    python supabase/migrations/test_changing_a_gateway_s_type_cleans_up_after_the_old_type.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: a type change that crosses Remote's boundary burns the unredeemed setup tokens,
revokes the broker credential the OLD row held and stamps it, forgets the kept copy of a
dashboard-issued password, and leaves the gateway OFFLINE where it was mid-enrolment or has become
Remote. A change among Host, Simulated and Third-party, and an UPDATE that sets the type it already
had, end nothing. Redeeming or checking a token refuses a gateway that is not Remote. 0252's one-off
clean-up puts right what earlier type changes left, leaves a Remote gateway alone, and changes
nothing when it runs again.

EVERY TEST ROLLS BACK. A revocation is asserted on the pg_net queue, as test_credential_revocation.py
asserts it: net.http_post queues inside the caller's transaction, so the rollback un-queues it and
nothing reaches a credential service.
"""
import os
import unittest
import uuid
from pathlib import Path

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = Path(__file__).resolve().parent / "0252_changing_a_gateway_s_type_cleans_up_after_the_old_type.sql"

# The two columns each selectable type writes, as utils/gatewayType.js's gatewayTypeFields().
TYPES = {
    "remote": ("remote", False),
    "host": ("host", False),
    "simulated": ("host", True),
    "third_party": ("third_party", False),
}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class TypeChangeBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.gateways'::regclass"
                    " AND tgname = 'trg_gateways_type_change_cleans_up';"
                )
                if not cur.fetchone():
                    raise unittest.SkipTest("0252 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # REPEATABLE READ, so queue_depth() counts the requests this test queued and nothing else:
        # pg_net's worker deleting a request it has sent would move a READ COMMITTED count.
        self.conn.set_session(isolation_level="REPEATABLE READ")
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------------

    def gateway(self, kind="remote", status="OFFLINE", enrolled=False):
        gid = str(uuid.uuid4())
        deployment, simulated = TYPES[kind]
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, is_simulated, status, enrolled_at)"
            " VALUES (%s, %s, 'type change suite', %s, %s, %s, CASE WHEN %s THEN now() END)"
            " RETURNING sparkplug_id;",
            (gid, f"Test_TypeChange_{gid[:8]}", deployment, simulated, status, enrolled),
        )
        return gid, self.cur.fetchone()[0]

    def token(self, gid):
        """A live setup token, written as issue_gateway_enrollment_token() writes it. Returns it raw."""
        raw = uuid.uuid4().hex + uuid.uuid4().hex
        self.cur.execute(
            "INSERT INTO public.gateway_enrollment_tokens (gateway_id, token_hash, expires_at)"
            " VALUES (%s, encode(extensions.digest(%s, 'sha256'), 'hex'), now() + interval '30 minutes');",
            (gid, raw),
        )
        return raw

    def issue_credential(self, gid):
        """The CREDENTIAL_ISSUED row a dashboard or host-script mint leaves, and the kept copy."""
        self.cur.execute(
            "SELECT public.record_gateway_credential_issued_by_service(%s, '{}'::jsonb);", (gid,)
        )
        self.cur.execute(
            "SELECT vault.create_secret('not-a-real-password', %s, 'type change suite');",
            (f"gateway_broker_password:{gid}",),
        )

    def change(self, gid, kind):
        deployment, simulated = TYPES[kind]
        self.cur.execute(
            "UPDATE public.gateways SET deployment = %s, is_simulated = %s WHERE id = %s;",
            (deployment, simulated, gid),
        )

    # -- reads ------------------------------------------------------------------------------------

    def status(self, gid):
        self.cur.execute("SELECT status FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def revoked_at(self, gid):
        self.cur.execute("SELECT credential_revoked_at FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def live_tokens(self, gid):
        self.cur.execute(
            "SELECT count(*) FROM public.gateway_enrollment_tokens WHERE gateway_id = %s AND consumed_at IS NULL;",
            (gid,),
        )
        return self.cur.fetchone()[0]

    def queue_depth(self):
        self.cur.execute("SELECT count(*) FROM net.http_request_queue;")
        return self.cur.fetchone()[0]

    def request_recorded(self, gid):
        self.cur.execute(
            "SELECT EXISTS (SELECT 1 FROM public.gateway_revocation_requests WHERE gateway_id = %s);", (gid,)
        )
        return self.cur.fetchone()[0]

    def copy_kept(self, gid):
        self.cur.execute(
            "SELECT EXISTS (SELECT 1 FROM vault.secrets WHERE name = %s);", (f"gateway_broker_password:{gid}",)
        )
        return self.cur.fetchone()[0]

    def has_credential(self, gid):
        self.cur.execute(
            "SELECT public.gateway_has_broker_credential(g) FROM public.gateways g WHERE g.id = %s;", (gid,)
        )
        return self.cur.fetchone()[0]

    def trail_rows(self, gid):
        self.cur.execute(
            "SELECT action, new_data FROM public.audit_trail WHERE entity_id = %s ORDER BY id;", (gid,)
        )
        return self.cur.fetchall()


class LeavingRemote(TypeChangeBase):

    def test_before_enrolment_the_token_is_burned_and_the_gateway_reads_offline(self):
        """The dev stack's case: created Remote, set up, then edited to Host."""
        for kind in ("host", "simulated", "third_party"):
            with self.subTest(kind=kind):
                gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT")
                self.token(gid)
                before = self.queue_depth()

                self.change(gid, kind)

                self.assertEqual(self.live_tokens(gid), 0, "the setup token stayed redeemable")
                self.assertEqual(self.status(gid), "OFFLINE")
                # It never enrolled, so it holds no account, and revocation must not create one.
                self.assertEqual(self.queue_depth(), before)
                self.assertIsNone(self.revoked_at(gid))

    def test_after_enrolment_the_appliance_s_credential_is_revoked_and_stamped(self):
        gid, _ = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)
        before = self.queue_depth()

        self.change(gid, "host")

        self.assertEqual(self.queue_depth(), before + 1, "leaving Remote queued no revocation")
        self.assertTrue(self.request_recorded(gid), "no request was recorded for the sweep to judge")
        self.assertIsNotNone(self.revoked_at(gid))
        self.assertEqual(self.status(gid), "OFFLINE")
        # Host now: its record is a CREDENTIAL_ISSUED row after the stamp, and it has none.
        self.assertFalse(self.has_credential(gid))

    def test_an_online_appliance_keeps_its_status_until_the_broker_drops_it(self):
        gid, _ = self.gateway("remote", status="ONLINE", enrolled=True)
        before = self.queue_depth()

        self.change(gid, "third_party")

        self.assertEqual(self.queue_depth(), before + 1)
        self.assertIsNotNone(self.revoked_at(gid))
        # Its own word, which its NDEATH replaces when the broker drops the session.
        self.assertEqual(self.status(gid), "ONLINE")

    def test_a_re_issued_setup_and_an_enrolment_both_end(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT", enrolled=True)
        self.token(gid)
        before = self.queue_depth()

        self.change(gid, "host")

        self.assertEqual(self.live_tokens(gid), 0)
        self.assertEqual(self.queue_depth(), before + 1)
        self.assertEqual(self.status(gid), "OFFLINE")


class EnteringRemote(TypeChangeBase):

    def test_a_dashboard_issued_credential_is_revoked_stamped_and_forgotten(self):
        for kind in ("host", "third_party"):
            with self.subTest(kind=kind):
                gid, _ = self.gateway(kind, status="ONLINE")
                self.issue_credential(gid)
                self.assertTrue(self.has_credential(gid))
                before = self.queue_depth()

                self.change(gid, "remote")

                self.assertEqual(self.queue_depth(), before + 1, "entering Remote queued no revocation")
                self.assertTrue(self.request_recorded(gid))
                self.assertIsNotNone(self.revoked_at(gid))
                self.assertFalse(self.copy_kept(gid), "the password of an ended credential can still be shown")
                # Waiting for Set up, which moves it to PENDING_ENROLLMENT when it issues a token.
                self.assertEqual(self.status(gid), "OFFLINE")
                self.assertFalse(self.has_credential(gid))

    def test_a_gateway_that_holds_no_credential_is_passed_over(self):
        gid, _ = self.gateway("simulated", status="ONLINE")
        before = self.queue_depth()

        self.change(gid, "remote")

        self.assertEqual(self.queue_depth(), before, "a revocation was asked for an account never issued")
        self.assertIsNone(self.revoked_at(gid))
        self.assertEqual(self.status(gid), "OFFLINE")

    def test_set_up_still_issues_a_token_afterwards(self):
        gid, _ = self.gateway("host")
        self.change(gid, "remote")
        self.token(gid)
        self.assertEqual(self.live_tokens(gid), 1)


class BetweenTheDashboardIssuedTypes(TypeChangeBase):

    def test_the_credential_and_its_copy_stay(self):
        moves = [("host", "simulated"), ("simulated", "third_party"), ("third_party", "host"),
                 ("host", "third_party"), ("third_party", "simulated"), ("simulated", "host")]
        for old, new in moves:
            with self.subTest(old=old, new=new):
                gid, _ = self.gateway(old, status="ONLINE")
                self.issue_credential(gid)
                before = self.queue_depth()

                self.change(gid, new)

                self.assertEqual(self.queue_depth(), before)
                self.assertIsNone(self.revoked_at(gid))
                self.assertTrue(self.copy_kept(gid))
                self.assertTrue(self.has_credential(gid))
                self.assertEqual(self.status(gid), "ONLINE")


class WhatDoesNotChange(TypeChangeBase):

    def test_setting_the_type_it_already_has_ends_nothing(self):
        """The Edit form sends both columns on every save, which fires the trigger."""
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT", enrolled=True)
        self.token(gid)
        before = self.queue_depth()

        self.change(gid, "remote")

        self.assertEqual(self.live_tokens(gid), 1)
        self.assertEqual(self.status(gid), "PENDING_ENROLLMENT")
        self.assertEqual(self.queue_depth(), before)
        self.assertIsNone(self.revoked_at(gid))

    def test_an_archived_gateway_is_not_revoked_again(self):
        gid, _ = self.gateway("host")
        self.issue_credential(gid)
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        stamped = self.revoked_at(gid)
        before = self.queue_depth()

        self.change(gid, "remote")

        self.assertEqual(self.queue_depth(), before)
        self.assertEqual(self.revoked_at(gid), stamped)


class TheAuditTrail(TypeChangeBase):

    def test_the_change_and_what_it_ended_are_one_row(self):
        gid, _ = self.gateway("host", status="ONLINE")
        self.issue_credential(gid)
        before = len(self.trail_rows(gid))

        self.change(gid, "remote")

        rows = self.trail_rows(gid)
        self.assertEqual(len(rows), before + 1, "the type change wrote more than one row")
        action, new_data = rows[-1]
        self.assertEqual(action, "UPDATE")
        self.assertEqual(new_data["deployment"], "remote")
        self.assertEqual(new_data["status"], "OFFLINE")
        self.assertIsNotNone(new_data["credential_revoked_at"])


class TheStampsComment(TypeChangeBase):

    def test_it_says_a_type_change_stamps_it_and_not_that_re_enrolment_clears_it(self):
        # 0001 replays its own comment first on every boot; 0252's must be the one that stands.
        self.cur.execute(
            "SELECT col_description('public.gateways'::regclass, attnum) FROM pg_attribute"
            " WHERE attrelid = 'public.gateways'::regclass AND attname = 'credential_revoked_at';"
        )
        comment = self.cur.fetchone()[0]
        self.assertIn("(0252)", comment)
        self.assertNotIn("re-enrolment", comment)


class RedeemingAToken(TypeChangeBase):
    """The second lock: a token written before this file, or by any path, for a gateway not Remote."""

    CONSUME = "SELECT * FROM public.consume_gateway_enrollment_token(%s);"
    PEEK = "SELECT * FROM public.peek_gateway_enrollment_token(%s);"

    def test_a_gateway_that_is_not_remote_gets_no_rows_and_keeps_the_token(self):
        for kind in ("host", "simulated", "third_party"):
            with self.subTest(kind=kind):
                gid, _ = self.gateway(kind)
                raw = self.token(gid)

                self.cur.execute(self.PEEK, (raw,))
                self.assertEqual(self.cur.fetchall(), [])
                self.cur.execute(self.CONSUME, (raw,))
                self.assertEqual(self.cur.fetchall(), [])
                # Refused, not burned, as for an archived gateway.
                self.assertEqual(self.live_tokens(gid), 1)

    def test_a_remote_gateway_still_redeems(self):
        gid, sparkplug_id = self.gateway("remote", status="PENDING_ENROLLMENT")
        raw = self.token(gid)

        self.cur.execute(self.PEEK, (raw,))
        self.assertEqual(self.cur.fetchone()[1], sparkplug_id)
        self.cur.execute(self.CONSUME, (raw,))
        self.assertEqual(self.cur.fetchone()[1], sparkplug_id)
        self.assertEqual(self.live_tokens(gid), 0)


class TheOneOffCleanUp(TypeChangeBase):
    """0252's own third section, run as db-init runs it on every boot."""

    def replay(self):
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))

    def test_it_puts_right_what_an_earlier_type_change_left(self):
        # Written straight in, as a type change before 0252 left them: the trigger fires on UPDATE OF
        # deployment, and these rows were never updated.
        left, _ = self.gateway("host", status="PENDING_ENROLLMENT")
        self.token(left)
        enrolled, _ = self.gateway("third_party", status="AWAITING_BIRTH", enrolled=True)
        before = self.queue_depth()

        self.replay()

        self.assertEqual(self.status(left), "OFFLINE")
        self.assertEqual(self.live_tokens(left), 0)
        self.assertEqual(self.status(enrolled), "OFFLINE")
        # Nothing is revoked: no record says which type issued the credential.
        self.assertEqual(self.queue_depth(), before)
        self.assertIsNone(self.revoked_at(enrolled))

    def test_it_leaves_a_remote_gateway_alone(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT")
        self.token(gid)
        enrolled, _ = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)

        self.replay()

        self.assertEqual(self.status(gid), "PENDING_ENROLLMENT")
        self.assertEqual(self.live_tokens(gid), 1)
        self.assertEqual(self.status(enrolled), "AWAITING_BIRTH")

    def test_a_second_run_changes_nothing(self):
        left, _ = self.gateway("host", status="PENDING_ENROLLMENT")
        self.token(left)
        self.replay()
        trail = self.trail_rows(left)

        self.replay()

        self.assertEqual(self.trail_rows(left), trail, "the second boot wrote to a gateway again")
        self.assertEqual(self.status(left), "OFFLINE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
