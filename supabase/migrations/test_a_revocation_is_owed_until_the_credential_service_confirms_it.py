# suite:
#   lanes: db
#   why: 0311 -- a revocation is owed from the moment a gateway's credential is ended until a 2xx to
#     its own request confirms it: after an archive whatever the gateway's type, after a delete, and
#     when the credential service could not be asked at all. A revocation the sweep stops asking for
#     leaves the broker account enabled while the platform calls it revoked, and nothing errors. It
#     also holds that a change of type away from Remote asks the forge sweep at once.

"""
A revocation is owed until the credential service confirms it (0311).

    python supabase/migrations/test_a_revocation_is_owed_until_the_credential_service_confirms_it.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * An archived gateway is asked again after a failed revocation whatever its type now is: a change
    of type away from Remote, or into it, then an archive, keeps the revocation owed until a 2xx.
  * A deleted gateway keeps what it owed. A revocation unconfirmed when the row goes, asked by an
    archive, a change of type or the delete itself, is kept by its Sparkplug ID and asked again by the
    sweep until a 2xx. One already confirmed is not owed. A gateway made again under the same id and
    given a credential since is not disabled.
  * A revocation that could not be asked, because the credential service is not configured, is owed:
    a change of type, an archive and a delete each record it, and the sweep asks once it can.
  * What an earlier release left, an archived gateway that holds a credential and has no stamp, is
    owed and stamped by the sweep.
  * A change of type away from Remote asks the forge sweep at once, for a gateway with a repository.

EVERY TEST ROLLS BACK. A request is asserted on the pg_net queue and a reply is written into
net._http_response by hand, as test_a_failed_type_change_revocation_is_retried.py does: net.http_post
queues inside the caller's transaction, so the rollback un-queues it. `now()` is one instant inside a
transaction, so a stamp and a request are set back to times of their own. Requests are counted by
the Sparkplug ID in their body, so a debt another suite left behind does not move a count here.
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

# Minutes before now(): the credential the gateway held, and the revocation that ended it.
HELD = 600
ASKED = 30


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class OwedBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.deleted_gateway_revocations');")
                if not cur.fetchone()[0]:
                    raise unittest.SkipTest("0311 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # REPEATABLE READ, so a count sees this test's requests and nothing pg_net's worker does.
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

    def gateway(self, kind="host", gid=None):
        """A gateway holding a broker credential under its type, issued or enrolled long ago."""
        gid = gid or str(uuid.uuid4())
        deployment, simulated = TYPES[kind]
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, is_simulated, status, enrolled_at)"
            " VALUES (%s, %s, 'owed revocation suite', %s, %s, 'OFFLINE',"
            "         CASE WHEN %s THEN now() - make_interval(mins => %s) END) RETURNING sparkplug_id;",
            (gid, f"Test_Owed_{gid[:8]}", deployment, simulated, deployment == "remote", HELD))
        sparkplug_id = self.cur.fetchone()[0]
        if deployment != "remote":
            self.issue(gid, HELD)
        return gid, sparkplug_id

    def set_back(self, gid, minutes=ASKED):
        """Move the stamp and the request back to `minutes` ago. Returns the request id and the stamp."""
        self.cur.execute(
            "UPDATE public.gateways SET credential_revoked_at = now() - make_interval(mins => %s)"
            " WHERE id = %s RETURNING credential_revoked_at;", (minutes, gid))
        stamp = self.cur.fetchone()[0]
        self.cur.execute(
            "UPDATE public.gateway_revocation_requests SET requested_at = now() - make_interval(mins => %s)"
            " WHERE gateway_id = %s RETURNING request_id;", (minutes, gid))
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "no revocation is owed for this gateway")
        return row[0], stamp

    def change(self, gid, kind):
        deployment, simulated = TYPES[kind]
        self.cur.execute("UPDATE public.gateways SET deployment = %s, is_simulated = %s WHERE id = %s;",
                         (deployment, simulated, gid))

    def archive(self, gid):
        self.cur.execute("UPDATE public.gateways SET is_archived = true, archived_at = now() WHERE id = %s;", (gid,))

    def delete(self, gid):
        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (gid,))

    def reply(self, request_id, status):
        self.cur.execute("INSERT INTO net._http_response (id, status_code, content) VALUES (%s, %s, '{}');",
                         (request_id, status))

    def age_deleted(self, sparkplug_id, minutes):
        self.cur.execute(
            "UPDATE public.deleted_gateway_revocations SET requested_at = now() - make_interval(mins => %s)"
            " WHERE sparkplug_id = %s;", (minutes, sparkplug_id))

    def configured(self, value):
        """Take the revoke secret away (None), or put a value back, as an unconfigured stack has it."""
        self.cur.execute("SELECT id FROM vault.secrets WHERE name = 'gateway_revoke_secret';")
        secret_id = self.cur.fetchone()[0]
        self.cur.execute("SELECT vault.update_secret(%s, %s);", (secret_id, value or ""))

    def revoke_secret(self):
        self.cur.execute("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'gateway_revoke_secret';")
        return self.cur.fetchone()[0]

    # -- reads ------------------------------------------------------------------------------------

    def asked(self, sparkplug_id):
        """The revocation requests queued in this transaction for this Sparkplug ID."""
        self.cur.execute(
            "SELECT count(*) FROM net.http_request_queue"
            " WHERE url LIKE '%%/revoke-gateway-credential' AND position(%s::bytea IN body) > 0;",
            (sparkplug_id.encode(),))
        return self.cur.fetchone()[0]

    def owed(self, gid):
        """The stamp, whether a revocation is owed, and its request id."""
        self.cur.execute(
            "SELECT g.credential_revoked_at, q.gateway_id IS NOT NULL, q.request_id FROM public.gateways g"
            " LEFT JOIN public.gateway_revocation_requests q ON q.gateway_id = g.id WHERE g.id = %s;", (gid,))
        return self.cur.fetchone()

    def owed_after_delete(self, sparkplug_id):
        """(gateway_id, request_id) of a deleted gateway's debt, or None."""
        self.cur.execute(
            "SELECT gateway_id::text, request_id FROM public.deleted_gateway_revocations WHERE sparkplug_id = %s;",
            (sparkplug_id,))
        return self.cur.fetchone()

    def forge_sweeps_asked(self):
        self.cur.execute("SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%%/forge-sweep';")
        return self.cur.fetchone()[0]

    def sweep(self):
        self.cur.execute("SELECT public.sweep_gateway_credential_revocations();")
        return self.cur.fetchone()[0]


