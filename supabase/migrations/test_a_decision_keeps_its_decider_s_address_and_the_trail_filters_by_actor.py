"""
A decision keeps the address its decider signed in with, and the Audit Trail finds what one person
or machine identity changed (0222).

    python supabase/migrations/test_a_decision_keeps_its_decider_s_address_and_the_trail_filters_by_actor.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * audit_trail_page(p_changed_by => id) returns the rows that id wrote and no other, counts only
    those, and composes with the other filters and the cursor. The rows are still the caller's own:
    a Shopfloor Manager filtering by an Administrator gets that person's asset-lane rows and none of
    their security-lane rows, and an Operator gets nothing.
  * change_proposals.decided_by_email is the decider's address from their token when they approve,
    reject or withdraw, and stays what it was when their account's address changes later. An expiry,
    a decision made by somebody other than the caller, and a decision made before 0222 keep NULL.
    No client writes it, on insert or on update.
  * audit_trail_page() is declared once, with p_changed_by last: after the chain, after 0168 and
    0222 replay over it, and after 0222 replays over a database that still holds the ten-argument
    form. No applied migration declares the ten-argument form, and 0222's self-check refuses two.

EVERY TEST ROLLS BACK. An audit row is permanent.
"""
import json
import os
import re
import unittest
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN = "a0d17070-0000-4000-8000-0000000222a1"
MANAGER = "a0d17070-0000-4000-8000-0000000222a2"
OPERATOR = "a0d17070-0000-4000-8000-0000000222a3"
MACHINE = "a0d17070-0000-4000-8000-0000000222a4"
NOBODY = "a0d17070-0000-4000-8000-0000000222af"
AREA = "a0d17070-0000-4000-8000-0000000222b1"
AREA_TWO = "a0d17070-0000-4000-8000-0000000222b2"
# One entity id per seeded audit row's subject, so every page below is scoped to this suite's rows.
SUBJECTS = [f"a0d17070-0000-4000-8000-0000000222c{i}" for i in range(1, 7)]

HERE = Path(__file__).resolve().parent
MIGRATION = HERE / "0222_a_decision_keeps_its_decider_s_address_and_the_trail_filters_by_actor.sql"
SCHEMA_FILE = HERE / "0168_every_schema_attached_to_a_device_counts.sql"

