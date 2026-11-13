"""
A failed revocation after a change of a gateway's type is asked again (0252, 0288).

    python supabase/migrations/test_a_failed_type_change_revocation_is_retried.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * A revocation a change of type asked for, and that did not land, is asked again by the sweep:
    after a reply that is not a 2xx and after five minutes with none, with the stamp kept, until a
    2xx confirms it. A request younger than five minutes waits. A 2xx is never asked again.
  * It is never asked again once a credential was issued or enrolled after the stamp. The broker
    account has the same name before and after the change, so a retry then would disable the
    credential just issued. The row is dropped and the credential service is not called, however
    many sweeps run and however the request was answered. A credential issued before the stamp,
    and one issued to another gateway, stop nothing.
  * An archived gateway is judged as it was: a failed request clears the stamp and is asked again
    with a new one, a restore ends the request, and a 2xx keeps the stamp.
  * A stamp with no request row, which a change of type before 0288 could leave, is not asked for.
  * gateway_credential_was_replaced(): its truth table, and that no API role may run it.

EVERY TEST ROLLS BACK. A request is asserted on the pg_net queue and a reply is written into
net._http_response by hand, as test_credential_revocation.py does: net.http_post queues inside the
caller's transaction, so the rollback un-queues it and nothing reaches a credential service.
`now()` is one instant inside a transaction, so the stamp, the request and a credential's issue are
set to times of their own.
"""
import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# The two columns each selectable type writes, as utils/gatewayType.js's gatewayTypeFields().
TYPES = {
    "remote": ("remote", False),
    "host": ("host", False),
    "simulated": ("host", True),
    "third_party": ("third_party", False),
}

# Minutes before now(): the credential the old type held, the change of type and its request, and a
# credential issued since.
HELD = 600
ASKED = 30
SINCE = 10


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class RetryBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.gateway_credential_was_replaced(public.gateways)');")
                if not cur.fetchone()[0]:
                    raise unittest.SkipTest("0288 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # REPEATABLE READ, so queue_depth() counts the requests this test queued and nothing else.
        self.conn.set_session(isolation_level="REPEATABLE READ")
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------------

    def issue(self, gid, minutes_ago):
        """The CREDENTIAL_ISSUED row a mint leaves, as of `minutes_ago`."""
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data, changed_by,"
            "       actor_source, causation_id, recorded_at)"
            " VALUES ('gateways', %s, 'CREDENTIAL_ISSUED', NULL, '{}'::jsonb, NULL, 'service', txid_current(),"
            "         now() - make_interval(mins => %s));",
            (gid, minutes_ago))

    def gateway(self, kind="host"):
        """A gateway holding a broker credential under its type, issued a long while ago."""
        gid = str(uuid.uuid4())
        deployment, simulated = TYPES[kind]
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, is_simulated, status, enrolled_at)"
            " VALUES (%s, %s, 'type change retry suite', %s, %s, 'OFFLINE',"
            "         CASE WHEN %s THEN now() - make_interval(mins => %s) END) RETURNING sparkplug_id;",
            (gid, f"Test_Retry_{gid[:8]}", deployment, simulated, deployment == "remote", HELD))
        sparkplug_id = self.cur.fetchone()[0]
        if deployment != "remote":
            self.issue(gid, HELD)
        return gid, sparkplug_id

    def change(self, gid, kind, asked=ASKED):
        """Change the type across Remote's boundary, then move the stamp and the request back to
        `asked` minutes ago. Returns the request's id and the stamp."""
        deployment, simulated = TYPES[kind]
        self.cur.execute("UPDATE public.gateways SET deployment = %s, is_simulated = %s WHERE id = %s;",
                         (deployment, simulated, gid))
        self.cur.execute(
            "UPDATE public.gateways SET credential_revoked_at = now() - make_interval(mins => %s)"
            " WHERE id = %s RETURNING credential_revoked_at;", (asked, gid))
        stamp = self.cur.fetchone()[0]
        self.cur.execute(
            "UPDATE public.gateway_revocation_requests SET requested_at = now() - make_interval(mins => %s)"
            " WHERE gateway_id = %s RETURNING request_id;", (asked, gid))
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "the change of type recorded no request for the sweep to judge")
        return row[0], stamp

    def reply(self, request_id, status):
        self.cur.execute("INSERT INTO net._http_response (id, status_code, content) VALUES (%s, %s, '{}');",
                         (request_id, status))

    def age(self, gid, minutes):
        """The request of this gateway, as asked `minutes` ago."""
        self.cur.execute(
            "UPDATE public.gateway_revocation_requests SET requested_at = now() - make_interval(mins => %s)"
            " WHERE gateway_id = %s;", (minutes, gid))

    # -- reads ------------------------------------------------------------------------------------

    def queue_depth(self, gid):
        """The revocation requests queued in this transaction for this gateway."""
        self.cur.execute("SELECT sparkplug_id FROM public.gateways WHERE id = %s;", (gid,))
        sparkplug_id = self.cur.fetchone()[0]
        self.cur.execute("SELECT count(*) FROM net.http_request_queue WHERE position(%s::bytea IN body) > 0;",
                         (sparkplug_id.encode(),))
        return self.cur.fetchone()[0]

    def state(self, gid):
        """The stamp and the id of the request on record, or None."""
        self.cur.execute(
            "SELECT g.credential_revoked_at, q.request_id FROM public.gateways g"
            " LEFT JOIN public.gateway_revocation_requests q ON q.gateway_id = g.id WHERE g.id = %s;", (gid,))
        return self.cur.fetchone()

    def sweep(self):
        self.cur.execute("SELECT public.sweep_gateway_credential_revocations();")
        return self.cur.fetchone()[0]

    def replaced(self, gid):
        self.cur.execute("SELECT public.gateway_credential_was_replaced(g) FROM public.gateways g WHERE g.id = %s;", (gid,))
        return self.cur.fetchone()[0]


