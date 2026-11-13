# suite:
#   lanes: db
#   why: 0002 -- that Studio's client block, run as db-init's psql runs it, says Studio is off in a
#     NOTICE and never a WARNING; that it removes a client an earlier boot registered, approvals and
#     sessions with it, recorded once and not on the next boot, and restores it when Studio is on
#     again; that Studio on without its secret warns naming the login and the secret to set; and
#     that an unset value is today's behaviour and never removes.

"""
With Studio off, db-init says so without a warning, and Studio's client goes (0002).

    python supabase/migrations/test_with_studio_off_db_init_says_so_without_a_warning.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

0002's Studio block is run as db-init's psql runs it, with `studio_enabled` false, true and unset.
What is held here: false is a NOTICE and never a WARNING, and a client an earlier boot registered is
removed as remove_app() removes one, its approvals revoked and its sessions ended, recorded once and
not again on the next boot; true again restores it. True warns without the secret, naming the Studio
login and the secret to set, and registers with it as before. Unset is true, and never removes.
Any other value fails the boot.

The block is cut from the file, so the test runs what db-init runs. psql's part of it (the
`\\if :{?name}` defaults, `:'name'` and `\\g /dev/null`) is applied here, because psycopg2 is not
psql; an unknown meta-command fails the test rather than being skipped.

EVERY TEST ROLLS BACK. The acts write Audit Trail rows, and the audit table cannot be pruned.
"""
import os
import re
import unittest
from pathlib import Path

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
SEED = REPO / "supabase" / "migrations" / "0002_seed_data.sql"
DB_INIT = REPO / "deploy" / "helm" / "aber" / "templates" / "jobs" / "db-init.yaml"

STUDIO = "c0ffee00-0000-4000-8000-000000000003"
GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
ADA = "51d10000-0000-4000-8000-000000001371"
BEN = "51d10000-0000-4000-8000-000000001372"
ADA_STUDIO = "51d10000-0000-4000-8000-0000000013a1"
BEN_STUDIO = "51d10000-0000-4000-8000-0000000013a2"
ADA_GRAFANA = "51d10000-0000-4000-8000-0000000013a3"

URL = "http://studio.test"
SECRET = "a-test-studio-secret"

OFF = "NOTICE:  Studio is off (supabaseStudio.enabled), so its OAuth client is not registered."
REMOVED = (OFF + " The one an earlier boot registered is removed: {approvals} approval(s) revoked,"
           " {sessions} session(s) ended.")
NO_SECRET = ("WARNING:  studio_oauth_client_secret not supplied; skipping client registration."
             " The Studio login at {url} cannot complete until secrets.studioOAuthClientSecret"
             " (the Secret key STUDIO_OAUTH_CLIENT_SECRET) is set and the release upgraded.")

GUARD = re.compile(r"\\if :\{\?(\w+)\} \\else \\set \1 '' \\endif")


def studio_block():
    """0002's Studio section: its comment to the line that clears the staged secret."""
    text = SEED.read_text(encoding="utf-8")
    start = text.index("-- Studio's door:")
    end = text.index("SELECT set_config('aber.studio_oauth_client_secret', '', false);", start)
    return text[start:end]


def as_psql_runs_it(variables):
    """The block as `psql -v name=value ...` runs it: an unset name takes its `\\if` default, each
    `:'name'` before the DO block becomes a quoted literal, and `\\g /dev/null` ends its statement."""
    values = dict(variables)
    lines = []
    in_body = False
    for line in studio_block().splitlines():
        if line.startswith("DO $$"):
            in_body = True
        if not in_body:
            guard = GUARD.fullmatch(line.strip())
            if guard:
                values.setdefault(guard.group(1), "")
                continue
            if line.startswith("\\"):
                raise AssertionError(f"a psql meta-command this test does not apply: {line}")
            line = line.replace(" \\g /dev/null", ";")
            line = re.sub(r":'(\w+)'", lambda m: "'" + values[m.group(1)].replace("'", "''") + "'", line)
        lines.append(line)
    return "\n".join(lines)


