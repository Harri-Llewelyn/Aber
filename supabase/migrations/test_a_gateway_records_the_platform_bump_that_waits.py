# suite:
#   lanes: db
#   why: The platform bump that waits for approval is on its gateway's row (0327), for the drawer. A write
#     of it alone is no event, as a heartbeat's readings are not: the forge holds the proposal, and a sweep
#     of a fleet would add a row for each gateway to an append-only trail. A change of anything else with
#     it still is one. gateway_status carries it, every signed-in role reads it, and a role that cannot
#     write a gateway cannot write it.

"""
PostgreSQL integration tests for `0327_a_gateway_records_the_platform_bump_that_waits.sql`.

Every test runs inside one transaction and rolls back, which is what makes this safe against a live
database: `audit_trail` is append-only to every application role.

    python supabase/migrations/test_a_gateway_records_the_platform_bump_that_waits.py
"""
import json
import os
import unittest

import psycopg2

DB = dict(
    host=os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost")),
    port=os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322")),
    dbname=os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres")),
    user=os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres")),
    password=os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres")),
)

TAG = "v1.10.0"


class TheBumpThatWaits(unittest.TestCase):
    def setUp(self):
        self.conn = psycopg2.connect(**DB)
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        # A gateway of this test's own. Its INSERT writes an audit row, which the counts leave out by action.
        self.cur.execute(
            "INSERT INTO public.gateways (name, deployment, status) VALUES ('Bump_Waits_Probe', 'remote', 'ONLINE') RETURNING id")
        self.gateway_id = self.cur.fetchone()[0]

    def write(self, tag, number):
        self.cur.execute("UPDATE public.gateways SET forge_bump_tag = %s, forge_bump_number = %s WHERE id = %s",
                         (tag, number, self.gateway_id))

    def updates(self):
        self.cur.execute("SELECT new_data FROM public.audit_trail WHERE entity_type = 'gateways' AND entity_id = %s "
                         "AND action = 'UPDATE' ORDER BY recorded_at, id", (self.gateway_id,))
        return [row[0] for row in self.cur.fetchall()]

    def a_person(self, role):
        """A signed-in person holding a role, as PostgREST runs their request. Rolled back with the rest."""
        self.cur.execute(
            "INSERT INTO auth.users (instance_id, id, aud, role, email) VALUES ('00000000-0000-0000-0000-000000000000', "
            "gen_random_uuid(), 'authenticated', 'authenticated', 'bump-waits-' || gen_random_uuid() || '@aber.invalid') RETURNING id")
        person = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles WHERE name = %s", (person, role))
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true)",
                         (json.dumps({"sub": str(person), "role": "authenticated", "aal": "aal2"}),))
        self.cur.execute("SET LOCAL ROLE authenticated")

    def owner(self):
        self.cur.execute("RESET ROLE")
        self.cur.execute('RESET "request.jwt.claims"')

    def test_a_write_of_it_alone_is_no_event(self):
        self.write(TAG, 7)
        self.write("v1.11.0", 9)
        self.write(None, None)
        self.assertEqual(self.updates(), [], "the record of a proposal the forge holds was an audit event")

    def test_a_change_of_anything_else_with_it_is_one_event_and_names_it(self):
        self.cur.execute("UPDATE public.gateways SET forge_bump_tag = %s, forge_bump_number = 7, description = 'Moved' WHERE id = %s",
                         (TAG, self.gateway_id))
        (row,) = self.updates()
        self.assertEqual((row["description"], row["forge_bump_tag"], row["forge_bump_number"]), ("Moved", TAG, 7))

    def test_the_other_columns_the_forge_writes_are_still_events(self):
        self.cur.execute("UPDATE public.gateways SET forge_repository_at = now() WHERE id = %s", (self.gateway_id,))
        self.cur.execute("UPDATE public.gateways SET forge_head_sha = %s WHERE id = %s", ("a" * 40, self.gateway_id))
        self.assertEqual(len(self.updates()), 2)

    def test_every_signed_in_role_reads_it_where_the_dashboard_does(self):
        self.write(TAG, 7)
        for role in ("Administrator", "Shopfloor_Manager", "Operator", "Auditor"):
            with self.subTest(role=role):
                self.a_person(role)
                self.cur.execute("SELECT forge_bump_tag, forge_bump_number FROM public.gateway_status WHERE id = %s", (self.gateway_id,))
                self.assertEqual(self.cur.fetchone(), (TAG, 7))
                self.owner()

    def test_a_role_that_cannot_write_a_gateway_cannot_write_it(self):
        self.a_person("Operator")
        self.write(TAG, 7)
        self.assertEqual(self.cur.rowcount, 0)

    def test_the_view_still_answers_nobody_without_a_session(self):
        self.cur.execute("SELECT has_table_privilege('anon', 'public.gateway_status', 'SELECT'), "
                         "has_table_privilege('authenticated', 'public.gateway_status', 'SELECT')")
        self.assertEqual(self.cur.fetchone(), (False, True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
