# suite:
#   lanes: db
#   why: 0330 -- find_entities() answers at most p_per_kind rows of each kind, the best first, and without it
#     answers row for row what 0321's body does, for every role; one form of it is left whichever file ran
#     last; and the read policies of retired_entities, captures, backups and machine_principals ask
#     once for a statement and admit whom they did. Two forms are a search PostgREST cannot route.

"""
A search asks about the tombstones once, and can limit each kind (0330).

    python supabase/migrations/test_a_search_asks_about_the_tombstones_once.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * find_entities() takes p_per_kind. It answers at most that many rows of each kind: a whole id, a whole
    name, the start of an id, part of a name; what is in service before what was archived and deleted
    among equals; then by name, a shorter one first. A number below 1 is 1. p_limit holds the total.
  * Without p_per_kind it answers what 0321's body answers, the same rows in the same order, for each
    role and for a caller with none. That body is read out of 0321 and run beside it.
  * One form is declared. A database that holds 0321's as well, as each later boot's does until 0330
    runs, is brought to the one form by 0330. anon and service_role may not call it.
  * Each of the four policies 0330 states is an initplan of its read, and admits the roles it did.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ROLES = {
    "Administrator": "a0d17070-0000-4000-8000-0000000330a1",
    "Shopfloor_Manager": "a0d17070-0000-4000-8000-0000000330a2",
    "Operator": "a0d17070-0000-4000-8000-0000000330a3",
    "Auditor": "a0d17070-0000-4000-8000-0000000330a4",
}
# A signed-in account that holds no role.
NOBODY = "a0d17070-0000-4000-8000-0000000330a5"

# Each restated policy's table, the function it asks, and the roles it admits.
ASKED = {
    "retired_entities": ("has_authority", {"Administrator", "Shopfloor_Manager", "Auditor"}),
    "captures": ("has_role", {"Administrator", "Shopfloor_Manager", "Auditor"}),
    "backups": ("has_role", {"Administrator"}),
    "machine_principals": ("has_role", {"Administrator", "Auditor"}),
}

HERE = Path(__file__).resolve().parent
OWNER = HERE / "0321_every_entity_is_listed_and_found_by_any_id.sql"
MIGRATION = HERE / "0330_a_search_asks_about_the_tombstones_once.sql"


def between(path, start, end):
    """The text of `path` from `start` to the end of the first `end` after it."""
    text = path.read_text(encoding="utf-8")
    at = text.index(start)
    return text[at:text.index(end, at) + len(end)]


# 0321's function with its grants, as each boot declares it, and 0330's drop and declaration without
# the transaction it runs them in.
TWO_ARGUMENTS = between(OWNER, "CREATE OR REPLACE FUNCTION public.find_entities(", "TO authenticated;")
THREE_ARGUMENTS = between(MIGRATION, "DROP FUNCTION IF EXISTS public.find_entities(text, integer);", "TO authenticated;")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: rows as the owner, reads as a caller, a rollback."""

    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.find_entities(text, integer, integer)');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0330 is not applied to this database")
        self.tag = uuid.uuid4().hex[:8]
        for role, user_id in ROLES.items():
            self.make_person(user_id, role)
        self.make_person(NOBODY, None)

    # -- fixtures, as the owner ----------------------------------------------------------------

    def make_person(self, user_id, role):
        self.cur.execute(
            "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
            (user_id, f"entities-0330-{user_id[-2:]}@test.local"),
        )
        if role:
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    def one(self, sql, args=()):
        self.cur.execute(sql, args)
        return self.cur.fetchone()[0]

    def make_gateway(self, name):
        return self.one(
            "INSERT INTO public.gateways (name, deployment) VALUES (%s, 'remote') RETURNING id::text;", (name,))

    def make_device(self, name, reported=None, archived=False):
        return self.one(
            "INSERT INTO public.devices (name, location_scope, reported_identity, is_archived) "
            "VALUES (%s, 'site_wide', %s, %s) RETURNING id::text;", (name, reported, archived))

    def make_cell(self, name):
        return self.one("INSERT INTO public.cells (name) VALUES (%s) RETURNING id::text;", (name,))

    def make_tombstone(self, name):
        return self.one(
            "INSERT INTO public.retired_entities (entity_type, entity_id, name, sparkplug_id, old_data) "
            "VALUES ('devices', gen_random_uuid(), %s, %s, %s) RETURNING entity_id::text;",
            (name, f"dev{uuid.uuid4().hex[:21]}", json.dumps({"name": name})))

    # -- reads ---------------------------------------------------------------------------------

    def read_as(self, caller, sql, args=()):
        self.cur.execute("SAVEPOINT entities_read;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": caller, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall()
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT entities_read;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT entities_read;")
        return rows

    def find(self, text, limit=None, per_kind=None, role="Administrator"):
        """The (kind, id, name, state) of each row, with only the arguments a caller names."""
        named = {"p_query": text}
        if limit is not None:
            named["p_limit"] = limit
        if per_kind is not None:
            named["p_per_kind"] = per_kind
        given = ", ".join(f"{name} => %({name})s" for name in named)
        return self.read_as(ROLES[role], f"SELECT kind, id, name, state FROM public.find_entities({given});", named)

    def names(self, *args, **kwargs):
        return [row[2] for row in self.find(*args, **kwargs)]


class TheLimitOfEachKind(Base):
    def test_a_kind_that_fills_the_answer_leaves_room_for_the_others(self):
        self.cur.execute(
            "INSERT INTO public.devices (name, location_scope) "
            "SELECT %s || i, 'site_wide' FROM generate_series(1, 520) i;", (f"Bay {self.tag} lathe ",))
        cells = {self.make_cell(f"Bay {self.tag} zone {i}") for i in range(3)}
        text = f"bay {self.tag}"
        self.assertEqual({r[0] for r in self.find(text)}, {"devices"})
        rows = self.find(text, per_kind=10)
        self.assertEqual(sum(r[0] == "devices" for r in rows), 10)
        self.assertEqual({r[1] for r in rows if r[0] == "cells"}, cells)
        self.assertEqual(len(rows), 13)

    def test_a_number_below_one_is_one(self):
        for i in range(3):
            self.make_device(f"Bay {self.tag} {i}")
        for per_kind in (1, 0, -5):
            with self.subTest(per_kind=per_kind):
                self.assertEqual(len(self.find(f"bay {self.tag}", per_kind=per_kind)), 1)
        self.assertEqual(len(self.find(f"bay {self.tag}", per_kind=100000)), 3)

    def test_the_best_of_a_kind_are_kept(self):
        key = f"zz{self.tag}"
        for i in range(12):
            self.make_device(f"A {key} {i}")
        owner = self.make_device("Zebra", reported=key)
        named = self.make_device(key.upper())
        start = self.make_device("Yak", reported=f"{key}-9")
        # A whole id, a whole name, the start of an id, part of a name, however the names fall.
        rows = [r[1] for r in self.find(key, per_kind=4)]
        self.assertEqual(rows[:3], [owner, named, start])
        self.assertEqual(len(rows), 4)

    def test_what_is_in_service_is_before_what_was_taken_out(self):
        text = f"bay {self.tag}"
        self.make_tombstone(f"Bay {self.tag} A")
        self.make_device(f"Bay {self.tag} B", archived=True)
        self.make_device(f"Bay {self.tag} longest of them all")
        self.assertEqual([r[3] for r in self.find(text, per_kind=10)], ["active", "archived", "retired"])
        self.assertEqual([r[3] for r in self.find(text, per_kind=1)], ["active"])
        self.assertEqual([r[3] for r in self.find(text, per_kind=2)], ["active", "archived"])
        # Among equals only: a whole name that was deleted is before a part of one in service.
        gone = self.make_tombstone(text)
        self.assertEqual([r[1] for r in self.find(text, per_kind=1)], [gone])

    def test_press_2_is_kept_before_press_10(self):
        for i in range(1, 13):
            self.make_device(f"Press {self.tag} {i}")
        kept = self.names(f"press {self.tag}", per_kind=10)
        self.assertEqual(set(kept), {f"Press {self.tag} {i}" for i in range(1, 11)})

    def test_the_total_is_still_held_to_the_limit(self):
        for i in range(8):
            self.make_device(f"Bay {self.tag} {i}")
            self.make_cell(f"Bay {self.tag} {i}")
        text = f"bay {self.tag}"
        self.assertEqual(len(self.find(text, per_kind=5)), 10)
        self.assertEqual(len(self.find(text, limit=4, per_kind=5)), 4)
        self.assertEqual(len(self.find(text, limit=0, per_kind=5)), 1)
        # The total keeps the best of them: one whole id, then what is in service.
        owner = self.make_device("Zebra", reported=text)
        self.make_tombstone(f"Bay {self.tag}a")
        rows = self.find(text, limit=3, per_kind=5)
        self.assertEqual(rows[0][1], owner)
        self.assertEqual({r[3] for r in rows}, {"active"})

    def test_it_lists_no_row_the_whole_answer_does_not(self):
        for i in range(4):
            self.make_device(f"Bay {self.tag} {i}", reported=f"plc-{self.tag}-{i}")
            self.make_cell(f"Bay {self.tag} {i}")
            self.make_tombstone(f"Bay {self.tag} {i}")
        for role in ROLES:
            for text in (f"bay {self.tag}", f"plc-{self.tag}", self.tag):
                with self.subTest(role=role, text=text):
                    self.assertLessEqual(set(self.find(text, limit=500, per_kind=2, role=role)),
                                         set(self.find(text, limit=500, role=role)))

    def test_it_is_under_the_callers_own_policies(self):
        gone = self.make_tombstone(f"Bay {self.tag}")
        for role in ROLES:
            with self.subTest(role=role):
                ids = [r[1] for r in self.find(f"bay {self.tag}", per_kind=10, role=role)]
                self.assertEqual(ids, [gone] if role in ASKED["retired_entities"][1] else [])

    def test_blank_text_finds_nothing(self):
        for text in (None, "", "  \t"):
            with self.subTest(text=text):
                self.assertEqual(self.find(text, per_kind=10), [])


class WithoutIt(Base):
    """0321's body, read out of that file, answers beside the one this file declares."""

    BEFORE = "find_entities_of_0321"

    def setUp(self):
        super().setUp()
        body = TWO_ARGUMENTS.replace("public.find_entities(", f"public.{self.BEFORE}(")
        self.assertIn(f"CREATE OR REPLACE FUNCTION public.{self.BEFORE}(p_query text, p_limit integer DEFAULT 200)", body)
        self.cur.execute(body)
        t = self.tag
        for i in range(30):
            self.make_device(f"Bay {t} {i % 7}", reported=f"plc-{t}-{i}", archived=i % 5 == 0)
            self.make_cell(f"Bay {t} {i}")
        for i in range(6):
            self.make_gateway(f"bay {t} {i}")
            self.make_tombstone(f"Bay {t} {i}")
        self.device = self.make_device(f"plc-{t}-3")
        self.cur.execute(
            "INSERT INTO public.devices (name, location_scope) "
            "SELECT %s || i, 'site_wide' FROM generate_series(1, 260) i;", (f"Many {t} ",))

    def both(self, caller, text, limit):
        return [self.read_as(caller, f"SELECT to_jsonb(e)::text FROM public.{name}(%s, %s) e;", (text, limit))
                for name in (self.BEFORE, "find_entities")]

    def test_it_answers_row_for_row_what_0321_does(self):
        t = self.tag
        answered = 0
        for name, caller in [*ROLES.items(), ("no role", NOBODY)]:
            for text in (f"bay {t}", f"BAY {t} 3", f"plc-{t}", f" plc-{t}-3\n", self.device, self.device[:8],
                         f"many {t}", t, "%", "  ", None):
                for limit in (None, 0, 7, 100000):
                    with self.subTest(caller=name, text=text, limit=limit):
                        before, now = self.both(caller, text, limit)
                        self.assertEqual(now, before)
                        answered += len(now)
        self.assertGreater(answered, 1000)

    def test_a_call_naming_p_query_alone_and_one_naming_the_two_are_answered(self):
        self.assertEqual(len(self.find(f"many {self.tag}")), 200)
        self.assertEqual(len(self.find(f"many {self.tag}", limit=250)), 250)
        null = self.read_as(ROLES["Operator"], "SELECT id FROM public.find_entities(%s, 250, NULL);", (f"many {self.tag}",))
        self.assertEqual(len(null), 250)


class OneForm(Base):
    def forms(self):
        self.cur.execute(
            "SELECT pg_get_function_arguments(p.oid) FROM pg_proc p "
            " WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'find_entities' ORDER BY 1;")
        return [row[0] for row in self.cur.fetchall()]

    THREE = "p_query text, p_limit integer DEFAULT 200, p_per_kind integer DEFAULT NULL::integer"

    def test_one_form_is_declared(self):
        self.assertEqual(self.forms(), [self.THREE])

    def test_a_later_boot_is_brought_back_to_the_one_form(self):
        # 0321 replays first and declares its own beside it: neither can then be called by name.
        self.cur.execute(TWO_ARGUMENTS)
        self.assertEqual(len(self.forms()), 2)
        with self.assertRaises(psycopg2.errors.AmbiguousFunction):
            self.find("x", limit=200)
        self.cur.execute(THREE_ARGUMENTS)
        self.assertEqual(self.forms(), [self.THREE])
        self.find("x", limit=200)

    def test_it_runs_as_its_caller_and_only_a_signed_in_one_may(self):
        self.cur.execute(
            "SELECT prosecdef, proconfig, provolatile FROM pg_proc "
            " WHERE oid = 'public.find_entities(text, integer, integer)'::regprocedure;")
        self.assertEqual(self.cur.fetchone(), (False, ["search_path=public"], "s"))
        self.cur.execute(
            "SELECT array_agg(has_function_privilege(r, 'public.find_entities(text, integer, integer)', 'EXECUTE') ORDER BY n) "
            "  FROM unnest(ARRAY['anon', 'service_role', 'authenticated']) WITH ORDINALITY AS x(r, n);")
        self.assertEqual(self.cur.fetchone()[0], [False, False, True])
        self.cur.execute("SAVEPOINT anon_read;")
        self.cur.execute("SET LOCAL ROLE anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM public.find_entities('x', 200, 10);")
        self.cur.execute("ROLLBACK TO SAVEPOINT anon_read;")


class ThePoliciesAskOnce(Base):
    def setUp(self):
        super().setUp()
        self.planted = {}
        device = self.make_device(f"Lathe {self.tag}")
        self.planted["retired_entities"] = ("entity_id", self.make_tombstone(f"Old press {self.tag}"))
        self.planted["captures"] = ("id", self.one(
            "INSERT INTO public.captures (subject_kind, device_id, subject_sparkplug_id, storage_path, size_bytes, message_count) "
            "SELECT 'device', id, sparkplug_id, sparkplug_id || '/' || gen_random_uuid() || '.json', 1, 1 "
            "  FROM public.devices WHERE id = %s RETURNING id::text;", (device,)))
        self.planted["backups"] = ("id", self.one(
            "INSERT INTO public.backups (stamp, origin, location) "
            "VALUES (%s, 'scheduled', 'volume://entities') RETURNING id::text;",
            (f"0330{uuid.uuid4().int % 10000:04d}T000000Z",)))
        identity = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (identity,))
        self.cur.execute("INSERT INTO public.machine_principals (principal_id, name, purpose) VALUES (%s, %s, 'Reads the plant');",
                         (identity, f"Bridge {self.tag}"))
        self.planted["machine_principals"] = ("principal_id", identity)

    def test_each_read_asks_in_an_initplan_and_not_for_each_row(self):
        for table, (asked, _) in ASKED.items():
            with self.subTest(table=table):
                rows = self.read_as(ROLES["Administrator"], f"EXPLAIN (VERBOSE, COSTS OFF) SELECT * FROM public.{table};")
                plan = [line.strip() for (line,) in rows]
                self.assertTrue(any(line.startswith("InitPlan") for line in plan), plan)
                per_row = [line for line in plan if line.startswith(("Filter:", "Index Cond:")) and asked in line]
                self.assertEqual(per_row, [], plan)

    def test_each_admits_the_roles_it_did(self):
        for table, (_, admitted) in ASKED.items():
            column, row_id = self.planted[table]
            for name, caller in [*ROLES.items(), ("no role", NOBODY)]:
                with self.subTest(table=table, caller=name):
                    rows = self.read_as(caller, f"SELECT 1 FROM public.{table} WHERE {column} = %s;", (row_id,))
                    self.assertEqual(len(rows) == 1, name in admitted)

    def test_a_machine_that_may_manage_the_archive_reads_the_tombstones(self):
        machine = self.planted["machine_principals"][1]
        column, row_id = self.planted["retired_entities"]
        read = f"SELECT 1 FROM public.retired_entities WHERE {column} = %s;"
        self.assertEqual(self.read_as(machine, read, (row_id,)), [])
        self.cur.execute(
            "INSERT INTO public.principal_permissions (principal_id, permission_id) "
            "SELECT %s, id FROM public.permissions WHERE name = 'archive:manage';", (machine,))
        self.assertEqual(len(self.read_as(machine, read, (row_id,))), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
