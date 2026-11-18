# suite:
#   lanes: db
#   why: 0308 -- a Remote gateway's enrolment counts as a broker credential held only while no
#     revocation came after it, as the dashboard reads it, and a restore leaves the stamp that records
#     the revocation. A reader that counted a credential after its revocation would ask the broker to
#     disable an account that is already disabled, tell a person in the Edit dialog that saving ends a
#     credential the gateway does not hold, and show a restored gateway's disabled account as issued.

"""
What gateway_has_broker_credential() counts for a Remote gateway, and what a restore leaves (0196, 0308).

    python supabase/migrations/test_a_revoked_credential_stays_revoked_until_a_new_one_is_issued.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * The function counts a Remote gateway's enrolment only while no revocation came after it: an
    enrolment with no stamp, and one newer than the stamp, are held; one the stamp is newer than, and
    a gateway that never enrolled, are not.
  * The two triggers that ask the broker to disable an account when a gateway is archived or deleted
    read it, so a Remote gateway whose enrolment a revocation followed is asked for nothing and is not
    stamped again, and one enrolled after the revocation is asked for as any other.
  * A restore leaves credential_revoked_at as the archive wrote it, for a Remote gateway and for one
    issued a credential in the dashboard, so neither counts its old credential again. A credential
    issued, or an enrolment, after the stamp counts, and a gateway never revoked is left unstamped.

EVERY TEST ROLLS BACK. A request is read off the pg_net queue, which net.http_post fills inside the
caller's transaction, so the rollback un-queues it and nothing reaches a credential service. `now()`
is one instant inside a transaction, so the enrolment and the stamp are set to times of their own.
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

# Minutes before now(): what a gateway's enrolment and a revocation older than it read as.
LONG_AGO = 60
LATER = 10


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    # REPEATABLE READ, so the queue counts the requests this test queued and nothing else.
    conn.set_session(isolation_level="REPEATABLE READ")
    return conn


class RemoteEnrolment(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def gateway(self, enrolled=None, stamped=None, deployment="remote"):
        """A gateway enrolled `enrolled` minutes ago, its revocation stamped `stamped` minutes ago."""
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, status, enrolled_at, credential_revoked_at)"
            " VALUES (%s, %s, 'revoked credential suite', %s, 'OFFLINE',"
            "         now() - make_interval(mins => %s), now() - make_interval(mins => %s))"
            " RETURNING sparkplug_id;",
            (gid, f"Test_Revoked_{gid[:8]}", deployment, enrolled, stamped))
        return gid, self.cur.fetchone()[0]

    def record_issue(self, gid, minutes_ago):
        """The CREDENTIAL_ISSUED row a credential minted in the dashboard leaves, as of `minutes_ago`."""
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data, changed_by,"
            "       actor_source, causation_id, recorded_at)"
            " VALUES ('gateways', %s, 'CREDENTIAL_ISSUED', NULL, '{}'::jsonb, NULL, 'service', txid_current(),"
            "         now() - make_interval(mins => %s));", (gid, minutes_ago))

    def archive(self, gid):
        self.cur.execute("UPDATE public.gateways SET is_archived = true, archived_at = now() WHERE id = %s;", (gid,))

    def restore(self, gid):
        self.cur.execute("UPDATE public.gateways SET is_archived = false, archived_at = NULL WHERE id = %s;", (gid,))

    def holds(self, gid):
        self.cur.execute("SELECT public.gateway_has_broker_credential(g) FROM public.gateways g WHERE g.id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def stamp(self, gid):
        self.cur.execute("SELECT credential_revoked_at FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def stamped_just_now(self, gid):
        self.cur.execute("SELECT credential_revoked_at >= now() - interval '1 minute' FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def revocations_asked(self, sparkplug_id):
        self.cur.execute(
            "SELECT count(*) FROM net.http_request_queue"
            " WHERE url LIKE '%%/revoke-gateway-credential' AND position(%s::bytea IN body) > 0;",
            (sparkplug_id.encode(),))
        return self.cur.fetchone()[0]

    def test_an_enrolment_is_held_only_while_no_revocation_came_after_it(self):
        cases = [
            ("enrolled, never revoked", dict(enrolled=LONG_AGO), True),
            ("enrolled after the revocation", dict(enrolled=LATER, stamped=LONG_AGO), True),
            ("revoked after it enrolled", dict(enrolled=LONG_AGO, stamped=LATER), False),
            ("never enrolled", dict(), False),
            ("never enrolled, and a stamp", dict(stamped=LATER), False),
        ]
        for name, columns, held in cases:
            with self.subTest(case=name):
                gid, _ = self.gateway(**columns)
                self.assertEqual(self.holds(gid), held)

    def test_archiving_asks_for_nothing_where_a_revocation_followed_the_enrolment(self):
        gid, sparkplug_id = self.gateway(enrolled=LONG_AGO, stamped=LATER)
        stamped = self.stamp(gid)
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        self.assertEqual(self.revocations_asked(sparkplug_id), 0)
        self.assertEqual(self.stamp(gid), stamped, "the stamp was written again for an account already disabled")

    def test_deleting_asks_for_nothing_where_a_revocation_followed_the_enrolment(self):
        gid, sparkplug_id = self.gateway(enrolled=LONG_AGO, stamped=LATER)
        self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (gid,))
        self.assertEqual(self.revocations_asked(sparkplug_id), 0)

    def test_archiving_and_deleting_ask_for_an_enrolment_no_revocation_followed(self):
        for name, columns in (("never revoked", dict(enrolled=LONG_AGO)),
                              ("enrolled after the revocation", dict(enrolled=LATER, stamped=LONG_AGO))):
            with self.subTest(case=name):
                self.cur.execute("SAVEPOINT walk;")
                archived, archived_id = self.gateway(**columns)
                self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (archived,))
                self.assertEqual(self.revocations_asked(archived_id), 1)
                self.assertTrue(self.stamped_just_now(archived), "an account asked for was not stamped")
                deleted, deleted_id = self.gateway(**columns)
                self.cur.execute("DELETE FROM public.gateways WHERE id = %s;", (deleted,))
                self.assertEqual(self.revocations_asked(deleted_id), 1)
                self.cur.execute("ROLLBACK TO SAVEPOINT walk;")

    def test_a_restore_leaves_the_stamp_the_archive_wrote_and_the_old_credential_is_not_counted(self):
        remote, _ = self.gateway(enrolled=LONG_AGO)
        host, _ = self.gateway(deployment="host")
        self.record_issue(host, LONG_AGO)
        for name, gid in (("remote", remote), ("host", host)):
            with self.subTest(deployment=name):
                self.assertTrue(self.holds(gid))
                self.archive(gid)
                stamped = self.stamp(gid)
                self.assertIsNotNone(stamped, "archiving a gateway that holds a credential stamps it")
                self.restore(gid)
                self.assertEqual(self.stamp(gid), stamped)
                self.assertFalse(self.holds(gid), "the account is still disabled")

    def test_a_credential_after_the_stamp_counts_once_the_gateway_is_restored(self):
        remote, _ = self.gateway(enrolled=LONG_AGO)
        host, _ = self.gateway(deployment="host")
        self.record_issue(host, LONG_AGO)
        for gid in (remote, host):
            self.archive(gid)
            self.restore(gid)
            self.cur.execute(
                "UPDATE public.gateways SET credential_revoked_at = now() - interval '30 minutes' WHERE id = %s;", (gid,))
        self.cur.execute("UPDATE public.gateways SET enrolled_at = now() - interval '5 minutes' WHERE id = %s;", (remote,))
        self.record_issue(host, 5)
        self.assertTrue(self.holds(remote), "the appliance enrolled after the revocation")
        self.assertTrue(self.holds(host), "a credential was issued after the revocation")

    def test_a_gateway_never_revoked_is_not_stamped_by_a_restore(self):
        gid, _ = self.gateway()
        self.archive(gid)
        self.restore(gid)
        self.assertIsNone(self.stamp(gid))


if __name__ == "__main__":
    unittest.main(verbosity=2)
