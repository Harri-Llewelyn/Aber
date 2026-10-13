"""
The release check's one row (0181), which the account menu reads, and the principal that writes it.

The opt-in daily CronJob records what GitHub's latest Aber release is through
`record_release_check()`, as Service_ReleaseCheck, a machine principal of its own. Five
properties, each of which would fail quietly:

- One row, replaced by each check, so the menu never reads yesterday's answer beside today's.
- A failed check keeps only its reason. The menu shows nothing for it, never a stale "available".
- The gate refuses what the menu could not show safely: a version that is not MAJOR.MINOR.PATCH, a
  link that is not a release of this repository, and a `newer` that disagrees with the versions.
- Service_ReleaseCheck alone may call it: not service_role, not another principal, not a person.
  Nobody writes the table past it; every signed-in user, but nobody signed out, reads it.
- The principal's key reaches that gate and nothing else: it holds no role and no permission, so a
  service_role RPC, another principal's gate and a write to another table are all refused.

The principal is presented as PostgREST presents a verified JWT: its claims in
`request.jwt.claims` under the `authenticated` role. The signature is PostgREST's to check.

Runs against the Supabase database, not the historian:

    python supabase/migrations/test_release_check.py
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

RELEASE_CHECK_PRINCIPAL = "b0000000-0000-4000-8000-000000000004"
INGESTION_PRINCIPAL = "b0000000-0000-4000-8000-000000000002"
GATE = "public.record_release_check(text, text, text, boolean, text)"
NOTES = "https://github.com/Harri-Llewelyn/Aber/releases/tag/v1.5.0"


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


class ReleaseCheckBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def tearDown(self):
        # The row is the CronJob's to write; a suite that left one behind would put a release on a
        # menu that no check found.
        self.conn.rollback()

    def present(self, cur, role, sub=None):
        """Act as an API role, with a principal's claims when `sub` is given."""
        claims = {"role": role, **({"sub": sub} if sub else {})}
        cur.execute("SELECT set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
        cur.execute(f"SET LOCAL ROLE {role}")

    def call(self, cur, **args):
        cur.execute(
            "SELECT public.record_release_check(p_running => %(running)s, p_latest => %(latest)s,"
            " p_url => %(url)s, p_newer => %(newer)s, p_error => %(error)s)",
            {"running": "1.4.0", "latest": None, "url": None, "newer": None, "error": None, **args},
        )

    def record(self, cur, **args):
        """Calls the gate as the CronJob does: as Service_ReleaseCheck, through PostgREST."""
        self.present(cur, "authenticated", RELEASE_CHECK_PRINCIPAL)
        self.call(cur, **args)
        cur.execute("RESET ROLE")

    def row(self, cur):
        cur.execute(
            "SELECT running_version, latest_version, latest_url, newer, error, checked_at IS NOT NULL"
            "  FROM public.release_check"
        )
        return cur.fetchall()


class TestTheRow(ReleaseCheckBase):
    def test_a_successful_check_is_recorded(self):
        with self.conn.cursor() as cur:
            self.record(cur, latest="1.5.0", url=NOTES, newer=True)
            self.assertEqual(self.row(cur), [("1.4.0", "1.5.0", NOTES, True, None, True)])

    def test_each_check_replaces_the_last_one(self):
        with self.conn.cursor() as cur:
            self.record(cur, latest="1.5.0", url=NOTES, newer=True)
            self.record(cur, running="1.5.0", latest="1.5.0", url=NOTES, newer=False)
            self.assertEqual(self.row(cur), [("1.5.0", "1.5.0", NOTES, False, None, True)])

    def test_a_failed_check_keeps_only_its_reason(self):
        with self.conn.cursor() as cur:
            self.record(cur, latest="1.5.0", url=NOTES, newer=True)
            self.record(cur, error="could not reach api.github.com: fetch failed (UND_ERR_CONNECT_TIMEOUT)")
            self.assertEqual(
                self.row(cur),
                [("1.4.0", None, None, None, "could not reach api.github.com: fetch failed (UND_ERR_CONNECT_TIMEOUT)", True)],
            )

    def test_a_signed_in_user_reads_it_and_nobody_signed_out_does(self):
        with self.conn.cursor() as cur:
            self.record(cur, latest="1.5.0", url=NOTES, newer=True)
            self.present(cur, "authenticated", "a0000000-0000-0000-0000-000000000004")
            cur.execute("SELECT latest_version FROM public.release_check")
            self.assertEqual(cur.fetchall(), [("1.5.0",)])
            cur.execute("RESET ROLE")
            cur.execute("SELECT has_table_privilege('anon', 'public.release_check', 'SELECT')")
            self.assertFalse(cur.fetchone()[0])

    def test_nobody_writes_the_table_past_the_gate(self):
        with self.conn.cursor() as cur:
            for role in ("anon", "authenticated", "service_role"):
                cur.execute(
                    "SELECT has_table_privilege(%s, 'public.release_check', 'INSERT, UPDATE, DELETE, TRUNCATE')",
                    (role,),
                )
                self.assertFalse(cur.fetchone()[0], f"{role} can write release_check directly")


class TestTheGateRefusesWhatTheMenuCouldNotShow(ReleaseCheckBase):
    def assertRefused(self, **args):
        with self.conn.cursor() as cur:
            with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                self.record(cur, **args)
        self.conn.rollback()

    def test_a_version_that_is_not_a_release_core(self):
        self.assertRefused(running="1.4", latest="1.5.0", url=NOTES, newer=True)
        self.assertRefused(running="v1.4.0", latest="1.5.0", url=NOTES, newer=True)
        self.assertRefused(latest="1.5.0-rc.1", url=NOTES, newer=True)
        self.assertRefused(latest=None, url=NOTES, newer=True)

    def test_a_link_that_is_not_a_release_of_this_repository(self):
        self.assertRefused(latest="1.5.0", url="https://github.com/someone/Aber/releases/tag/v1.5.0", newer=True)
        self.assertRefused(latest="1.5.0", url="javascript:alert(1)", newer=True)
        self.assertRefused(latest="1.5.0", url=NOTES + "/../../evil", newer=True)

    def test_a_newer_that_the_versions_contradict(self):
        self.assertRefused(latest="1.5.0", url=NOTES, newer=False)
        self.assertRefused(latest="1.3.9", url=NOTES, newer=True)
        # Numbers, not text: 1.10.0 is newer than 1.9.0.
        with self.conn.cursor() as cur:
            self.record(cur, running="1.9.0", latest="1.10.0", url=NOTES, newer=True)
            self.assertEqual(self.row(cur)[0][3], True)


class TestOnlyTheReleaseCheckPrincipalMayCallTheGate(ReleaseCheckBase):
    def assertCallerRefused(self, role, sub=None):
        with self.conn.cursor() as cur:
            self.present(cur, role, sub)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                self.call(cur, latest="1.5.0", url=NOTES, newer=True)
        self.conn.rollback()

    def test_service_role_is_refused(self):
        # Not even the role that bypasses RLS: the gate is a statement about one identity.
        self.assertCallerRefused("service_role")

    def test_another_principal_is_refused(self):
        self.assertCallerRefused("authenticated", INGESTION_PRINCIPAL)

    def test_a_person_is_refused(self):
        self.assertCallerRefused("authenticated", "a0000000-0000-0000-0000-000000000001")

    def test_a_caller_with_no_identity_is_refused(self):
        self.assertCallerRefused("authenticated")

    def test_the_grants_say_the_same(self):
        with self.conn.cursor() as cur:
            for role, allowed in (("anon", False), ("authenticated", True), ("service_role", False)):
                cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE')", (role, GATE))
                self.assertEqual(cur.fetchone()[0], allowed, role)


class TestThePrincipalReachesNothingElse(ReleaseCheckBase):
    """Its key, leaked, records a release check and does nothing more."""

    def test_it_is_a_machine_that_holds_no_role_and_no_permission(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT public.is_machine_principal(%s::uuid)", (RELEASE_CHECK_PRINCIPAL,))
            self.assertTrue(cur.fetchone()[0])
            cur.execute("SELECT count(*) FROM public.user_roles WHERE user_id = %s", (RELEASE_CHECK_PRINCIPAL,))
            self.assertEqual(cur.fetchone()[0], 0)
            cur.execute(
                "SELECT count(*) FROM public.principal_permissions WHERE principal_id = %s::uuid",
                (RELEASE_CHECK_PRINCIPAL,),
            )
            self.assertEqual(cur.fetchone()[0], 0)

    def test_a_service_role_rpc_is_refused(self):
        with self.conn.cursor() as cur:
            self.present(cur, "authenticated", RELEASE_CHECK_PRINCIPAL)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT public.claim_forge_sweep(60)")
        self.conn.rollback()

    def test_another_principals_gate_is_refused(self):
        with self.conn.cursor() as cur:
            self.present(cur, "authenticated", RELEASE_CHECK_PRINCIPAL)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT public.require_ingestion_caller('test')")
        self.conn.rollback()

    def test_a_write_to_another_table_changes_nothing(self):
        with self.conn.cursor() as cur:
            self.present(cur, "authenticated", RELEASE_CHECK_PRINCIPAL)
            # RLS admits Administrators and Shopfloor_Managers to update the Directory; a machine
            # holds no role, so the update matches no row.
            cur.execute("UPDATE public.directory_services SET image = 'evil/image:1' RETURNING id")
            self.assertEqual(cur.fetchall(), [])
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(
                    "INSERT INTO public.release_check (id, running_version) VALUES (true, '9.9.9')"
                )
        self.conn.rollback()


if __name__ == "__main__":
    unittest.main()
