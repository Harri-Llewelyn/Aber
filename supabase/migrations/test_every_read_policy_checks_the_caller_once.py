# suite:
#   lanes: db
#   why: 0338 -- the nine read policies 0001 stated with a bare has_role() ask once for a statement and
#     admit whom they did; 0001 creates each only where it is missing, and 0338 states it in full; no read
#     policy in public calls a role check for each row it reads.

"""
Every read policy checks the caller once (0338).

    python supabase/migrations/test_every_read_policy_checks_the_caller_once.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * Each of the nine policies 0338 states is an initplan of its read, and no filter of the read calls
    has_role().
  * Each admits the roles it did: one row of each table, read by each role and by a signed-in account that
    holds none.
  * 0001's call for each names 0338 (p_stated_by), so it creates the per-row form only where the policy is
    missing, and 0338's call puts the sub-select back. A later boot recreates neither.
  * No read policy on a table in public calls has_role() or has_authority() outside a sub-select.

EVERY TEST ROLLS BACK.
"""
import json
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
from psycopg2 import sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ROLES = {
    "Administrator": "a0d17070-0000-4000-8000-0000000338a1",
    "Shopfloor_Manager": "a0d17070-0000-4000-8000-0000000338a2",
    "Operator": "a0d17070-0000-4000-8000-0000000338a3",
    "Auditor": "a0d17070-0000-4000-8000-0000000338a4",
}
# A signed-in account that holds no role.
NOBODY = "a0d17070-0000-4000-8000-0000000338a5"

PRIVILEGED = {"Administrator", "Shopfloor_Manager", "Auditor"}
# Each restated policy's table, its name, and the roles it admits.
ASKED = {
    "asset_exports": ("asset_exports_select_privileged", PRIVILEGED),
    "backup_jobs": ("backup_jobs_select_administrator", {"Administrator"}),
    "capture_jobs": ("capture_jobs_select_privileged", PRIVILEGED),
    "playback_jobs": ("playback_jobs_select_privileged", PRIVILEGED),
    "playback_worker_status": ("playback_worker_status_select_privileged", PRIVILEGED),
    "rebirth_requests": ("rebirth_requests_select_privileged", PRIVILEGED),
    "revoked_service_principals": ("revoked_service_principals_select_privileged", {"Administrator", "Auditor"}),
    "revoked_service_tokens": ("revoked_service_tokens_select_privileged", {"Administrator", "Auditor"}),
    "webhook_endpoints": ("webhook_endpoints_select_privileged", {"Administrator"}),
}

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "0001_baseline_schema.sql"
OWNER = HERE / "0338_every_read_policy_checks_the_caller_once.sql"