def db_init(enabled, secret="", url=URL):
    """The -v values db-init passes: studio_enabled from the chart (None: an older chart, which
    passes none), and the secret and address, empty when Studio is off."""
    variables = {"studio_oauth_client_secret": secret, "studio_public_url": url}
    if enabled is not None:
        variables["studio_enabled"] = enabled
    return variables


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class StudioBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.log_app_registration()'), to_regclass('auth.oauth_consents');")
        if None in self.cur.fetchone():
            self.skipTest("0217 or the GoTrue fixture's auth.oauth_consents is not in this database")
        for user_id in (ADA, BEN):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@studio.test"),
            )
        # Each test starts from a default install: no Studio client, approval or session.
        self.cur.execute("DELETE FROM auth.sessions WHERE oauth_client_id = %s;", (STUDIO,))
        self.cur.execute("DELETE FROM auth.oauth_clients WHERE id = %s;", (STUDIO,))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def boot(self, variables):
        """Run the block as db-init does; returns the NOTICEs and WARNINGs, as psql prints them."""
        del self.conn.notices[:]
        self.cur.execute(as_psql_runs_it(variables))
        return [n.strip() for n in self.conn.notices]

    def studio_in_use(self):
        """Studio registered on an earlier boot, approved by two people and signed in to by each,
        and Ada signed in to Grafana too."""
        self.boot(db_init("true", SECRET))
        for user_id in (ADA, BEN):
            self.cur.execute(
                "INSERT INTO auth.oauth_consents (user_id, client_id, scopes, granted_at)"
                " VALUES (%s, %s, 'email profile', now() - interval '1 day');",
                (user_id, STUDIO),
            )
        # The fixture's sessions do not reference auth.oauth_clients, so Grafana need not be registered.
        for session_id, user_id, app_id in ((ADA_STUDIO, ADA, STUDIO), (BEN_STUDIO, BEN, STUDIO),
                                            (ADA_GRAFANA, ADA, GRAFANA)):
            self.cur.execute(
                "INSERT INTO auth.sessions (id, user_id, oauth_client_id) VALUES (%s, %s, %s);",
                (session_id, user_id, app_id),
            )
            self.cur.execute(
                "INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)"
                " VALUES (%s, %s, false, now(), now(), %s);",
                (f"{session_id}-1", user_id, session_id),
            )

    def client(self):
        """Studio's client as GoTrue reads it: (redirect_uris, deleted_at), or None if no row."""
        self.cur.execute("SELECT redirect_uris, deleted_at FROM auth.oauth_clients WHERE id = %s;", (STUDIO,))
        return self.cur.fetchone()

    def live(self):
        row = self.client()
        return row is not None and row[1] is None

    def approvals_in_force(self):
        self.cur.execute(
            "SELECT count(*) FROM auth.oauth_consents WHERE client_id = %s AND revoked_at IS NULL;", (STUDIO,))
        return self.cur.fetchone()[0]

    def sessions(self):
        self.cur.execute(
            "SELECT id::text FROM auth.sessions WHERE id IN (%s, %s, %s) ORDER BY id;",
            (ADA_STUDIO, BEN_STUDIO, ADA_GRAFANA),
        )
        return [r[0] for r in self.cur.fetchall()]

    def last_audit_id(self):
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        return self.cur.fetchone()[0]

    def rows_since(self, since):
        self.cur.execute(
            "SELECT entity_type, entity_id::text, action, new_data, changed_by, actor_source"
            "  FROM public.audit_trail WHERE id > %s ORDER BY id;",
            (since,),
        )
        keys = ["entity_type", "entity_id", "action", "new_data", "changed_by", "actor_source"]
        return [dict(zip(keys, r)) for r in self.cur.fetchall()]


