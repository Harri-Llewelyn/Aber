"""
The Audit Trail sorts events into classes in the database (0228).

    python supabase/migrations/test_the_audit_trail_sorts_events_into_classes_in_the_database.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * audit_event_class() answers every case in test-harness/fixtures/audit-event-classes.json, the
    four reads included, and is an IMMUTABLE SQL function with no SET clause, so it inlines.
  * audit_trail_page(p_class) keeps the rows of any of those classes, combined with the other lists
    by AND, and every event carries its class. The cursor, the totals and the caller's policies hold.
  * p_counts answers each class's, kind's and action's events under every filter but its own, under
    the search, the window, the people and the purged rule.
  * A backup request's id finds its own rows and the rows of the backup it took, released or pruned;
    a cancelled request's finds its own; any other id finds what it did.
  * One form is declared, with its grants, planned with its values, and its five class indexes are
    valid and serve a query that names a class. A database still holding the form from before 0228
    is brought to the one form by 0001's declaration and sweep, 0168, 0222, 0227 and 0228, and 0228
    drops that form by itself too.

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

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parents[1] / "test-harness" / "fixtures" / "audit-event-classes.json"
BASELINE = HERE / "0001_baseline_schema.sql"
SCHEMA_FILE = HERE / "0168_every_schema_attached_to_a_device_counts.sql"
ACTOR_FILTER = HERE / "0222_a_decision_keeps_its_decider_s_address_and_the_trail_filters_by_actor.sql"
LISTS_FILE = HERE / "0227_an_audit_trail_filter_takes_several_values.sql"
MIGRATION = HERE / "0228_the_audit_trail_sorts_events_into_classes_in_the_database.sql"
CLASSES = ("created", "operational", "configuration", "lifecycle", "read")

ADMIN = "a0d17280-0000-4000-8000-0000000228a1"
MANAGER = "a0d17280-0000-4000-8000-0000000228a2"
# One subject per seeded row, none of them a live entity.
SUBJECTS = [f"a0d17280-0000-4000-8000-0000000228c{i}" for i in range(8)]

FORM = (
    "p_limit integer, p_include_purged boolean, p_entity_type text[], p_action text[], "
    "p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, "
    "p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text, "
    "p_changed_by uuid[], p_class text[], p_counts boolean"
)
TYPES = (
    "integer, boolean, text[], text[], uuid[], timestamp with time zone, timestamp with time zone, "
    "timestamp with time zone, bigint, text, uuid[], text[], boolean"
)
LIST_TYPES = (
    "integer, boolean, text[], text[], uuid[], timestamp with time zone, timestamp with time zone, "
    "timestamp with time zone, bigint, text, uuid[]"
)

# subject, entity_type, action, old_data, new_data, the class it is in
ROWS = (
    (0, "devices", "INSERT", None, {"name": "Class Press"}, "created"),
    (1, "devices", "UPDATE", {"status": "ONLINE"}, {"status": "OFFLINE"}, "operational"),
    (2, "devices", "UPDATE", {"is_quarantined": False}, {"is_quarantined": True}, "lifecycle"),
    (3, "gateways", "UPDATE", {"access_url": "http://a"}, {"access_url": "http://b"}, "configuration"),
    (4, "gateways", "CREDENTIAL_SHOWN", None, {"name": "Class Gateway"}, "read"),
    (5, "cells", "DELETE", {"name": "Class Line"}, None, "lifecycle"),
    (6, "service_logs", "SERVICE_LOGS_READ", None, {"name": "ingestion"}, "read"),
    (7, "system_settings", "UPDATE", {"value": 1}, {"value": 2}, "configuration"),
)
SECURITY = {6, 7}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def expected(classes=None, kinds=None, actions=None, rows=ROWS):
    """The subjects the filters select, newest first."""
    return sorted((r[0] for r in rows
                   if (not classes or r[5] in classes) and (not kinds or r[1] in kinds)
                   and (not actions or r[2] in actions)), reverse=True)


def selected(classes, kinds, actions):
    """The seeded rows the three lists select; a list that is None is no constraint."""
    return [r for r in ROWS if (not classes or r[5] in classes) and (not kinds or r[1] in kinds)
            and (not actions or r[2] in actions)]


def tally(rows, key):
    out = {}
    for r in rows:
        out[r[key]] = out.get(r[key], 0) + 1
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def people(self):
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in ((ADMIN, "Administrator"), (MANAGER, "Shopfloor_Manager")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@classes.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )

    def as_person(self, user_id, sql, args=()):
        """Run `sql` as PostgREST would for a token naming `user_id`. Returns the rows."""
        self.cur.execute("SAVEPOINT classes_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute(
                "SELECT set_config('request.jwt.claims', %s, true);",
                (json.dumps({"sub": user_id, "role": "authenticated"}),),
            )
            self.cur.execute(sql, args)
            rows = self.cur.fetchall()
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT classes_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT classes_call;")
        return rows

    def forms(self):
        self.cur.execute(
            "SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page' ORDER BY 1;"
        )
        return [r[0] for r in self.cur.fetchall()]


# -------------------------------------------------------------------------------------------------
# The classifier
# -------------------------------------------------------------------------------------------------
class TheClassifier(Base):
    def classify(self, case):
        self.cur.execute(
            "SELECT public.audit_event_class(%s, %s, %s, %s::jsonb, %s::jsonb);",
            (case["action"], case["entity_type"], case["audit_domain"],
             None if case["old_data"] is None else json.dumps(case["old_data"]),
             None if case["new_data"] is None else json.dumps(case["new_data"])),
        )
        return self.cur.fetchone()[0]

    def test_every_fixture_case(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 40)
        for case in cases:
            with self.subTest(case=case["name"]):
                self.assertIn(case["class"], CLASSES)
                self.assertEqual(self.classify(case), case["class"])

    def test_the_fixture_covers_every_class(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertEqual(sorted({c["class"] for c in cases}), sorted(CLASSES))

    def test_the_reads_are_the_only_cases_the_browser_answered_otherwise(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        differ = sorted(c["action"] for c in cases if "browser" in c)
        self.assertEqual(differ, ["CAPTURE_DOWNLOAD_ISSUED", "CREDENTIAL_SHOWN", "EXPORTED", "SERVICE_LOGS_READ"])
        self.assertTrue(all(c["class"] == "read" for c in cases if "browser" in c))

    def test_a_read_in_the_security_lane_is_still_a_read(self):
        self.assertEqual(self.classify({
            "action": "SERVICE_LOGS_READ", "entity_type": "service_logs", "audit_domain": "security",
            "old_data": None, "new_data": {"name": "ingestion"}}), "read")

    def test_it_inlines(self):
        """IMMUTABLE, SQL, SECURITY INVOKER and no SET clause: what lets an index be built on it."""
        self.cur.execute(
            "SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig"
            "  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
            " WHERE p.oid = 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure;"
        )
        self.assertEqual(self.cur.fetchone(), ("sql", "i", False, None))

    def test_who_may_run_it(self):
        self.cur.execute(
            "SELECT has_function_privilege('authenticated', f, 'EXECUTE'),"
            "       has_function_privilege('service_role', f, 'EXECUTE'),"
            "       has_function_privilege('anon', f, 'EXECUTE')"
            "  FROM (SELECT 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure AS f) x;"
        )
        self.assertEqual(self.cur.fetchone(), (True, True, False))


# -------------------------------------------------------------------------------------------------
# The class filter, the class on each event, and the counts
# -------------------------------------------------------------------------------------------------
class TheSeededTrail(Base):
    PAGE = (
        "SELECT public.audit_trail_page(p_entity_ids => %(ids)s::uuid[], p_include_purged => %(purged)s,"
        " p_class => %(classes)s::text[], p_entity_type => %(kinds)s::text[], p_action => %(actions)s::text[],"
        " p_search => %(search)s, p_limit => %(limit)s, p_counts => %(counts)s,"
        " p_before_recorded_at => %(before_at)s::timestamptz, p_before_id => %(before_id)s::bigint);"
    )

    def setUp(self):
        super().setUp()
        self.people()
        for i, (subject, kind, action, old, new, _) in enumerate(ROWS):
            self.cur.execute(
                "INSERT INTO public.audit_trail"
                "  (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, recorded_at)"
                " VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s, 'user',"
                "         timestamptz '2026-04-03 00:00:00+00' + make_interval(mins => %s));",
                (kind, SUBJECTS[subject], action, None if old is None else json.dumps(old),
                 None if new is None else json.dumps(new), ADMIN, i),
            )

    def page(self, classes=None, kinds=None, actions=None, *, as_user=None, search=None, limit=None,
             cursor=None, counts=False, purged=True):
        args = {"ids": SUBJECTS, "purged": purged, "classes": classes, "kinds": kinds, "actions": actions,
                "search": search, "limit": limit, "counts": counts,
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

    def test_every_event_carries_its_class(self):
        payload = self.page()
        self.assertEqual({SUBJECTS.index(e["entity_id"]): e["class"] for e in payload["events"]},
                         {r[0]: r[5] for r in ROWS})

    def test_one_class_or_several(self):
        for classes in (["read"], ["lifecycle"], ["read", "lifecycle"], ["created", "configuration"], list(CLASSES)):
            with self.subTest(classes=classes):
                self.assertSelects(self.page(classes), expected(classes))

    def test_null_and_an_empty_list_are_no_constraint(self):
        self.assertSelects(self.page(), expected())
        self.assertSelects(self.page([]), expected())

    def test_a_class_nobody_has_matches_nothing(self):
        self.assertSelects(self.page(["critical"]), [])
        self.assertSelects(self.page(["critical", "read"]), expected(["read"]))

    def test_the_class_is_combined_with_the_other_lists(self):
        for classes, kinds, actions in (
            (["lifecycle"], ["devices"], None),
            (["read", "configuration"], ["gateways"], None),
            (["configuration"], None, ["UPDATE"]),
            (["lifecycle", "read"], ["cells", "service_logs"], ["DELETE"]),
        ):
            with self.subTest(classes=classes, kinds=kinds, actions=actions):
                self.assertSelects(self.page(classes, kinds, actions), expected(classes, kinds, actions))

    def test_the_cursor_walks_a_class_and_the_total_stays_put(self):
        classes = ["lifecycle", "configuration"]
        seen, cursor = [], None
        for _ in range(10):
            payload = self.page(classes, limit=1, cursor=cursor)
            seen += self.subjects(payload)
            self.assertEqual(payload["total_matching"], 4)
            cursor = payload["next_cursor"]
            if cursor is None:
                break
        self.assertEqual(seen, expected(classes))

    def test_the_caller_s_policies_still_decide_the_rows(self):
        self.assertSelects(self.page(["read", "configuration"], as_user=ADMIN), [7, 6, 4, 3])
        # The security lane's read and setting are not the Shopfloor Manager's.
        self.assertSelects(self.page(["read", "configuration"], as_user=MANAGER), [4, 3])

    def test_no_counts_unless_asked(self):
        self.assertIsNone(self.page().get("counts"))

    def test_the_counts_with_nothing_chosen(self):
        counts = self.page(counts=True)["counts"]
        self.assertEqual(counts["class"], tally(ROWS, 5))
        self.assertEqual(counts["entity_type"], tally(ROWS, 1))
        self.assertEqual(counts["action"], tally(ROWS, 2))

    def test_each_filter_is_left_out_of_its_own_counts(self):
        for classes, kinds, actions in (
            (["read"], None, None),
            (None, None, ["UPDATE"]),
            (["lifecycle"], ["devices"], None),
            (["configuration", "read"], ["gateways", "system_settings"], ["UPDATE"]),
        ):
            with self.subTest(classes=classes, kinds=kinds, actions=actions):
                payload = self.page(classes, kinds, actions, counts=True)
                self.assertSelects(payload, expected(classes, kinds, actions))
                self.assertEqual(payload["counts"]["class"], tally(selected(None, kinds, actions), 5))
                self.assertEqual(payload["counts"]["entity_type"], tally(selected(classes, None, actions), 1))
                self.assertEqual(payload["counts"]["action"], tally(selected(classes, kinds, None), 2))

    def test_the_counts_follow_the_search_and_the_policies(self):
        counts = self.page(search="Class", counts=True)["counts"]
        named = [r for r in ROWS if r[0] in (0, 4, 5)]
        self.assertEqual(counts["class"], tally(named, 5))
        counts = self.page(counts=True, as_user=MANAGER)["counts"]
        self.assertEqual(counts["class"], tally([r for r in ROWS if r[0] not in SECURITY], 5))

    def test_the_counts_follow_the_purged_rule(self):
        """None of the subjects is live, so hiding the deleted leaves the security lane's two rows."""
        payload = self.page(counts=True, purged=False)
        self.assertEqual(payload["counts"]["class"], {"read": 1, "configuration": 1})
        self.assertEqual(payload["counts"]["entity_type"], {"service_logs": 1, "system_settings": 1})
        self.assertEqual((payload["total_matching"], payload["purged_assets"]), (2, 6))
        self.assertEqual(self.page(["lifecycle"], purged=False)["purged_assets"], 2)