def call_for(path, table, name):
    """The file's replay_policy() call for one policy, from SELECT to its closing semicolon."""
    text = path.read_text(encoding="utf-8")
    start = text.index(f"SELECT public.replay_policy('public.{table}', '{name}', $ddl$")
    end = text.index("$ddl$", text.index("\n$ddl$", start) + 1)
    return text[start:text.index(";", end) + 1]


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
        self.tag = uuid.uuid4().hex[:8]
        for role, user_id in ROLES.items():
            self.make_person(user_id, role)
        self.make_person(NOBODY, None)

    def make_person(self, user_id, role):
        self.cur.execute(
            "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
            (user_id, f"policies-0338-{user_id[-2:]}@test.local"),
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

    def live(self, table, name):
        return self.one("SELECT public.live_policy_statement(%s::regclass, %s);", (f"public.{table}", name))

    def policy_oid(self, table, name):
        return self.one("SELECT oid FROM pg_policy WHERE polrelid = %s::regclass AND polname = %s;",
                        (f"public.{table}", name))

    def read_as(self, caller, sql, args=()):
        self.cur.execute("SAVEPOINT policies_read;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": caller, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall()
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT policies_read;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT policies_read;")
        return rows


class TheNineAskOnce(Base):
    def setUp(self):
        super().setUp()
        t = self.tag
        gateway = self.one("INSERT INTO public.gateways (name, deployment) VALUES (%s, 'remote') RETURNING id::text;",
                           (f"Gateway {t}",))
        # A playback publishes only onto a playback gateway.
        target = self.one(
            "INSERT INTO public.gateways (name, location_scope, deployment, is_simulated, is_shadow) "
            "VALUES (%s, 'cell', 'host', true, true) RETURNING id::text;", (f"Playback {t}",))
        identity = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (identity,))
        self.cur.execute("INSERT INTO public.machine_principals (principal_id, name, purpose) "
                         "VALUES (%s, %s, 'Reads the plant');", (identity, f"Bridge {t}"))
        self.planted = {
            "asset_exports": ("id", self.one(
                "INSERT INTO public.asset_exports (entity_id, name, object_bucket, object_key) "
                "VALUES (gen_random_uuid(), %s, 'exports', %s) RETURNING id::text;", (f"Lathe {t}", f"{t}.aasx"))),
            "backup_jobs": ("id", self.one(
                "INSERT INTO public.backup_jobs (origin, note) VALUES ('requested', %s) RETURNING id::text;", (t,))),
            "capture_jobs": ("id", self.one(
                "INSERT INTO public.capture_jobs (subject_kind, gateway_id, sparkplug_group, edge_node_id, "
                "subject_sparkplug_id, storage_path) "
                "VALUES ('gateway', %s, 'Aber', %s, %s, %s) RETURNING id::text;",
                (gateway, f"edge-{t}", f"edge-{t}", f"edge-{t}/{t}.json"))),
            "playback_jobs": ("id", self.one(
                "INSERT INTO public.playback_jobs (capture_storage_path, target_gateway_id, target_edge_node_id, "
                "sparkplug_group) VALUES (%s, %s, %s, 'Aber') RETURNING id::text;",
                (f"edge-{t}/{t}.json", target, f"playback-{t}"))),
            "playback_worker_status": ("id", self.one(
                "INSERT INTO public.playback_worker_status (id) VALUES (true) "
                "ON CONFLICT (id) DO UPDATE SET reported_at = now() RETURNING id;")),
            "rebirth_requests": ("id", self.one(
                "INSERT INTO public.rebirth_requests (gateway_id, edge_node_id, sparkplug_group) "
                "VALUES (%s, %s, 'Aber') RETURNING id::text;", (gateway, f"edge-{t}"))),
            "revoked_service_principals": ("principal_id", self.one(
                "INSERT INTO public.revoked_service_principals (principal_id, reason) "
                "VALUES (%s, 'Retired') RETURNING principal_id::text;", (identity,))),
            "revoked_service_tokens": ("jti", self.one(
                "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at) "
                "VALUES (%s, %s, now() + interval '1 day') RETURNING jti;", (f"jti-{t}", identity))),
            "webhook_endpoints": ("id", self.one(
                "INSERT INTO public.webhook_endpoints (event_key, url) "
                "VALUES (%s, 'http://receiver.test/hook') RETURNING id::text;", (f"event.{t}",))),
        }

    def test_each_read_asks_in_an_initplan_and_not_for_each_row(self):
        for table in ASKED:
            with self.subTest(table=table):
                rows = self.read_as(ROLES["Administrator"], f"EXPLAIN (VERBOSE, COSTS OFF) SELECT * FROM public.{table};")
                plan = [line.strip() for (line,) in rows]
                self.assertTrue(any(line.startswith("InitPlan") for line in plan), plan)
                per_row = [line for line in plan if line.startswith(("Filter:", "Index Cond:")) and "has_role" in line]
                self.assertEqual(per_row, [], plan)

    def test_each_admits_the_roles_it_did(self):
        for table, (_, admitted) in ASKED.items():
            column, row_id = self.planted[table]
            for name, caller in [*ROLES.items(), ("no role", NOBODY)]:
                with self.subTest(table=table, caller=name):
                    rows = self.read_as(caller, f"SELECT 1 FROM public.{table} WHERE {column} = %s;", (row_id,))
                    self.assertEqual(len(rows) == 1, name in admitted)


class WhereEachIsStated(Base):
    def test_0001_creates_each_only_where_it_is_missing(self):
        for table, (name, _) in ASKED.items():
            with self.subTest(table=table):
                self.assertIn(f"p_stated_by => '{OWNER.name}'", call_for(BASELINE, table, name))
                self.assertNotIn("p_stated_by", call_for(OWNER, table, name))

    def test_a_later_boot_recreates_neither(self):
        for table, (name, _) in ASKED.items():
            with self.subTest(table=table):
                stated = self.live(table, name)
                oid = self.policy_oid(table, name)
                self.cur.execute(call_for(BASELINE, table, name))
                self.cur.execute(call_for(OWNER, table, name))
                self.assertEqual((self.live(table, name), self.policy_oid(table, name)), (stated, oid))

    def test_a_fresh_install_meets_the_per_row_form_and_0338_replaces_it(self):
        for table, (name, _) in ASKED.items():
            with self.subTest(table=table):
                self.cur.execute("SAVEPOINT fresh;")
                self.cur.execute(sql.SQL("DROP POLICY {} ON public.{};").format(sql.Identifier(name), sql.Identifier(table)))
                self.cur.execute(call_for(BASELINE, table, name))
                self.assertRegex(self.live(table, name), r"USING \(public\.has_role\(")
                self.cur.execute(call_for(OWNER, table, name))
                self.assertIn("USING (( SELECT public.has_role(", self.live(table, name))
                self.cur.execute("ROLLBACK TO SAVEPOINT fresh;")


class NoReadPolicyAsksForEachRow(Base):
    def test_no_read_policy_in_public_calls_a_role_check_outside_a_sub_select(self):
        self.cur.execute(
            "SELECT c.relname, pol.polname, public.live_policy_statement(c.oid, pol.polname) "
            "  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid "
            " WHERE c.relnamespace = 'public'::regnamespace AND pol.polcmd = 'r' ORDER BY 1, 2;")
        policies = self.cur.fetchall()
        self.assertGreater(len(policies), len(ASKED))
        bare = re.compile(r"(?<!SELECT )public\.has_(?:role|authority)\(")
        per_row = [f"{table} {name}" for table, name, said in policies if bare.search(said)]
        self.assertEqual(per_row, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