class AnArchivedGatewayIsAskedAgainWhateverItsType(OwedBase):
    """A change of type, a failed request, then an archive: the archive's type holds no credential."""

    def test_a_remote_gateway_changed_to_host_then_archived_is_asked_until_a_2xx(self):
        gid, sparkplug_id = self.gateway("remote")
        self.change(gid, "host")
        request_id, stamp = self.set_back(gid)
        self.reply(request_id, 503)
        self.archive(gid)
        before = self.asked(sparkplug_id)

        self.sweep()

        self.assertEqual(self.asked(sparkplug_id), before + 1, "the failed revocation was dropped by the archive")
        new_stamp, owed, retried = self.owed(gid)
        self.assertEqual((new_stamp, owed), (stamp, True), "the stamp and the debt stay while it is asked again")
        self.assertNotEqual(retried, request_id)

        # Again after the second call fails, and never after a 2xx.
        self.reply(retried, 502)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 2)
        _, _, third = self.owed(gid)
        self.reply(third, 200)
        self.sweep()
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 2, "a confirmed revocation was asked again")
        self.assertEqual(self.owed(gid), (stamp, False, None))

    def test_a_dashboard_issued_gateway_changed_to_remote_then_archived_is_asked_again(self):
        for kind in ("host", "simulated", "third_party"):
            with self.subTest(kind=kind):
                self.cur.execute("SAVEPOINT kind;")
                gid, sparkplug_id = self.gateway(kind)
                self.change(gid, "remote")
                request_id, stamp = self.set_back(gid)
                self.reply(request_id, 500)
                self.archive(gid)
                before = self.asked(sparkplug_id)
                self.sweep()
                self.assertEqual(self.asked(sparkplug_id), before + 1)
                self.assertEqual(self.owed(gid)[:2], (stamp, True))
                self.cur.execute("ROLLBACK TO SAVEPOINT kind;")

    def test_one_unanswered_five_minutes_on_is_asked_again(self):
        gid, sparkplug_id = self.gateway("remote")
        self.change(gid, "third_party")
        self.set_back(gid, minutes=10)
        self.archive(gid)
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)

    def test_a_young_unanswered_one_waits(self):
        gid, sparkplug_id = self.gateway("remote")
        self.change(gid, "host")
        request_id, stamp = self.set_back(gid, minutes=1)
        self.archive(gid)
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before)
        self.assertEqual(self.owed(gid), (stamp, True, request_id))


