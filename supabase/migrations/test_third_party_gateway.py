"""
A Third-party gateway is issued its broker credential in the dashboard (0196).

    python supabase/migrations/test_third_party_gateway.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: `third_party` is a deployment the table accepts, and a replay of 0001 leaves the
widened CHECK alone over a Third-party row. Such a gateway may be minted a credential and have its
copy shown again, cannot be issued an enrolment bundle, and counts as holding an account once
issued, so archiving it disables that account. Remote and Host gateways answer as they did.

EVERY TEST ROLLS BACK. The suite writes Audit Trail rows, Vault secrets and revocation requests,
and none of it is committed: a rolled-back net.http_post is never sent.
"""
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
from psycopg2 import errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATIONS = Path(__file__).resolve().parent

ADMIN_ID = "a0d17070-0000-4000-8000-0000000196a1"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000196b2"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class ThirdPartyBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                    " WHERE conname = 'gateways_deployment_valid'"
                    " AND conrelid = 'public.gateways'::regclass;"
                )
                row = cur.fetchone()
                if not row or "third_party" not in row[0]:
                    raise unittest.SkipTest("0196 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()
        baseline = (MIGRATIONS / "0001_baseline_schema.sql").read_text(encoding="utf-8")
        # The guarded CHECK block exactly as 0001 replays it on every boot.
        cls.baseline_check = re.search(
            r"DO \$c\$ BEGIN\n(?:(?!END \$c\$;).)*?conname = 'gateways_deployment_valid'.*?END \$c\$;",
            baseline, re.S,
        ).group(0)

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # People, not just role grants: audit_trail.changed_by references auth.users.
        for user_id in (ADMIN_ID, MANAGER_ID):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, %s)"
                " ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@third-party.test", "not-a-real-hash"),
            )
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
            " ON CONFLICT (user_id, role_id) DO NOTHING;",
            (ADMIN_ID, roles["Administrator"], MANAGER_ID, roles["Shopfloor_Manager"]),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def gateway(self, deployment="third_party", **columns):
        gid = str(uuid.uuid4())
        names = ["id", "name", "description", "deployment", *columns]
        values = [gid, f"Test_ThirdParty_{gid[:8]}", "third-party suite", deployment, *columns.values()]
        self.cur.execute(
            f"INSERT INTO public.gateways ({', '.join(names)}) VALUES ({', '.join(['%s'] * len(values))})"
            " RETURNING sparkplug_id;",
            values,
        )
        return gid, self.cur.fetchone()[0]

    def as_user(self, user_id):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))

    def as_owner(self):
        self.cur.execute("RESET ROLE;")

    def call(self, user_id, sql, params):
        self.as_user(user_id)
        try:
            self.cur.execute(sql, params)
            return self.cur.fetchall()
        finally:
            self.as_owner()

    def refused(self, error, user_id, sql, params):
        """The call raises `error`; the transaction carries on past it. Returns the exception."""
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(error) as raised:
            self.as_user(user_id)
            self.cur.execute(sql, params)
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.as_owner()
        return raised.exception

    def has_credential(self, gid):
        self.cur.execute(
            "SELECT public.gateway_has_broker_credential(g) FROM public.gateways g WHERE g.id = %s;",
            (gid,),
        )
        return self.cur.fetchone()[0]


class TheTableAcceptsIt(ThirdPartyBase):

    def test_a_third_party_gateway_can_be_stored(self):
        gid, sparkplug_id = self.gateway()
        self.cur.execute("SELECT deployment FROM public.gateways WHERE id = %s;", (gid,))
        self.assertEqual(self.cur.fetchone()[0], "third_party")
        self.assertTrue(sparkplug_id)

    def test_any_other_value_is_still_refused(self):
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(errors.CheckViolation):
            self.gateway("elsewhere")
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")

    def test_a_simulated_gateway_still_runs_on_the_host(self):
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(errors.CheckViolation):
            self.gateway("third_party", is_simulated=True)
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")

    def test_a_replay_of_0001_leaves_the_check_alone_over_a_third_party_row(self):
        # 0001 drops a CHECK whose definition differs from its own and adds its own, which scans the
        # rows: its own must admit third_party, or the next boot fails here.
        self.gateway()
        oid = "SELECT oid FROM pg_constraint WHERE conname = 'gateways_deployment_valid';"
        self.cur.execute(oid)
        before = self.cur.fetchall()
        self.cur.execute(self.baseline_check)
        self.cur.execute(oid)
        self.assertEqual(self.cur.fetchall(), before, "0001's replay dropped and re-added the CHECK")


class TheMint(ThirdPartyBase):
    AUTHORIZE = "SELECT * FROM public.authorize_host_gateway_credential(%s);"

    def test_a_third_party_gateway_may_be_minted(self):
        gid, sparkplug_id = self.gateway()
        rows = self.call(MANAGER_ID, self.AUTHORIZE, (gid,))
        self.assertEqual(rows, [(sparkplug_id, f"Test_ThirdParty_{gid[:8]}")])

    def test_a_host_gateway_may_still_be_minted(self):
        gid, sparkplug_id = self.gateway("host")
        self.assertEqual(self.call(MANAGER_ID, self.AUTHORIZE, (gid,))[0][0], sparkplug_id)

    def test_a_remote_gateway_is_still_refused(self):
        gid, _ = self.gateway("remote")
        refusal = self.refused(errors.InvalidParameterValue, MANAGER_ID, self.AUTHORIZE, (gid,))
        self.assertIn("use an enrolment bundle", str(refusal))

    def test_an_archived_third_party_gateway_is_refused(self):
        gid, _ = self.gateway(is_archived=True)
        refusal = self.refused(errors.InvalidParameterValue, MANAGER_ID, self.AUTHORIZE, (gid,))
        self.assertIn("is archived", str(refusal))