class AFailedRevocationIsAskedAgain(RetryBase):
    def test_a_reply_that_is_not_a_2xx_is_asked_again_and_the_stamp_stays(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote")
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        self.assertGreaterEqual(self.sweep(), 1)

        self.assertEqual(self.queue_depth(gid), before + 1, "the failed revocation was not asked again")
        new_stamp, new_request = self.state(gid)
        self.assertEqual(new_stamp, stamp, "the stamp of a revocation being asked again is kept")
        self.assertIsNotNone(new_request)
        self.assertNotEqual(new_request, request_id)

    def test_every_crossing_of_remotes_boundary_is_asked_again(self):
        for start, end in (("host", "remote"), ("simulated", "remote"), ("third_party", "remote"),
                           ("remote", "host"), ("remote", "third_party")):
            with self.subTest(start=start, end=end):
                self.cur.execute("SAVEPOINT crossing;")
                gid, _ = self.gateway(start)
                request_id, stamp = self.change(gid, end)
                self.reply(request_id, 502)
                before = self.queue_depth(gid)
                self.sweep()
                self.assertEqual(self.queue_depth(gid), before + 1)
                self.assertEqual(self.state(gid)[0], stamp)
                self.cur.execute("ROLLBACK TO SAVEPOINT crossing;")

    def test_no_reply_after_five_minutes_is_asked_again(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote", asked=10)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before + 1)
        new_stamp, new_request = self.state(gid)
        self.assertEqual(new_stamp, stamp)
        self.assertNotEqual(new_request, request_id)

    def test_a_request_younger_than_five_minutes_waits(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote", asked=1)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before)
        self.assertEqual(self.state(gid), (stamp, request_id))

    def test_a_2xx_confirms_it_and_it_is_not_asked_again(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote")
        self.reply(request_id, 200)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before)
        self.assertEqual(self.state(gid), (stamp, None), "a confirmed request leaves no row to judge")
        # The verdict outlives pg_net pruning the reply.
        self.cur.execute("DELETE FROM net._http_response WHERE id = %s;", (request_id,))
        self.sweep()
        self.assertEqual(self.queue_depth(gid), before)
        self.assertEqual(self.state(gid), (stamp, None))

    def test_another_calls_2xx_does_not_confirm_it(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote")
        self.reply(request_id, 503)
        self.cur.execute("SELECT coalesce(max(id), 0) + 1000000 FROM net.http_request_queue;")
        self.reply(self.cur.fetchone()[0], 200)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before + 1)

    def test_it_is_asked_again_until_it_succeeds(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote")
        before = self.queue_depth(gid)
        for attempt in range(3):
            with self.subTest(attempt=attempt):
                self.reply(request_id, 503)
                self.sweep()
                self.assertEqual(self.queue_depth(gid), before + attempt + 1)
                new_stamp, new_request = self.state(gid)
                self.assertEqual(new_stamp, stamp)
                self.assertNotEqual(new_request, request_id)
                request_id = new_request
                self.age(gid, 10)
        self.reply(request_id, 200)
        self.sweep()
        self.assertEqual(self.queue_depth(gid), before + 3)
        self.assertEqual(self.state(gid), (stamp, None))
        self.sweep()
        self.assertEqual(self.queue_depth(gid), before + 3, "a confirmed revocation is not asked for again")

    def test_a_run_that_cannot_ask_leaves_the_row_for_the_next(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote")
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        # Without the secret the call is not made: revoke_gateway_credential() answers false.
        self.cur.execute("SAVEPOINT without_secret;")
        self.cur.execute("DELETE FROM vault.secrets WHERE name = 'gateway_revoke_secret';")
        self.sweep()
        self.assertEqual(self.queue_depth(gid), before)
        self.assertEqual(self.state(gid), (stamp, request_id), "a call that was not made drops nothing")
        self.cur.execute("ROLLBACK TO SAVEPOINT without_secret;")

        self.sweep()
        self.assertEqual(self.queue_depth(gid), before + 1)

    def test_only_this_gateways_request_is_asked_again(self):
        failing, _ = self.gateway("host")
        confirmed, _ = self.gateway("host")
        failed_id, _ = self.change(failing, "remote")
        confirmed_id, confirmed_stamp = self.change(confirmed, "remote")
        self.reply(failed_id, 503)
        self.reply(confirmed_id, 200)
        failing_before, confirmed_before = self.queue_depth(failing), self.queue_depth(confirmed)

        self.sweep()

        self.assertEqual(self.queue_depth(failing), failing_before + 1)
        self.assertEqual(self.queue_depth(confirmed), confirmed_before, "a confirmed revocation was asked again")
        self.assertEqual(self.state(confirmed), (confirmed_stamp, None))


class ANewerCredentialStopsTheRetry(RetryBase):
    def test_a_credential_issued_after_the_stamp_is_never_disabled_by_a_retry(self):
        gid, _ = self.gateway("remote")
        request_id, stamp = self.change(gid, "host")
        self.issue(gid, SINCE)
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        for _ in range(3):
            self.sweep()
            self.assertEqual(self.queue_depth(gid), before, "a retry ran after a new credential was issued")

        self.assertEqual(self.state(gid), (stamp, None), "the row of a request a new credential outran is dropped")

    def test_an_enrolment_after_the_stamp_is_never_disabled_by_a_retry(self):
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote")
        self.cur.execute("UPDATE public.gateways SET enrolled_at = now() - make_interval(mins => %s) WHERE id = %s;",
                         (SINCE, gid))
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        for _ in range(3):
            self.sweep()
            self.assertEqual(self.queue_depth(gid), before)

        self.assertEqual(self.state(gid), (stamp, None))

    def test_a_credential_issued_after_a_retry_stops_the_next(self):
        gid, _ = self.gateway("remote")
        request_id, stamp = self.change(gid, "host")
        self.reply(request_id, 503)
        self.sweep()
        retried = self.state(gid)[1]
        self.assertNotEqual(retried, request_id)
        self.age(gid, 10)

        self.issue(gid, 1)
        self.reply(retried, 503)
        before = self.queue_depth(gid)

        self.sweep()
        self.assertEqual(self.queue_depth(gid), before, "the retry ran after the credential was issued")
        self.assertEqual(self.state(gid), (stamp, None))

    def test_a_credential_issued_after_the_stamp_stops_a_request_nobody_answered(self):
        gid, _ = self.gateway("remote")
        _, stamp = self.change(gid, "host", asked=20)
        self.issue(gid, SINCE)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before)
        self.assertEqual(self.state(gid), (stamp, None))

    def test_a_credential_issued_before_the_stamp_stops_nothing(self):
        gid, _ = self.gateway("host")
        request_id, _ = self.change(gid, "remote")
        self.issue(gid, ASKED + 5)
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before + 1)

    def test_another_gateways_credential_stops_nothing(self):
        gid, _ = self.gateway("remote")
        other, _ = self.gateway("host")
        request_id, _ = self.change(gid, "host")
        self.issue(other, SINCE)
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before + 1)

    def test_a_row_of_another_action_stops_nothing(self):
        gid, _ = self.gateway("remote")
        request_id, _ = self.change(gid, "host")
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data, changed_by,"
            "       actor_source, causation_id, recorded_at)"
            " VALUES ('gateways', %s, 'CREDENTIAL_SHOWN', NULL, '{}'::jsonb, NULL, 'service', txid_current(),"
            "         now() - make_interval(mins => %s));", (gid, SINCE))
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before + 1)


