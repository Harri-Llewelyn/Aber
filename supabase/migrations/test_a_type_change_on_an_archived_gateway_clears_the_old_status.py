# suite:
#   lanes: db
#   why: 0310 -- changing the type of an ARCHIVED gateway across Remote's boundary sets its status as it
#     does for a gateway that is not archived, and still ends nothing else: its setup tokens and its
#     credential were ended when it was archived. A status left behind would read Awaiting setup, or
#     keep a Remote gateway's enrolment state under a type that never enrols, when it is restored.

"""
A change of type on an archived gateway clears the old type's status (0252, 0310).

    python supabase/migrations/test_a_type_change_on_an_archived_gateway_clears_the_old_status.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here, for a gateway that is archived:

  * Leaving Remote mid-enrolment (PENDING_ENROLLMENT or AWAITING_BIRTH), and becoming Remote, read
    OFFLINE, at once and after a restore. A gateway that leaves Remote in any other state keeps its
    own word, and a change among Host, Simulated and Third-party changes nothing.
  * Nothing else follows: no revocation is asked, the stamp the archive wrote is left as it is, and
    the change and the status are one audited row.
  * A gateway that is not archived is cleaned up as 0252 has it, so the two agree.

EVERY TEST ROLLS BACK. A revocation is read off the pg_net queue, which net.http_post fills inside the
caller's transaction, so the rollback un-queues it and nothing reaches a credential service.
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
    "third_party": ("third_party", False),
    "host": ("host", False),
    "simulated": ("host", True),
}


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    # REPEATABLE READ, so the queue counts the requests this test queued and nothing else.
    conn.set_session(isolation_level="REPEATABLE READ")
    return conn


class ATypeChangeOnAnArchivedGateway(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def gateway(self, kind, status, enrolled=False, archived=False):
        gid = str(uuid.uuid4())
        deployment, simulated = TYPES[kind]
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, is_simulated, status, enrolled_at)"
            " VALUES (%s, %s, 'archived type change suite', %s, %s, %s,"
            "         CASE WHEN %s THEN now() - interval '1 hour' END) RETURNING sparkplug_id;",
            (gid, f"Test_ArchivedChange_{gid[:8]}", deployment, simulated, status, enrolled))
        sparkplug_id = self.cur.fetchone()[0]
        if archived:
            self.cur.execute("UPDATE public.gateways SET is_archived = true, archived_at = now() WHERE id = %s;", (gid,))
        return gid, sparkplug_id

    def change(self, gid, kind):
        deployment, simulated = TYPES[kind]
        self.cur.execute("UPDATE public.gateways SET deployment = %s, is_simulated = %s WHERE id = %s;",
                         (deployment, simulated, gid))

    def restore(self, gid):
        self.cur.execute("UPDATE public.gateways SET is_archived = false, archived_at = NULL WHERE id = %s;", (gid,))

    def status(self, gid):
        self.cur.execute("SELECT status FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def stamp(self, gid):
        self.cur.execute("SELECT credential_revoked_at FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def asked(self, sparkplug_id):
        self.cur.execute(
            "SELECT count(*) FROM net.http_request_queue"
            " WHERE url LIKE '%%/revoke-gateway-credential' AND position(%s::bytea IN body) > 0;",
            (sparkplug_id.encode(),))
        return self.cur.fetchone()[0]

    def trail_rows(self, gid):
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def test_leaving_remote_mid_enrolment_reads_offline_at_once_and_after_a_restore(self):
        for status, enrolled in (("PENDING_ENROLLMENT", False), ("AWAITING_BIRTH", True)):
            for end in ("host", "third_party", "simulated"):
                with self.subTest(status=status, end=end):
                    self.cur.execute("SAVEPOINT walk;")
                    gid, _ = self.gateway("remote", status, enrolled=enrolled, archived=True)
                    self.change(gid, end)
                    self.assertEqual(self.status(gid), "OFFLINE")
                    self.restore(gid)
                    self.assertEqual(self.status(gid), "OFFLINE")
                    self.cur.execute("ROLLBACK TO SAVEPOINT walk;")

    def test_a_gateway_that_becomes_remote_reads_offline(self):
        for kind in ("host", "third_party", "simulated"):
            with self.subTest(kind=kind):
                self.cur.execute("SAVEPOINT walk;")
                gid, _ = self.gateway(kind, "ONLINE", archived=True)
                self.change(gid, "remote")
                self.assertEqual(self.status(gid), "OFFLINE")
                self.cur.execute("ROLLBACK TO SAVEPOINT walk;")

    def test_a_remote_gateway_that_was_online_keeps_its_own_word(self):
        gid, _ = self.gateway("remote", "ONLINE", enrolled=True, archived=True)
        self.change(gid, "host")
        self.assertEqual(self.status(gid), "ONLINE")

    def test_a_change_among_the_dashboard_issued_types_changes_nothing(self):
        gid, _ = self.gateway("host", "ONLINE", archived=True)
        for kind in ("third_party", "simulated", "host"):
            self.change(gid, kind)
            self.assertEqual(self.status(gid), "ONLINE")

    def test_nothing_else_follows_for_an_archived_gateway(self):
        gid, sparkplug_id = self.gateway("remote", "AWAITING_BIRTH", enrolled=True, archived=True)
        asked, stamped, rows = self.asked(sparkplug_id), self.stamp(gid), self.trail_rows(gid)
        self.assertEqual(asked, 1, "archiving an enrolled gateway asks for its account")

        self.change(gid, "host")

        self.assertEqual(self.asked(sparkplug_id), asked, "an archived gateway's account was ended when it was archived")
        self.assertEqual(self.stamp(gid), stamped)
        self.assertEqual(self.trail_rows(gid), rows + 1, "the change and the status are one audited row")

    def test_a_gateway_that_is_not_archived_is_cleaned_up_as_before(self):
        gid, sparkplug_id = self.gateway("remote", "AWAITING_BIRTH", enrolled=True)
        self.change(gid, "host")
        self.assertEqual(self.status(gid), "OFFLINE")
        self.assertEqual(self.asked(sparkplug_id), 1)
        self.assertIsNotNone(self.stamp(gid))


if __name__ == "__main__":
    unittest.main(verbosity=2)