class TheCopyShownAgain(ThirdPartyBase):
    KEEP = "SELECT public.keep_gateway_credential(%s, %s);"
    SHOW = "SELECT mqtt_username, password FROM public.show_gateway_credential(%s);"

    def test_its_copy_is_kept_and_shown_and_the_showing_recorded(self):
        gid, sparkplug_id = self.gateway()
        self.assertEqual(self.call(MANAGER_ID, self.KEEP, (gid, "third-party-password")), [(True,)])
        self.assertEqual(self.call(ADMIN_ID, self.SHOW, (gid,)), [(sparkplug_id, "third-party-password")])
        self.cur.execute(
            "SELECT changed_by::text, new_data::text FROM public.audit_trail"
            " WHERE entity_id = %s AND action = 'CREDENTIAL_SHOWN';",
            (gid,),
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], ADMIN_ID)
        self.assertNotIn("third-party-password", rows[0][1])

    def test_only_an_administrator_may_show_it(self):
        gid, _ = self.gateway()
        self.call(MANAGER_ID, self.KEEP, (gid, "secret"))
        self.refused(errors.InsufficientPrivilege, MANAGER_ID, self.SHOW, (gid,))

    def test_a_remote_gateway_still_keeps_none(self):
        gid, _ = self.gateway("remote")
        self.assertEqual(self.call(MANAGER_ID, self.KEEP, (gid, "secret")), [(False,)])

    def test_archiving_it_removes_the_copy(self):
        gid, _ = self.gateway()
        self.call(MANAGER_ID, self.KEEP, (gid, "secret"))
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        self.cur.execute(
            "SELECT count(*) FROM vault.secrets WHERE name = %s;", (f"gateway_broker_password:{gid}",)
        )
        self.assertEqual(self.cur.fetchone()[0], 0)


class TheBundle(ThirdPartyBase):
    ISSUE = "SELECT token FROM public.issue_gateway_enrollment_token(%s);"

    def tokens(self, gid):
        self.cur.execute("SELECT count(*) FROM public.gateway_enrollment_tokens WHERE gateway_id = %s;", (gid,))
        return self.cur.fetchone()[0]

    def test_a_third_party_gateway_cannot_get_one(self):
        gid, _ = self.gateway()
        refusal = self.refused(errors.InvalidParameterValue, MANAGER_ID, self.ISSUE, (gid,))
        self.assertIn("Third-party", str(refusal))
        self.assertIn("issue its broker credential instead", str(refusal))
        self.assertEqual(self.tokens(gid), 0)
        self.cur.execute("SELECT status FROM public.gateways WHERE id = %s;", (gid,))
        self.assertNotEqual(self.cur.fetchone()[0], "PENDING_ENROLLMENT")

    def test_a_host_gateway_still_cannot_get_one(self):
        gid, _ = self.gateway("host")
        refusal = self.refused(errors.InvalidParameterValue, MANAGER_ID, self.ISSUE, (gid,))
        self.assertIn("runs on this host", str(refusal))

    def test_a_remote_gateway_still_gets_one(self):
        gid, _ = self.gateway("remote")
        self.assertEqual(len(self.call(MANAGER_ID, self.ISSUE, (gid,))[0][0]), 64)
        self.assertEqual(self.tokens(gid), 1)


class TheAccountItHolds(ThirdPartyBase):

    def issue(self, gid):
        self.call(MANAGER_ID, "SELECT public.record_gateway_credential_issued(%s);", (gid,))

    def queue_depth(self):
        self.cur.execute("SELECT count(*) FROM net.http_request_queue;")
        return self.cur.fetchone()[0]

    def test_it_holds_none_until_issued_one(self):
        gid, _ = self.gateway()
        self.assertFalse(self.has_credential(gid))
        self.issue(gid)
        self.assertTrue(self.has_credential(gid))

    def test_a_revocation_after_the_issue_ends_it(self):
        gid, _ = self.gateway()
        self.issue(gid)
        self.cur.execute(
            "UPDATE public.gateways SET credential_revoked_at = now() + interval '1 second' WHERE id = %s;",
            (gid,),
        )
        self.assertFalse(self.has_credential(gid))

    def test_archiving_it_disables_its_account(self):
        gid, _ = self.gateway()
        self.issue(gid)
        before = self.queue_depth()
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        self.assertEqual(self.queue_depth(), before + 1, "archiving queued no revocation")
        self.cur.execute("SELECT credential_revoked_at FROM public.gateways WHERE id = %s;", (gid,))
        self.assertIsNotNone(self.cur.fetchone()[0])

    def test_one_never_issued_is_passed_over_on_archive(self):
        gid, _ = self.gateway()
        before = self.queue_depth()
        self.cur.execute("UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))
        self.assertEqual(self.queue_depth(), before)

    def test_remote_and_host_answer_as_before(self):
        remote, _ = self.gateway("remote")
        self.assertFalse(self.has_credential(remote))
        self.cur.execute("UPDATE public.gateways SET enrolled_at = now() WHERE id = %s;", (remote,))
        self.assertTrue(self.has_credential(remote))

        host, _ = self.gateway("host")
        self.assertFalse(self.has_credential(host))
        self.issue(host)
        self.assertTrue(self.has_credential(host))


if __name__ == "__main__":
    unittest.main(verbosity=2)