class WithStudioOff(StudioBase):
    def test_a_default_install_hears_a_notice_and_no_warning(self):
        before = self.last_audit_id()
        self.assertEqual(self.boot(db_init("false", url="")), [OFF])
        self.assertIsNone(self.client())
        self.assertEqual(self.rows_since(before), [])

    def test_a_client_an_earlier_boot_registered_is_removed_with_its_approvals_and_sessions(self):
        self.studio_in_use()
        self.assertEqual(self.boot(db_init("false", url="")), [REMOVED.format(approvals=2, sessions=2)])
        self.assertFalse(self.live())
        self.assertIsNotNone(self.client(), "removed as remove_app() removes one, by deleted_at")
        self.assertEqual(self.approvals_in_force(), 0)
        # Studio's sessions end with their refresh tokens; Grafana's is left alone.
        self.assertEqual(self.sessions(), [ADA_GRAFANA])
        self.cur.execute("SELECT count(*) FROM auth.refresh_tokens WHERE session_id IN (%s, %s);",
                         (ADA_STUDIO, BEN_STUDIO))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_the_removal_is_recorded_once_and_the_next_boot_records_nothing(self):
        self.studio_in_use()
        before = self.last_audit_id()
        self.boot(db_init("false", url=""))
        rows = self.rows_since(before)
        self.assertEqual(
            sorted((r["entity_type"], r["entity_id"], r["action"], r["actor_source"]) for r in rows),
            sorted([("user_roles", ADA, "APP_APPROVAL_REVOKED", "migration"),
                    ("user_roles", BEN, "APP_APPROVAL_REVOKED", "migration"),
                    ("oauth_clients", STUDIO, "APP_REMOVED", "migration")]),
        )
        removal = next(r for r in rows if r["action"] == "APP_REMOVED")
        self.assertIsNone(removal["changed_by"])
        self.assertTrue(removal["new_data"]["part_of_stack"])
        self.assertEqual(removal["new_data"]["name"], "Aber Supabase Studio")
        self.assertIn("removed_at", removal["new_data"])

        second = self.last_audit_id()
        self.assertEqual(self.boot(db_init("false", url="")), [OFF])
        self.assertEqual(self.rows_since(second), [])
        self.assertFalse(self.live())

    def test_turning_studio_on_again_restores_the_client_and_people_approve_it_again(self):
        self.studio_in_use()
        self.boot(db_init("false", url=""))
        before = self.last_audit_id()
        self.assertEqual(self.boot(db_init("true", SECRET)), [])
        self.assertEqual([(r["action"], r["entity_id"], r["actor_source"]) for r in self.rows_since(before)],
                         [("APP_RESTORED", STUDIO, "migration")])
        self.assertTrue(self.live())
        self.assertEqual(self.approvals_in_force(), 0)


class WithStudioOn(StudioBase):
    def test_without_its_secret_a_warning_names_the_studio_login_and_the_secret_to_set(self):
        self.assertEqual(self.boot(db_init("true")), [NO_SECRET.format(url=URL)])
        self.assertIsNone(self.client())

    def test_with_its_secret_it_is_registered_as_before(self):
        before = self.last_audit_id()
        self.assertEqual(self.boot(db_init("true", SECRET, URL + "/")), [])
        self.assertTrue(self.live())
        self.assertEqual(self.client()[0], URL + "/oauth2/callback")
        self.assertEqual([(r["action"], r["entity_id"]) for r in self.rows_since(before)],
                         [("APP_REGISTERED", STUDIO)])
        # A boot that finds it registered changes nothing and records nothing.
        again = self.last_audit_id()
        self.assertEqual(self.boot(db_init("true", SECRET, URL)), [])
        self.assertEqual(self.rows_since(again), [])

    def test_without_its_secret_a_client_already_registered_is_left_alone(self):
        self.studio_in_use()
        before = self.last_audit_id()
        self.assertEqual(self.boot(db_init("true")), [NO_SECRET.format(url=URL)])
        self.assertTrue(self.live())
        self.assertEqual(self.approvals_in_force(), 2)
        self.assertEqual(self.rows_since(before), [])


class WithTheVariableUnset(StudioBase):
    """An older chart, or a hand-run psql: today's behaviour."""

    def test_without_a_secret_it_warns_as_with_studio_on(self):
        self.assertEqual(self.boot(db_init(None, url="")), [NO_SECRET.format(url="http://127.0.0.1:54323")])
        self.assertIsNone(self.client())

    def test_with_a_secret_it_registers_as_before(self):
        self.assertEqual(self.boot(db_init(None, SECRET)), [])
        self.assertTrue(self.live())

    def test_it_never_removes_a_client(self):
        self.studio_in_use()
        before = self.last_audit_id()
        self.boot(db_init(None))
        self.assertTrue(self.live())
        self.assertEqual(self.approvals_in_force(), 2)
        self.assertEqual(len(self.sessions()), 3)
        self.assertEqual(self.rows_since(before), [])


class TheValue(StudioBase):
    def test_any_other_value_fails_the_boot_naming_it(self):
        self.studio_in_use()
        self.cur.execute("SAVEPOINT other_value;")
        with self.assertRaises(psycopg2.Error) as failed:
            self.boot(db_init("off"))
        self.cur.execute("ROLLBACK TO SAVEPOINT other_value;")
        self.assertIn("studio_enabled is off, not true or false", failed.exception.diag.message_primary)
        self.assertTrue(self.live())

    def test_db_init_passes_it_from_supabase_studio_enabled(self):
        template = DB_INIT.read_text(encoding="utf-8")
        self.assertIn(
            '-v studio_enabled="{{ if .Values.supabaseStudio.enabled }}true{{ else }}false{{ end }}" \\',
            template,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