class TheArchivePathIsAsItWas(RetryBase):
    def archived_and_asked(self, minutes_ago=10):
        gid, _ = self.gateway("host")
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        self.cur.execute(
            "UPDATE public.gateway_revocation_requests SET requested_at = now() - make_interval(mins => %s)"
            " WHERE gateway_id = %s RETURNING request_id;", (minutes_ago, gid))
        request_id = self.cur.fetchone()[0]
        self.cur.execute(
            "UPDATE public.gateways SET credential_revoked_at = now() - make_interval(mins => %s)"
            " WHERE id = %s RETURNING credential_revoked_at;", (minutes_ago, gid))
        return gid, request_id, self.cur.fetchone()[0]

    def test_a_failed_request_clears_the_stamp_and_is_asked_again_with_a_new_one(self):
        gid, request_id, stamped = self.archived_and_asked()
        self.reply(request_id, 503)
        before = self.queue_depth(gid)

        self.assertGreaterEqual(self.sweep(), 1)

        stamp, new_request = self.state(gid)
        self.assertEqual(self.queue_depth(gid), before + 1)
        self.assertNotEqual(new_request, request_id)
        self.assertNotEqual(stamp, stamped, "an archived gateway's stamp is cleared and written again")

    def test_a_2xx_keeps_the_stamp(self):
        gid, request_id, stamped = self.archived_and_asked()
        self.reply(request_id, 200)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.state(gid), (stamped, None))
        self.assertEqual(self.queue_depth(gid), before)

    def test_an_unanswered_request_younger_than_five_minutes_waits(self):
        gid, request_id, stamped = self.archived_and_asked(minutes_ago=1)
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.state(gid), (stamped, request_id))
        self.assertEqual(self.queue_depth(gid), before)

    def test_restoring_the_gateway_ends_the_request(self):
        gid, request_id, _ = self.archived_and_asked()
        self.reply(request_id, 503)
        self.cur.execute("UPDATE public.gateways SET is_archived = false WHERE id = %s;", (gid,))
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before, "a restored gateway's revocation was asked again")
        self.assertEqual(self.state(gid), (None, None))


