"""
An Audit Trail filter takes several values (0227).

    python supabase/migrations/test_an_audit_trail_filter_takes_several_values.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * audit_trail_page() takes p_entity_type text[], p_action text[] and p_changed_by uuid[]. Each list
    keeps the rows matching any of its values, and the three are combined with AND. NULL and an
    empty list are no constraint. A one-element list returns what the single value did, which is
    the call the dashboard makes with one value chosen, and a value no row holds matches nothing.
  * The cursor, total_matching, purged_assets, the purged rule and the search behave under lists as
    they did under one value, and the caller's own policies still decide the rows.
  * One form is declared, with those types, SECURITY INVOKER, its search_path pinned, executable by
    authenticated and service_role and not by anon. A database still holding the single-value form
    is brought to the one list form by 0001's declaration and sweep, 0168, 0222 and 0227 replayed
    in turn, and 0227 drops that form by itself too.

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

ADMIN = "a0d17270-0000-4000-8000-0000000227a1"
MANAGER = "a0d17270-0000-4000-8000-0000000227a2"
OPERATOR = "a0d17270-0000-4000-8000-0000000227a3"
MACHINE = "a0d17270-0000-4000-8000-0000000227a4"
NOBODY = "a0d17270-0000-4000-8000-0000000227af"
# One subject per seeded row, so every page below is scoped to this suite's rows. None is a live
# entity, so each is read with deleted entities included unless a test says otherwise.
SUBJECTS = [f"a0d17270-0000-4000-8000-0000000227c{i}" for i in range(7)]
LIVE_AREA = "a0d17270-0000-4000-8000-0000000227d1"
GONE_AREA = "a0d17270-0000-4000-8000-0000000227d2"

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "0001_baseline_schema.sql"
SCHEMA_FILE = HERE / "0168_every_schema_attached_to_a_device_counts.sql"
ACTOR_FILTER = HERE / "0222_a_decision_keeps_its_decider_s_address_and_the_trail_filters_by_actor.sql"
MIGRATION = HERE / "0227_an_audit_trail_filter_takes_several_values.sql"

LIST_FORM = (
    "p_limit integer, p_include_purged boolean, p_entity_type text[], p_action text[], "
    "p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, "
    "p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text, "
    "p_changed_by uuid[]"
)
LIST_TYPES = (
    "integer, boolean, text[], text[], uuid[], timestamp with time zone, timestamp with time zone, "
    "timestamp with time zone, bigint, text, uuid[]"
)
SINGLE_VALUE_TYPES = (
    "integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, "
    "timestamp with time zone, bigint, text, uuid"
)

# subject, entity_type, action, changed_by, actor_source, the name in the snapshot
ROWS = (
    (0, "areas", "UPDATE", ADMIN, "user", "Several Hall"),
    (1, "cells", "UPDATE", MANAGER, "user", "Several Cell"),
    (2, "gateways", "INSERT", MACHINE, "service", "Several Gateway"),
    (3, "devices", "DELETE", ADMIN, "user", "Several Pump"),
    (4, "devices", "UPDATE", MANAGER, "user", "Several Fan"),
    (5, "user_roles", "ROLE_GRANTED", ADMIN, "user", None),
    (6, "gateways", "UPDATE", None, "migration", "Several Relay"),
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def expected(kinds=None, actions=None, people=None):
    """The subjects the three lists select, by the rule 0227 states, newest first."""
    keep = [
        subject for subject, kind, action, actor, _, _ in ROWS
        if (not kinds or kind in kinds)
        and (not actions or action in actions)
        and (not people or actor in people)
    ]
    return sorted(keep, reverse=True)


class Base(unittest.TestCase):
    """Three people with roles and one machine identity, inside a transaction rolled back after."""

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in ((ADMIN, "Administrator"), (MANAGER, "Shopfloor_Manager"),
                              (OPERATOR, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@several.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )
        # A machine identity: an account with no email.
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING;", (MACHINE,))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def as_person(self, user_id, sql, args=()):
        """Run `sql` as PostgREST would for a token naming `user_id`. Returns the rows."""
        self.cur.execute("SAVEPOINT several_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute(
                "SELECT set_config('request.jwt.claims', %s, true);",
                (json.dumps({"sub": user_id, "role": "authenticated"}),),
            )
            self.cur.execute(sql, args)
            rows = self.cur.fetchall()
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT several_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT several_call;")
        return rows

    def forms(self):
        self.cur.execute(
            "SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page' ORDER BY 1;"
        )
        return [r[0] for r in self.cur.fetchall()]


# -------------------------------------------------------------------------------------------------
# The three lists
# -------------------------------------------------------------------------------------------------
class TheLists(Base):
    PAGE = (
        "SELECT public.audit_trail_page(p_entity_ids => %(ids)s::uuid[],"
        " p_include_purged => %(purged)s, p_entity_type => %(kinds)s::text[],"
        " p_action => %(actions)s::text[], p_changed_by => %(people)s::uuid[],"
        " p_search => %(search)s, p_limit => %(limit)s,"
        " p_before_recorded_at => %(before_at)s::timestamptz, p_before_id => %(before_id)s::bigint);"
    )

    def setUp(self):
        super().setUp()
        for i, (subject, kind, action, actor, source, name) in enumerate(ROWS):
            self.cur.execute(
                "INSERT INTO public.audit_trail"
                "  (entity_type, entity_id, action, new_data, changed_by, actor_source, recorded_at)"
                " VALUES (%s, %s, %s, %s::jsonb, %s, %s,"
                "         timestamptz '2026-04-01 00:00:00+00' + make_interval(mins => %s));",
                (kind, SUBJECTS[subject], action, json.dumps({"name": name} if name else {}),
                 actor, source, i),
            )

    def page(self, kinds=None, actions=None, people=None, *, as_user=None, search=None,
             limit=None, cursor=None, ids=None, purged=True):
        args = {"ids": SUBJECTS if ids is None else ids, "purged": purged, "kinds": kinds,
                "actions": actions, "people": people, "search": search, "limit": limit,
                "before_at": (cursor or {}).get("recorded_at"), "before_id": (cursor or {}).get("id")}
        if as_user:
            return self.as_person(as_user, self.PAGE, args)[0][0]
        self.cur.execute(self.PAGE, args)
        return self.cur.fetchone()[0]

    def subjects(self, payload):
        return [SUBJECTS.index(e["entity_id"]) for e in payload["events"]]

    def assertSelects(self, payload, subjects):
        self.assertEqual(self.subjects(payload), subjects)
        self.assertEqual(payload["total_matching"], len(subjects))

    def test_two_kinds_are_either(self):
        kinds = ["gateways", "devices"]
        self.assertSelects(self.page(kinds=kinds), expected(kinds=kinds))
        self.assertEqual(expected(kinds=kinds), [6, 4, 3, 2])

    def test_two_actions_are_either(self):
        actions = ["INSERT", "DELETE"]
        self.assertSelects(self.page(actions=actions), expected(actions=actions))
        self.assertEqual(expected(actions=actions), [3, 2])

    def test_two_people_or_machine_identities_are_either(self):
        people = [ADMIN, MACHINE]
        self.assertSelects(self.page(people=people), expected(people=people))
        self.assertEqual(expected(people=people), [5, 3, 2, 0])

    def test_the_three_lists_are_combined_with_and(self):
        for kinds, actions, people in (
            (["devices", "gateways"], ["UPDATE"], [MANAGER]),
            (["devices", "gateways"], ["UPDATE", "INSERT"], [MANAGER, MACHINE]),
            (["areas", "user_roles"], ["UPDATE", "ROLE_GRANTED"], [ADMIN]),
            (["cells"], ["DELETE"], [MANAGER]),
        ):
            with self.subTest(kinds=kinds, actions=actions, people=people):
                self.assertSelects(self.page(kinds, actions, people), expected(kinds, actions, people))

    def test_a_one_element_list_is_the_single_value(self):
        """The old single-value call, as a list of one: the rows equal to that value, and no others."""
        for kind in sorted({row[1] for row in ROWS}):
            with self.subTest(kind=kind):
                self.assertSelects(self.page(kinds=[kind]),
                                   sorted((r[0] for r in ROWS if r[1] == kind), reverse=True))
        for action in sorted({row[2] for row in ROWS}):
            with self.subTest(action=action):
                self.assertSelects(self.page(actions=[action]),
                                   sorted((r[0] for r in ROWS if r[2] == action), reverse=True))
        for person in (ADMIN, MANAGER, MACHINE):
            with self.subTest(person=person):
                self.assertSelects(self.page(people=[person]),
                                   sorted((r[0] for r in ROWS if r[3] == person), reverse=True))

    def test_null_and_an_empty_list_are_no_constraint(self):
        everything = expected()
        self.assertEqual(len(everything), len(ROWS))
        self.assertSelects(self.page(), everything)
        self.assertSelects(self.page(kinds=[], actions=[], people=[]), everything)
        self.assertSelects(self.page(kinds=[], actions=["UPDATE"]), expected(actions=["UPDATE"]))

    def test_a_value_no_row_holds_matches_nothing(self):
        self.assertSelects(self.page(kinds=["links"]), [])
        self.assertSelects(self.page(actions=["NOT_AN_ACTION"]), [])
        self.assertSelects(self.page(people=[NOBODY]), [])
        # Beside a value that does match, it takes nothing away.
        self.assertSelects(self.page(kinds=["links", "cells"]), [1])
        self.assertSelects(self.page(people=[NOBODY, MACHINE]), [2])

    def test_the_cursor_walks_a_list_and_the_total_stays_put(self):
        kinds = ["gateways", "devices"]
        seen, cursor = [], None
        for _ in range(10):
            payload = self.page(kinds=kinds, limit=1, cursor=cursor)
            seen += self.subjects(payload)
            self.assertEqual(payload["total_matching"], 4)
            cursor = payload["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(seen, expected(kinds=kinds))

    def test_the_search_composes_with_the_lists(self):
        self.assertSelects(self.page(kinds=["devices", "cells"], search="Several"), [4, 3, 1])
        self.assertSelects(self.page(people=[ADMIN, MANAGER], search="Fan"), [4])
        self.assertSelects(self.page(actions=["UPDATE"], search="Pump"), [])

    def test_the_caller_s_own_policies_still_decide_the_rows(self):
        people = [ADMIN, MACHINE]
        # An Administrator reads both lanes, the role grant included.
        self.assertSelects(self.page(people=people, as_user=ADMIN), [5, 3, 2, 0])
        # A Shopfloor Manager reads the asset lane only.
        self.assertSelects(self.page(people=people, as_user=MANAGER), [3, 2, 0])
        # An Operator reads no audit row, filtered or not.
        self.assertSelects(self.page(people=people, as_user=OPERATOR), [])


class ThePurgedRuleUnderLists(Base):
    """One live area and one deleted, each with an UPDATE row by the Administrator."""

    def setUp(self):
        super().setUp()
        # Inserting the area writes its own INSERT row, which the action filter below leaves out.
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES (%s, 'Several Live Hall');", (LIVE_AREA,))
        for i, subject in enumerate((LIVE_AREA, GONE_AREA)):
            self.cur.execute(
                "INSERT INTO public.audit_trail"
                "  (entity_type, entity_id, action, new_data, changed_by, actor_source, recorded_at)"
                " VALUES ('areas', %s, 'UPDATE', '{}'::jsonb, %s, 'user',"
                "         timestamptz '2026-04-02 00:00:00+00' + make_interval(mins => %s));",
                (subject, ADMIN, i),
            )

    def page(self, purged):
        self.cur.execute(
            "SELECT public.audit_trail_page(p_entity_ids => %s::uuid[], p_include_purged => %s,"
            " p_entity_type => ARRAY['areas', 'cells'], p_action => ARRAY['UPDATE', 'DELETE'],"
            " p_changed_by => %s::uuid[]);",
            ([LIVE_AREA, GONE_AREA], purged, [ADMIN, MACHINE]),
        )
        return self.cur.fetchone()[0]

    def test_a_deleted_entity_is_hidden_and_counted_as_before(self):
        hidden = self.page(False)
        self.assertEqual([e["entity_id"] for e in hidden["events"]], [LIVE_AREA])
        self.assertEqual((hidden["total_matching"], hidden["purged_assets"]), (1, 1))
        shown = self.page(True)
        self.assertEqual([e["entity_id"] for e in shown["events"]], [GONE_AREA, LIVE_AREA])
        self.assertEqual((shown["total_matching"], shown["purged_assets"]), (2, 1))


# -------------------------------------------------------------------------------------------------
# One list form, whatever replays
# -------------------------------------------------------------------------------------------------
class OneListForm(Base):
    def create_single_value_form(self):
        """The form a database from before 0227 holds, beside the list form 0001 creates."""
        self.cur.execute(
            "CREATE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200,"
            " p_include_purged boolean DEFAULT false, p_entity_type text DEFAULT NULL,"
            " p_action text DEFAULT NULL, p_entity_ids uuid[] DEFAULT NULL,"
            " p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL,"
            " p_before_recorded_at timestamptz DEFAULT NULL, p_before_id bigint DEFAULT NULL,"
            " p_search text DEFAULT NULL, p_changed_by uuid DEFAULT NULL) RETURNS jsonb"
            " LANGUAGE sql STABLE SET search_path TO 'public' AS $$ SELECT '{}'::jsonb $$;"
        )

    def block(self, path, pattern):
        found = re.search(pattern, path.read_text(encoding="utf-8"), re.S)
        self.assertIsNotNone(found, f"{path.name} no longer has the block this replays")
        return found.group(0)

    def baseline_declaration(self):
        """0001's CREATE OR REPLACE of the function, its owner and its comment, as a boot runs them."""
        return self.block(
            BASELINE,
            r"CREATE OR REPLACE FUNCTION public\.audit_trail_page\(.*?\$_\$;.*?"
            r"COMMENT ON FUNCTION public\.audit_trail_page\([^\n]*",
        )

    def sweep(self):
        self.cur.execute(self.block(BASELINE, r"DO \$overloads\$.*?\$overloads\$;"))
        # The sweep pins search_path for its own block, which in this one transaction outlives it.
        self.cur.execute("RESET search_path;")

    def oid(self):
        self.cur.execute("SELECT %s::regprocedure::oid;", (f"public.audit_trail_page({LIST_TYPES})",))
        return self.cur.fetchone()[0]

    def test_the_chain_leaves_one_list_form(self):
        self.assertEqual(self.forms(), [LIST_FORM])

    def test_its_grants_and_its_invoker_rights(self):
        self.cur.execute(
            "SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE'),"
            "       has_function_privilege('service_role', p.oid, 'EXECUTE'),"
            "       has_function_privilege('anon', p.oid, 'EXECUTE'), p.prosecdef,"
            "       'search_path=public' = ANY (p.proconfig)"
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';"
        )
        self.assertEqual(self.cur.fetchall(), [(True, True, False, False, True)])

    def test_a_first_upgrade_boot_ends_with_the_list_form_alone(self):
        """0001 declares the list form beside the old one, its sweep drops the old one, and 0168, 0222
        and 0227 replay over the result."""
        self.create_single_value_form()
        self.cur.execute(self.baseline_declaration())
        self.assertEqual(len(self.forms()), 2)
        self.sweep()
        self.assertEqual(self.forms(), [LIST_FORM])
        for path in (SCHEMA_FILE, ACTOR_FILTER, MIGRATION):
            with self.subTest(replayed=path.name):
                self.cur.execute(path.read_text(encoding="utf-8"))
                self.assertEqual(self.forms(), [LIST_FORM])
        # A call by name, as PostgREST makes it, is not ambiguous, and a list is taken.
        self.cur.execute("SELECT public.audit_trail_page(p_limit => 1, p_entity_type => ARRAY['areas']) ? 'events';")
        self.assertTrue(self.cur.fetchone()[0])

    def test_a_later_boot_replays_without_recreating_anything(self):
        before = self.oid()
        self.cur.execute(self.baseline_declaration())
        self.sweep()
        for path in (SCHEMA_FILE, ACTOR_FILTER, MIGRATION):
            self.cur.execute(path.read_text(encoding="utf-8"))
        self.assertEqual(self.oid(), before)

    def test_0227_drops_the_single_value_form_by_itself(self):
        self.create_single_value_form()
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(self.forms(), [LIST_FORM])
        self.cur.execute("SELECT to_regprocedure(%s);", (f"public.audit_trail_page({SINGLE_VALUE_TYPES})",))
        self.assertIsNone(self.cur.fetchone()[0])

    def test_the_self_check_refuses_two_forms(self):
        check = self.block(MIGRATION, r"DO \$check\$.*?\$check\$;")
        self.create_single_value_form()
        with self.assertRaises(psycopg2.errors.RaiseException) as raised:
            self.cur.execute(check)
        self.assertIn("declared 2 times", str(raised.exception))

    def test_the_self_check_refuses_a_single_value_argument(self):
        check = self.block(MIGRATION, r"DO \$check\$.*?\$check\$;")
        # The list form's signature is bound as a parameter, so no SQL is built from text here.
        self.cur.execute(
            "DO $d$ BEGIN EXECUTE format('DROP FUNCTION %%s', to_regprocedure(%s)); END $d$;",
            (f"public.audit_trail_page({LIST_TYPES})",),
        )
        self.create_single_value_form()
        with self.assertRaises(psycopg2.errors.RaiseException) as raised:
            self.cur.execute(check)
        self.assertIn("p_entity_type as text, not as text[]", str(raised.exception))

    def test_every_declaration_is_the_list_form(self):
        declared = re.compile(r"CREATE OR REPLACE FUNCTION public\.audit_trail_page\(([^\n]*?)\)\s+RETURNS")
        found = []
        for path in sorted(HERE.glob("[0-9][0-9][0-9][0-9]_*.sql")):
            for m in declared.finditer(path.read_text(encoding="utf-8")):
                found.append(path.name)
                args = m.group(1)
                for arg in ("p_entity_type text[] DEFAULT NULL::text[]", "p_action text[] DEFAULT NULL::text[]",
                            "p_changed_by uuid[] DEFAULT NULL::uuid[]"):
                    self.assertIn(arg, args, f"{path.name} declares audit_trail_page without {arg}")
        self.assertEqual(sorted(found), ["0001_baseline_schema.sql",
                                         "0168_every_schema_attached_to_a_device_counts.sql"])

    def test_the_comment_states_the_lists(self):
        self.cur.execute(
            "SELECT obj_description(p.oid, 'pg_proc') FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';"
        )
        comment = self.cur.fetchone()[0] or ""
        self.assertIn("each matched as any of its values", comment)
        self.assertIn("(0227)", comment)


if __name__ == "__main__":
    unittest.main(verbosity=2)