class ADeletedGatewayKeepsWhatItOwes(OwedBase):

    def test_a_failed_change_of_type_then_a_delete_is_asked_until_a_2xx(self):
        gid, sparkplug_id = self.gateway("remote")
        self.change(gid, "third_party")
        request_id, _ = self.set_back(gid)
        self.reply(request_id, 503)
        before = self.asked(sparkplug_id)

        self.delete(gid)

        self.assertEqual(self.asked(sparkplug_id), before, "the delete asks nothing it was not owed already")
        self.assertEqual(self.owed_after_delete(sparkplug_id), (gid, request_id), "the debt went with the row")
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1, "the deleted gateway's revocation was not asked again")
        _, retried = self.owed_after_delete(sparkplug_id)
        self.assertNotEqual(retried, request_id, "the retry's request was not recorded against the debt")

        self.reply(retried, 200)
        self.sweep()
        self.assertIsNone(self.owed_after_delete(sparkplug_id), "a confirmed revocation is still owed")
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)

    def test_a_failed_archive_then_a_delete_is_asked_again(self):
        for kind in ("host", "third_party", "remote"):
            with self.subTest(kind=kind):
                self.cur.execute("SAVEPOINT kind;")
                gid, sparkplug_id = self.gateway(kind)
                self.archive(gid)
                request_id, _ = self.set_back(gid)
                self.reply(request_id, 503)
                self.delete(gid)
                before = self.asked(sparkplug_id)
                self.sweep()
                self.assertEqual(self.asked(sparkplug_id), before + 1)
                self.cur.execute("ROLLBACK TO SAVEPOINT kind;")

    def test_a_delete_of_a_gateway_holding_a_credential_asks_at_once_and_keeps_the_debt(self):
        gid, sparkplug_id = self.gateway("host")
        before = self.asked(sparkplug_id)
        self.delete(gid)
        self.assertEqual(self.asked(sparkplug_id), before + 1)
        owed = self.owed_after_delete(sparkplug_id)
        self.assertIsNotNone(owed)
        self.assertIsNotNone(owed[1], "the delete's own request is the one the sweep judges")
        self.reply(owed[1], 503)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 2)

    def test_a_revocation_already_confirmed_is_not_owed_after_a_delete(self):
        gid, sparkplug_id = self.gateway("host")
        self.archive(gid)
        request_id, _ = self.set_back(gid)
        self.reply(request_id, 200)
        before = self.asked(sparkplug_id)
        self.delete(gid)
        self.assertIsNone(self.owed_after_delete(sparkplug_id))
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before)

    def test_a_young_request_waits_after_a_delete_then_is_asked_again(self):
        gid, sparkplug_id = self.gateway("remote")
        self.archive(gid)
        self.set_back(gid, minutes=1)
        self.delete(gid)
        before = self.asked(sparkplug_id)
        self.age_deleted(sparkplug_id, 1)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before)
        self.age_deleted(sparkplug_id, 10)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)

    def test_a_gateway_made_again_under_the_id_and_given_a_credential_is_not_disabled(self):
        gid, sparkplug_id = self.gateway("host")
        self.delete(gid)
        request_id = self.owed_after_delete(sparkplug_id)[1]
        self.reply(request_id, 503)
        self.cur.execute(
            "UPDATE public.deleted_gateway_revocations SET owed_since = now() - interval '20 minutes',"
            " requested_at = now() - interval '20 minutes' WHERE sparkplug_id = %s;", (sparkplug_id,))
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, status)"
            " VALUES (%s, 'Test_Owed_again', 'owed revocation suite', 'host', 'OFFLINE');", (gid,))
        self.issue(gid, 10)
        before = self.asked(sparkplug_id)

        self.sweep()

        self.assertEqual(self.asked(sparkplug_id), before, "the new gateway's credential was disabled")
        self.assertIsNone(self.owed_after_delete(sparkplug_id))

    def test_a_gateway_made_again_under_the_id_with_no_credential_is_still_asked(self):
        gid, sparkplug_id = self.gateway("host")
        self.delete(gid)
        self.reply(self.owed_after_delete(sparkplug_id)[1], 503)
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, status)"
            " VALUES (%s, 'Test_Owed_again', 'owed revocation suite', 'host', 'OFFLINE');", (gid,))
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)

    def test_a_delete_of_a_gateway_that_held_none_owes_nothing(self):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, status)"
            " VALUES (%s, %s, 'owed revocation suite', 'host', 'OFFLINE') RETURNING sparkplug_id;",
            (gid, f"Test_Owed_{gid[:8]}"))
        sparkplug_id = self.cur.fetchone()[0]
        self.delete(gid)
        self.assertIsNone(self.owed_after_delete(sparkplug_id))
        self.assertEqual(self.asked(sparkplug_id), 0)

    def test_only_the_service_may_read_the_debts_and_no_api_role_may_owe_one(self):
        for role in ("anon", "authenticated"):
            with self.subTest(role=role):
                self.cur.execute("SELECT has_table_privilege(%s, 'public.deleted_gateway_revocations', 'SELECT');", (role,))
                self.assertFalse(self.cur.fetchone()[0])
        self.cur.execute("SELECT has_table_privilege('service_role', 'public.deleted_gateway_revocations', 'SELECT'),"
                         "       has_table_privilege('service_role', 'public.deleted_gateway_revocations', 'DELETE');")
        self.assertEqual(self.cur.fetchone(), (True, False))
        for role in ("anon", "authenticated", "service_role"):
            with self.subTest(role=role):
                self.cur.execute("SELECT has_function_privilege(%s, 'public.owe_gateway_revocation(text)', 'EXECUTE');", (role,))
                self.assertFalse(self.cur.fetchone()[0])