class WhatItDoesNotReach(RetryBase):
    def test_a_stamp_with_no_request_row_is_not_asked_for(self):
        """What a change of type before 0288 left: nothing records whether its call landed."""
        gid, _ = self.gateway("host")
        request_id, stamp = self.change(gid, "remote")
        self.cur.execute("DELETE FROM public.gateway_revocation_requests WHERE gateway_id = %s;", (gid,))
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before)
        self.assertEqual(self.state(gid), (stamp, None))

    def test_a_change_among_the_dashboard_issued_types_asks_for_nothing(self):
        gid, _ = self.gateway("host")
        self.cur.execute("UPDATE public.gateways SET deployment = 'third_party' WHERE id = %s;", (gid,))
        before = self.queue_depth(gid)

        self.sweep()

        self.assertEqual(self.queue_depth(gid), before)
        self.assertEqual(self.state(gid), (None, None))


class TheCredentialThatCameAfter(RetryBase):
    def test_it_is_false_for_a_gateway_with_no_stamp(self):
        gid, _ = self.gateway("host")
        self.issue(gid, 1)
        self.assertFalse(self.replaced(gid))

    def test_an_issue_after_the_stamp_is_a_replacement_and_one_before_it_is_not(self):
        gid, _ = self.gateway("remote")
        self.change(gid, "host")
        self.assertFalse(self.replaced(gid))
        self.issue(gid, ASKED + 1)
        self.assertFalse(self.replaced(gid))
        self.issue(gid, SINCE)
        self.assertTrue(self.replaced(gid))

    def test_an_enrolment_after_the_stamp_is_a_replacement_and_one_before_it_is_not(self):
        gid, _ = self.gateway("host")
        self.change(gid, "remote")
        self.cur.execute("UPDATE public.gateways SET enrolled_at = now() - make_interval(mins => %s) WHERE id = %s;",
                         (ASKED + 1, gid))
        self.assertFalse(self.replaced(gid))
        self.cur.execute("UPDATE public.gateways SET enrolled_at = now() - make_interval(mins => %s) WHERE id = %s;",
                         (SINCE, gid))
        self.assertTrue(self.replaced(gid))

    def test_an_issue_at_the_instant_of_the_stamp_is_not_after_it(self):
        gid, _ = self.gateway("remote")
        self.change(gid, "host", asked=ASKED)
        self.issue(gid, ASKED)
        self.assertFalse(self.replaced(gid))

    def test_no_api_role_may_run_it(self):
        for role in ("anon", "authenticated", "service_role"):
            with self.subTest(role=role):
                self.cur.execute(
                    "SELECT has_function_privilege(%s, 'public.gateway_credential_was_replaced(public.gateways)', 'EXECUTE');",
                    (role,))
                self.assertFalse(self.cur.fetchone()[0])

    def test_no_browser_facing_role_may_run_the_sweep(self):
        for role in ("anon", "authenticated"):
            with self.subTest(role=role):
                self.cur.execute(
                    "SELECT has_function_privilege(%s, 'public.sweep_gateway_credential_revocations()', 'EXECUTE');", (role,))
                self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