ELEVEN = (
    "p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, "
    "p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, "
    "p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text, "
    "p_changed_by uuid"
)
TEN_TYPES = (
    "integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, "
    "timestamp with time zone, bigint, text"
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def email_of(user_id):
    return f"{user_id}@decider.test"


class Base(unittest.TestCase):
    """Three people with roles and one machine identity, inside a transaction rolled back after."""

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'"
            " AND table_name = 'change_proposals' AND column_name = 'decided_by_email';"
        )
        if self.cur.fetchone()[0] == 0:
            self.skipTest("0222 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in ((ADMIN, "Administrator"), (MANAGER, "Shopfloor_Manager"),
                              (OPERATOR, "Operator")):
            # An email, so each is a person and not a machine identity.
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, email_of(user_id)),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )
        # A machine identity: an account with no email, named by an Administrator.
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING;", (MACHINE,))
        self.cur.execute(
            "INSERT INTO public.machine_principals (principal_id, name) VALUES (%s, 'Decider Test Loader')"
            " ON CONFLICT (principal_id) DO NOTHING;",
            (MACHINE,),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def as_person(self, user_id, sql, args=(), claims=None):
        """Run `sql` as PostgREST would for a token naming `user_id`, with its email claim. A refusal
        rolls back to the savepoint and is raised. Returns the rows, or None for no result."""
        self.cur.execute("SAVEPOINT decider_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute(
                "SELECT set_config('request.jwt.claims', %s, true);",
                (json.dumps(claims or {"sub": user_id, "role": "authenticated",
                                       "email": email_of(user_id)}),),
            )
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT decider_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT decider_call;")
        return rows

    def forms(self):
        self.cur.execute(
            "SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page' ORDER BY 1;"
        )
        return [r[0] for r in self.cur.fetchall()]


# -------------------------------------------------------------------------------------------------
# The Audit Trail's "Changed by" filter
# -------------------------------------------------------------------------------------------------
class TheActorFilter(Base):
    """Six rows: four asset-lane rows by four actors, a security-lane row by the Administrator, and
    one by nobody (a migration). One subject each."""

    ROWS = (
        # subject, entity_type, action, changed_by, actor_source
        (0, "areas", "UPDATE", ADMIN, "user"),
        (1, "cells", "UPDATE", MANAGER, "user"),
        (2, "devices", "INSERT", MACHINE, "service"),
        (3, "areas", "DELETE", ADMIN, "user"),
        (4, "user_roles", "ROLE_GRANTED", ADMIN, "user"),
        (5, "gateways", "INSERT", None, "migration"),
    )

    def setUp(self):
        super().setUp()
        for i, (subject, entity_type, action, actor, source) in enumerate(self.ROWS):
            self.cur.execute(
                "INSERT INTO public.audit_trail"
                "  (entity_type, entity_id, action, new_data, changed_by, actor_source, recorded_at)"
                " VALUES (%s, %s, %s, '{}'::jsonb, %s, %s,"
                "         timestamptz '2026-03-01 00:00:00+00' + make_interval(mins => %s));",
                (entity_type, SUBJECTS[subject], action, actor, source, i),
            )

    PAGE = (
        "SELECT public.audit_trail_page(p_entity_ids => %(ids)s::uuid[], p_include_purged => true,"
        " p_changed_by => %(changed_by)s::uuid, p_action => %(action)s, p_limit => %(limit)s,"
        " p_before_recorded_at => %(before_at)s::timestamptz, p_before_id => %(before_id)s::bigint);"
    )

    def page(self, as_user=None, changed_by=None, action=None, limit=None, cursor=None):
        """The page over this suite's subjects, deleted ones included (none of them is live)."""
        args = {"ids": SUBJECTS, "changed_by": changed_by, "action": action, "limit": limit,
                "before_at": (cursor or {}).get("recorded_at"), "before_id": (cursor or {}).get("id")}
        if as_user:
            return self.as_person(as_user, self.PAGE, args)[0][0]
        self.cur.execute(self.PAGE, args)
        return self.cur.fetchone()[0]

    def actors(self, payload):
        return sorted(e["changed_by"] or "" for e in payload["events"])

    def test_one_person_s_rows_and_no_one_else_s(self):
        payload = self.page(changed_by=ADMIN)
        self.assertEqual(self.actors(payload), [ADMIN] * 3)
        self.assertEqual(payload["total_matching"], 3)

    def test_a_machine_identity_is_filtered_the_same_way(self):
        payload = self.page(changed_by=MACHINE)
        self.assertEqual([e["entity_type"] for e in payload["events"]], ["devices"])
        self.assertEqual(payload["total_matching"], 1)

    def test_no_filter_is_everyone_and_an_unknown_id_is_nobody(self):
        self.assertEqual(self.page()["total_matching"], len(self.ROWS))
        self.assertEqual(self.page(changed_by=None)["total_matching"], len(self.ROWS))
        payload = self.page(changed_by=NOBODY)
        self.assertEqual((payload["events"], payload["total_matching"]), ([], 0))

    def test_it_composes_with_the_action_and_the_cursor(self):
        payload = self.page(changed_by=ADMIN, action="UPDATE")
        self.assertEqual([e["entity_id"] for e in payload["events"]], [SUBJECTS[0]])
        # One row a page: the cursor walks the Administrator's three rows and nothing else.
        seen, cursor = [], None
        for _ in range(5):
            payload = self.page(changed_by=ADMIN, limit=1, cursor=cursor)
            seen += [e["entity_id"] for e in payload["events"]]
            self.assertEqual(payload["total_matching"], 3)
            cursor = payload["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(seen, [SUBJECTS[4], SUBJECTS[3], SUBJECTS[0]])

    def test_the_caller_s_own_policies_decide_which_of_those_rows_come_back(self):
        # An Administrator reads both lanes.
        self.assertEqual(self.page(as_user=ADMIN, changed_by=ADMIN)["total_matching"], 3)
        # A Shopfloor Manager reads the asset lane only: the role grant is not theirs to see.
        payload = self.page(as_user=MANAGER, changed_by=ADMIN)
        self.assertEqual(sorted(e["entity_type"] for e in payload["events"]), ["areas", "areas"])
        self.assertEqual(payload["total_matching"], 2)
        # An Operator reads no audit row, filtered or not.
        payload = self.page(as_user=OPERATOR, changed_by=ADMIN)
        self.assertEqual((payload["events"], payload["total_matching"]), ([], 0))


# -------------------------------------------------------------------------------------------------
# change_proposals.decided_by_email
# -------------------------------------------------------------------------------------------------
class TheDecidersAddress(Base):
    def setUp(self):
        super().setUp()
        self.cur.execute(
            "INSERT INTO public.areas (id, name) VALUES (%s, 'Decider Test Hall'), (%s, 'Decider Test Yard');",
            (AREA, AREA_TWO),
        )

    def propose(self, area=AREA, by=OPERATOR):
        rows = self.as_person(
            by,
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
            " VALUES ('areas', %s, %s::jsonb, 'decider test') RETURNING id;",
            (area, json.dumps({"description": "Decided in a test"})),
        )
        return rows[0][0]

    def stamps(self, proposal):
        self.cur.execute(
            "SELECT status, decided_by::text, decided_by_email, proposed_by_email"
            "  FROM public.change_proposals WHERE id = %s;",
            (proposal,),
        )
        return self.cur.fetchone()

    def test_an_approval_stamps_the_approver_s_address(self):
        proposal = self.propose()
        self.as_person(MANAGER, "SELECT public.approve_proposal(%s);", (proposal,))
        self.assertEqual(self.stamps(proposal),
                         ("applied", MANAGER, email_of(MANAGER), email_of(OPERATOR)))

    def test_a_rejection_stamps_the_rejecter_s_address(self):
        proposal = self.propose()
        self.as_person(ADMIN, "SELECT public.reject_proposal(%s, 'not now');", (proposal,))
        self.assertEqual(self.stamps(proposal)[:3], ("rejected", ADMIN, email_of(ADMIN)))

    def test_a_withdrawal_stamps_the_proposer_s_address(self):
        proposal = self.propose()
        self.as_person(OPERATOR, "SELECT public.withdraw_proposal(%s);", (proposal,))
        self.assertEqual(self.stamps(proposal)[:3], ("withdrawn", OPERATOR, email_of(OPERATOR)))

    def test_it_stays_the_address_they_had_then(self):
        proposal = self.propose()
        self.as_person(MANAGER, "SELECT public.approve_proposal(%s);", (proposal,))
        self.cur.execute("UPDATE auth.users SET email = 'renamed@decider.test' WHERE id = %s;", (MANAGER,))
        self.assertEqual(self.stamps(proposal)[2], email_of(MANAGER))
        # A replay of the file leaves it too.
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(self.stamps(proposal)[2], email_of(MANAGER))

    def test_a_token_with_no_email_stamps_nothing(self):
        proposal = self.propose()
        self.as_person(MANAGER, "SELECT public.approve_proposal(%s);", (proposal,),
                       claims={"sub": MANAGER, "role": "authenticated"})
        self.assertEqual(self.stamps(proposal)[:3], ("applied", MANAGER, None))

    def test_an_expiry_names_no_decider_and_keeps_no_address(self):
        proposal = self.propose()
        # Backdated as the owner, past the guard, further than any expiry setting reaches.
        self.cur.execute("SELECT set_config('aber.proposal_transition', 'on', true);")
        self.cur.execute(
            "UPDATE public.change_proposals SET proposed_at = now() - interval '10 years' WHERE id = %s;",
            (proposal,),
        )
        self.cur.execute("SELECT set_config('aber.proposal_transition', '', true);")
        self.cur.execute("SELECT public.expire_open_proposals();")
        self.assertEqual(self.stamps(proposal)[:3], ("expired", None, None))

    def test_a_decider_who_is_not_the_caller_is_not_given_the_caller_s_address(self):
        proposal = self.propose()
        # A write past the guard that names somebody else as the decider, under the
        # Administrator's token.
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": ADMIN, "email": email_of(ADMIN)}),))
        self.cur.execute("SELECT set_config('aber.proposal_transition', 'on', true);")
        self.cur.execute(
            "UPDATE public.change_proposals SET status = 'applied', decided_by = %s, decided_at = now()"
            " WHERE id = %s;",
            (MANAGER, proposal),
        )
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.assertEqual(self.stamps(proposal)[:3], ("applied", MANAGER, None))

    def test_a_decision_from_before_0222_reads_null(self):
        # As a row a 1.7.0 approval left: decided, with no address beside the decider.
        self.cur.execute(
            "INSERT INTO public.change_proposals"
            "  (entity_type, entity_id, patch, status, proposed_by, decided_by, decided_at)"
            " VALUES ('areas', %s, %s::jsonb, 'applied', %s, %s, now()) RETURNING id;",
            (AREA_TWO, json.dumps({"description": "Decided before"}), OPERATOR, MANAGER),
        )
        proposal = self.cur.fetchone()[0]
        self.assertEqual(self.stamps(proposal)[:3], ("applied", MANAGER, None))

    def test_no_client_writes_it(self):
        # On insert: the policy admits the proposer's own open row, and the stamp clears the address.
        rows = self.as_person(
            OPERATOR,
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, decided_by_email)"
            " VALUES ('areas', %s, %s::jsonb, 'spoof@decider.test') RETURNING id;",
            (AREA, json.dumps({"description": "Spoofed"})),
        )
        proposal = rows[0][0]
        self.assertIsNone(self.stamps(proposal)[2])
        # On update of their own open row, which the policy lets them edit.
        self.as_person(
            OPERATOR,
            "UPDATE public.change_proposals SET decided_by_email = 'spoof@decider.test',"
            " rationale = 'edited' WHERE id = %s;",
            (proposal,),
        )
        self.cur.execute("SELECT rationale, decided_by_email FROM public.change_proposals WHERE id = %s;",
                         (proposal,))
        self.assertEqual(self.cur.fetchone(), ("edited", None))

    def test_the_column_and_its_stamp_are_described(self):
        self.cur.execute(
            "SELECT data_type, is_nullable, column_default FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = 'change_proposals'"
            "   AND column_name = 'decided_by_email';"
        )
        self.assertEqual(self.cur.fetchone(), ("text", "YES", None))
        self.cur.execute(
            "SELECT col_description('public.change_proposals'::regclass, attnum) FROM pg_attribute"
            " WHERE attrelid = 'public.change_proposals'::regclass AND attname = 'decided_by_email';"
        )
        self.assertIn("(0222)", self.cur.fetchone()[0] or "")


# -------------------------------------------------------------------------------------------------
# One audit_trail_page(), whatever replays
# -------------------------------------------------------------------------------------------------
class OneSignature(Base):
    def create_ten_argument_form(self):
        """The form a database from before 0222 holds beside 0001's new one on its first new boot."""
        self.cur.execute(
            "CREATE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200,"
            " p_include_purged boolean DEFAULT false, p_entity_type text DEFAULT NULL,"
            " p_action text DEFAULT NULL, p_entity_ids uuid[] DEFAULT NULL,"
            " p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL,"
            " p_before_recorded_at timestamptz DEFAULT NULL, p_before_id bigint DEFAULT NULL,"
            " p_search text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE"
            " SET search_path TO 'public' AS $$ SELECT '{}'::jsonb $$;"
        )

    def test_the_chain_leaves_the_eleven_argument_form_alone(self):
        self.assertEqual(self.forms(), [ELEVEN])

    def test_replaying_0168_and_0222_brings_no_second_form_back(self):
        self.cur.execute(SCHEMA_FILE.read_text(encoding="utf-8"))
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(self.forms(), [ELEVEN])

    def test_0222_drops_the_ten_argument_form_a_database_from_before_still_holds(self):
        self.create_ten_argument_form()
        self.assertEqual(len(self.forms()), 2)
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(self.forms(), [ELEVEN])
        # A call by name, as PostgREST makes it, is no longer ambiguous.
        self.cur.execute("SELECT public.audit_trail_page(p_limit => 1) ? 'events';")
        self.assertTrue(self.cur.fetchone()[0])

    def test_the_self_check_refuses_two_forms(self):
        check = re.search(r"DO \$check\$.*?\$check\$;", MIGRATION.read_text(encoding="utf-8"), re.S).group(0)
        self.create_ten_argument_form()
        with self.assertRaises(psycopg2.errors.RaiseException) as raised:
            self.cur.execute(check)
        self.assertIn("declared 2 times", str(raised.exception))

    def test_no_applied_migration_declares_the_ten_argument_form(self):
        declared = re.compile(r"CREATE OR REPLACE FUNCTION public\.audit_trail_page\(([^\n]*?)\)\s+RETURNS")
        found = []
        for path in sorted(HERE.glob("[0-9][0-9][0-9][0-9]_*.sql")):
            for m in declared.finditer(path.read_text(encoding="utf-8")):
                found.append(path.name)
                self.assertTrue(m.group(1).rstrip().endswith("p_changed_by uuid DEFAULT NULL::uuid"),
                                f"{path.name} declares audit_trail_page without p_changed_by last")
        self.assertEqual(sorted(found), ["0001_baseline_schema.sql",
                                         "0168_every_schema_attached_to_a_device_counts.sql"])

    def test_the_grants_follow_the_new_form(self):
        self.cur.execute(
            "SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE'),"
            "       has_function_privilege('anon', p.oid, 'EXECUTE'), p.prosecdef"
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';"
        )
        self.assertEqual(self.cur.fetchall(), [(True, False, False)])
        self.cur.execute("SELECT to_regprocedure(%s);", (f"public.audit_trail_page({TEN_TYPES})",))
        self.assertIsNone(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