class ARevocationThatCannotBeAskedIsOwed(OwedBase):

    def setUp(self):
        super().setUp()
        self.secret = self.revoke_secret()
        self.assertTrue(self.secret, "this database has no revoke secret to take away")

    def test_a_change_of_type_is_stamped_and_owed_and_asked_once_it_can_be(self):
        gid, sparkplug_id = self.gateway("remote")
        self.configured(None)
        before = self.asked(sparkplug_id)

        self.change(gid, "host")

        stamp, owed, request_id = self.owed(gid)
        self.assertIsNotNone(stamp, "the change is the revocation, asked or not")
        self.assertEqual((owed, request_id), (True, None))
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before)
        self.assertEqual(self.owed(gid), (stamp, True, None), "a run that cannot ask drops nothing")

        self.configured(self.secret)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)
        new_stamp, owed, request_id = self.owed(gid)
        self.assertEqual((new_stamp, owed), (stamp, True))
        self.assertIsNotNone(request_id)

    def test_every_crossing_of_remotes_boundary_is_owed(self):
        for start, end in (("remote", "host"), ("remote", "third_party"), ("host", "remote"),
                           ("simulated", "remote"), ("third_party", "remote")):
            with self.subTest(start=start, end=end):
                self.cur.execute("SAVEPOINT crossing;")
                gid, _ = self.gateway(start)
                self.configured(None)
                self.change(gid, end)
                stamp, owed, request_id = self.owed(gid)
                self.assertIsNotNone(stamp)
                self.assertEqual((owed, request_id), (True, None))
                self.cur.execute("ROLLBACK TO SAVEPOINT crossing;")

    def test_an_archive_is_stamped_and_owed(self):
        gid, sparkplug_id = self.gateway("host")
        self.configured(None)
        self.archive(gid)
        stamp, owed, request_id = self.owed(gid)
        self.assertIsNotNone(stamp)
        self.assertEqual((owed, request_id), (True, None))
        self.configured(self.secret)
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)

    def test_a_change_of_type_then_a_delete_is_still_owed(self):
        gid, sparkplug_id = self.gateway("remote")
        self.configured(None)
        self.change(gid, "host")
        self.delete(gid)
        self.assertEqual(self.owed_after_delete(sparkplug_id), (gid, None))
        self.configured(self.secret)
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)
        self.assertIsNotNone(self.owed_after_delete(sparkplug_id)[1])

    def test_a_new_revocation_does_not_take_an_earlier_ones_2xx_for_its_own(self):
        gid, sparkplug_id = self.gateway("host")
        self.archive(gid)
        request_id, _ = self.set_back(gid)
        self.reply(request_id, 200)
        # Restored and issued a credential before the sweep dropped the confirmed row, then archived
        # again while the service cannot be asked.
        self.cur.execute("UPDATE public.gateways SET is_archived = false, archived_at = NULL WHERE id = %s;", (gid,))
        self.issue(gid, 10)
        self.configured(None)
        self.archive(gid)
        self.assertEqual(self.owed(gid)[1:], (True, None), "the new revocation kept the old request")
        self.configured(self.secret)
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1, "the old request's 2xx confirmed the new revocation")