# -------------------------------------------------------------------------------------------------
# A backup request's id finds the backup it took
# -------------------------------------------------------------------------------------------------
class TheBackupSearch(Base):
    JOB = "a0d17280-0000-4000-8000-0000000228e1"
    BACKUP = "a0d17280-0000-4000-8000-0000000228e2"
    CANCELLED = "a0d17280-0000-4000-8000-0000000228e3"
    OTHER_JOB = "a0d17280-0000-4000-8000-0000000228e4"
    OTHER_BACKUP = "a0d17280-0000-4000-8000-0000000228e5"

    def setUp(self):
        super().setUp()
        self.people()
        rows = (
            ("backup_jobs", self.JOB, "BACKUP_REQUESTED", {"origin": "requested"}),
            ("backups", self.BACKUP, "BACKUP_TAKEN", {"stamp": "20260404T000000Z", "job_id": self.JOB}),
            ("backups", self.BACKUP, "BACKUP_RELEASED", {"pinned": False}),
            ("backups", self.BACKUP, "BACKUP_PRUNED", {"reason": "retention"}),
            ("backup_jobs", self.CANCELLED, "BACKUP_REQUESTED", {"origin": "requested"}),
            ("backup_jobs", self.CANCELLED, "BACKUP_CANCELLED", {"status": "CANCELLED"}),
            ("backup_jobs", self.OTHER_JOB, "BACKUP_REQUESTED", {"origin": "scheduled"}),
            ("backups", self.OTHER_BACKUP, "BACKUP_TAKEN", {"stamp": "20260404T010000Z", "job_id": self.OTHER_JOB}),
        )
        for i, (kind, entity, action, new) in enumerate(rows):
            self.cur.execute(
                "INSERT INTO public.audit_trail"
                "  (entity_type, entity_id, action, new_data, actor_source, recorded_at)"
                " VALUES (%s, %s, %s, %s::jsonb, 'service',"
                "         timestamptz '2026-04-04 00:00:00+00' + make_interval(mins => %s));",
                (kind, entity, action, json.dumps(new), i),
            )

    def lanes(self, term, as_user=ADMIN):
        payload = self.as_person(as_user, "SELECT public.audit_trail_page(p_search => %s);", (term,))[0][0]
        return sorted((e["entity_id"], e["action"]) for e in payload["events"]), payload["total_matching"]

    def test_a_request_finds_the_backup_it_took_released_and_pruned(self):
        events, total = self.lanes(self.JOB)
        self.assertEqual(events, sorted([
            (self.JOB, "BACKUP_REQUESTED"), (self.BACKUP, "BACKUP_TAKEN"),
            (self.BACKUP, "BACKUP_RELEASED"), (self.BACKUP, "BACKUP_PRUNED")]))
        self.assertEqual(total, 4)
        # The id as a person might paste it, in capitals.
        self.assertEqual(self.lanes(self.JOB.upper())[0], events)

    def test_a_cancelled_request_finds_its_own_lane(self):
        events, _ = self.lanes(self.CANCELLED)
        self.assertEqual(events, sorted([(self.CANCELLED, "BACKUP_REQUESTED"), (self.CANCELLED, "BACKUP_CANCELLED")]))

    def test_any_other_id_finds_what_it_did(self):
        # The backup's own id finds its rows and not its request's.
        events, _ = self.lanes(self.BACKUP)
        self.assertEqual({e[0] for e in events}, {self.BACKUP})
        # Part of an id is a substring search, as before, and takes no backup with it.
        events, _ = self.lanes(self.JOB[-6:])
        self.assertEqual({e[0] for e in events}, {self.JOB})

    def test_a_shopfloor_manager_finds_neither_lane(self):
        self.assertEqual(self.lanes(self.JOB, as_user=MANAGER), ([], 0))