class WhatAnEarlierReleaseLeft(OwedBase):

    def leftover(self):
        """An archived gateway holding a credential with no stamp and no debt: a cleared failure."""
        gid, sparkplug_id = self.gateway("host")
        self.archive(gid)
        self.cur.execute("UPDATE public.gateways SET credential_revoked_at = NULL WHERE id = %s;", (gid,))
        self.cur.execute("DELETE FROM public.gateway_revocation_requests WHERE gateway_id = %s;", (gid,))
        return gid, sparkplug_id

    def test_it_is_owed_and_stamped_by_the_sweep(self):
        gid, sparkplug_id = self.leftover()
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1)
        stamp, owed, request_id = self.owed(gid)
        self.assertIsNotNone(stamp)
        self.assertTrue(owed)
        self.assertIsNotNone(request_id)

    def test_one_whose_type_changed_before_its_stamp_was_cleared_is_owed_too(self):
        """A Remote gateway changed to Host and archived; an earlier sweep cleared its failed stamp."""
        gid, sparkplug_id = self.gateway("remote")
        self.change(gid, "host")
        self.archive(gid)
        self.cur.execute("UPDATE public.gateways SET credential_revoked_at = NULL WHERE id = %s;", (gid,))
        self.cur.execute("DELETE FROM public.gateway_revocation_requests WHERE gateway_id = %s;", (gid,))
        before = self.asked(sparkplug_id)
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), before + 1, "the old type's account is left enabled")
        self.assertEqual(self.owed(gid)[1], True)

    def test_an_archived_gateway_that_never_held_one_is_left_alone(self):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, status, is_archived)"
            " VALUES (%s, %s, 'owed revocation suite', 'remote', 'OFFLINE', true) RETURNING sparkplug_id;",
            (gid, f"Test_Owed_{gid[:8]}"))
        sparkplug_id = self.cur.fetchone()[0]
        self.sweep()
        self.assertEqual(self.asked(sparkplug_id), 0)
        self.assertEqual(self.owed(gid), (None, False, None))

    def test_it_is_owed_and_stamped_even_when_it_cannot_be_asked(self):
        gid, sparkplug_id = self.leftover()
        self.configured(None)
        self.sweep()
        stamp, owed, request_id = self.owed(gid)
        self.assertIsNotNone(stamp)
        self.assertEqual((owed, request_id), (True, None))
        # So a change of type made now cannot lose it.
        self.change(gid, "remote")
        self.assertEqual(self.owed(gid)[1], True)


class LeavingRemoteAsksTheForge(OwedBase):

    def with_repository(self, gid):
        self.cur.execute("UPDATE public.gateways SET forge_repository_at = now() WHERE id = %s;", (gid,))

    def test_a_remote_gateway_with_a_repository_that_leaves_remote_asks_the_forge_at_once(self):
        gid, _ = self.gateway("remote")
        self.with_repository(gid)
        before = self.forge_sweeps_asked()
        self.change(gid, "host")
        self.assertEqual(self.forge_sweeps_asked(), before + 1, "the deploy key waits for the next quarter hour")

    def test_nothing_is_asked_without_a_repository_on_the_way_in_or_for_an_archived_gateway(self):
        no_repository, _ = self.gateway("remote")
        entering, _ = self.gateway("host")
        self.with_repository(entering)
        archived, _ = self.gateway("remote")
        self.with_repository(archived)
        self.archive(archived)
        before = self.forge_sweeps_asked()
        self.change(no_repository, "host")
        self.change(entering, "remote")
        self.change(archived, "third_party")
        self.assertEqual(self.forge_sweeps_asked(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