# -------------------------------------------------------------------------------------------------
# One form, its grants and its indexes, whatever replays
# -------------------------------------------------------------------------------------------------
class OneForm(Base):
    def create_list_form(self):
        """The form a database from before 0228 holds, beside the one 0001 creates."""
        self.cur.execute(
            "CREATE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200,"
            " p_include_purged boolean DEFAULT false, p_entity_type text[] DEFAULT NULL,"
            " p_action text[] DEFAULT NULL, p_entity_ids uuid[] DEFAULT NULL,"
            " p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL,"
            " p_before_recorded_at timestamptz DEFAULT NULL, p_before_id bigint DEFAULT NULL,"
            " p_search text DEFAULT NULL, p_changed_by uuid[] DEFAULT NULL) RETURNS jsonb"
            " LANGUAGE sql STABLE SET search_path TO 'public' AS $$ SELECT '{}'::jsonb $$;"
        )

    def block(self, path, pattern):
        found = re.search(pattern, path.read_text(encoding="utf-8"), re.S)
        self.assertIsNotNone(found, f"{path.name} no longer has the block this replays")
        return found.group(0)

    def baseline_declaration(self):
        return self.block(
            BASELINE,
            r"CREATE OR REPLACE FUNCTION public\.audit_trail_page\(.*?\$_\$;.*?"
            r"COMMENT ON FUNCTION public\.audit_trail_page\([^\n]*",
        )

    def sweep(self):
        self.cur.execute(self.block(BASELINE, r"DO \$overloads\$.*?\$overloads\$;"))
        self.cur.execute("RESET search_path;")

    def oids(self):
        self.cur.execute(
            "SELECT %s::regprocedure::oid, 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure::oid;",
            (f"public.audit_trail_page({TYPES})",))
        return self.cur.fetchone()

    def test_the_chain_leaves_one_form(self):
        self.assertEqual(self.forms(), [FORM])

    def test_its_grants_its_invoker_rights_and_its_plans(self):
        self.cur.execute(
            "SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE'),"
            "       has_function_privilege('service_role', p.oid, 'EXECUTE'),"
            "       has_function_privilege('anon', p.oid, 'EXECUTE'), p.prosecdef, p.proconfig"
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';"
        )
        authenticated, service, anon, definer, config = self.cur.fetchone()
        self.assertEqual((authenticated, service, anon, definer), (True, True, False, False))
        self.assertIn("search_path=public", config)
        self.assertIn("plan_cache_mode=force_custom_plan", config)

    def test_the_row_helper_inlines(self):
        self.cur.execute(
            "SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig,"
            "       has_function_privilege('authenticated', p.oid, 'EXECUTE'),"
            "       has_function_privilege('anon', p.oid, 'EXECUTE')"
            "  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'audit_trail_matching';"
        )
        self.assertEqual(self.cur.fetchall(), [("sql", "s", False, None, True, False)])

    def test_each_class_has_a_valid_index_that_a_query_naming_it_uses(self):
        for cls in CLASSES:
            with self.subTest(cls=cls):
                self.cur.execute(
                    "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid"
                    " WHERE i.indrelid = 'public.audit_trail'::regclass AND c.relname = %s;",
                    (f"idx_audit_trail_class_{cls}",))
                self.assertEqual(self.cur.fetchall(), [(True,)])
                self.cur.execute("SET LOCAL enable_seqscan = off;")
                self.cur.execute(
                    "EXPLAIN SELECT count(*) FROM public.audit_trail t"
                    " WHERE public.audit_event_class(t.action, t.entity_type, t.audit_domain, t.old_data, t.new_data) = %s;",
                    (cls,))
                plan = "\n".join(r[0] for r in self.cur.fetchall())
                self.assertRegex(plan, r"Index Only Scan using \S+")
                self.assertNotIn("CASE", plan, "the class is read from the index, not computed")

    def test_a_first_upgrade_boot_ends_with_one_form(self):
        """0001 declares the new form beside the old one, its sweep drops the old one, and 0168, 0222,
        0227 and 0228 replay over the result."""
        self.create_list_form()
        self.cur.execute(self.baseline_declaration())
        self.assertEqual(len(self.forms()), 2)
        self.sweep()
        self.assertEqual(self.forms(), [FORM])
        for path in (SCHEMA_FILE, ACTOR_FILTER, LISTS_FILE, MIGRATION):
            with self.subTest(replayed=path.name):
                self.cur.execute(path.read_text(encoding="utf-8"))
                self.assertEqual(self.forms(), [FORM])
        self.cur.execute("SELECT public.audit_trail_page(p_limit => 1, p_class => ARRAY['read']) ? 'events';")
        self.assertTrue(self.cur.fetchone()[0])

    def test_0228_drops_the_form_from_before_by_itself(self):
        self.create_list_form()
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(self.forms(), [FORM])
        self.cur.execute("SELECT to_regprocedure(%s);", (f"public.audit_trail_page({LIST_TYPES})",))
        self.assertIsNone(self.cur.fetchone()[0])

    def test_a_later_boot_recreates_nothing(self):
        before = self.oids()
        self.cur.execute(self.baseline_declaration())
        self.sweep()
        for path in (SCHEMA_FILE, ACTOR_FILTER, LISTS_FILE, MIGRATION):
            self.cur.execute(path.read_text(encoding="utf-8"))
        self.assertEqual(self.oids(), before)

    def test_the_self_check_refuses_two_forms(self):
        check = self.block(MIGRATION, r"DO \$check\$.*?\$check\$;")
        self.create_list_form()
        with self.assertRaises(psycopg2.errors.RaiseException) as raised:
            self.cur.execute(check)
        self.assertIn("declared 2 times", str(raised.exception))

    def test_the_self_check_refuses_a_missing_class_index(self):
        check = self.block(MIGRATION, r"DO \$check\$.*?\$check\$;")
        self.cur.execute("DROP INDEX public.idx_audit_trail_class_read;")
        with self.assertRaises(psycopg2.errors.RaiseException) as raised:
            self.cur.execute(check)
        self.assertIn("idx_audit_trail_class_read", str(raised.exception))

    def test_every_declaration_is_this_form(self):
        declared = re.compile(r"CREATE OR REPLACE FUNCTION public\.audit_trail_page\(([^\n]*?)\)\s+RETURNS")
        found = []
        for path in sorted(HERE.glob("[0-9][0-9][0-9][0-9]_*.sql")):
            for m in declared.finditer(path.read_text(encoding="utf-8")):
                found.append(path.name)
                self.assertIn("p_class text[] DEFAULT NULL::text[], p_counts boolean DEFAULT false", m.group(1),
                              f"{path.name} declares audit_trail_page without p_class and p_counts")
        self.assertEqual(sorted(found), ["0001_baseline_schema.sql",
                                         "0168_every_schema_attached_to_a_device_counts.sql"])

    def test_0001_and_0168_declare_the_same_body(self):
        pattern = r"CREATE OR REPLACE FUNCTION public\.audit_trail_page\(.*?\$_\$;"
        self.assertEqual(self.block(BASELINE, pattern), self.block(SCHEMA_FILE, pattern))


if __name__ == "__main__":
    unittest.main(verbosity=2)
