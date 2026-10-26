"""
A nameplate names the person the server signed in, at the time the server wrote it (0210).

    python supabase/migrations/test_a_nameplate_names_the_person_the_server_signed_in.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: device_nameplate_stamp() sets updated_by to the caller and updated_at to the
database's time on every insert, update and upsert, whatever the request names. A Shopfloor
Manager's and an Administrator's writes that name another person and a past time are stored as the
caller's, now. A write with no person behind it (the owner's session, service_role) stores NULL.
The audit row carries the stamped values. The trigger is BEFORE INSERT OR UPDATE FOR EACH ROW, its
function runs as its caller with a pinned search_path, and no API role may execute it.

EVERY TEST ROLLS BACK.
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

MANAGER = "a0d17070-0000-4000-8000-0000000210a1"
ADMIN = "a0d17070-0000-4000-8000-0000000210a2"
OTHER = "a0d17070-0000-4000-8000-0000000210a3"
CELL = "a0d17070-0000-4000-8000-0000000210c1"
# Differs from every other fixture in its first 21 hex characters, which become its sparkplug_id.
DEVICE = "d2100153-0000-4000-8000-0000000210d1"

PAST = "2001-01-01T00:00:00+00:00"

INSERT_NAMING = (
    "INSERT INTO public.device_nameplate (device_id, serial_number, updated_by, updated_at)"
    " VALUES (%s, %s, %s, %s)"
)
UPDATE_NAMING = (
    "UPDATE public.device_nameplate SET serial_number = %s, updated_by = %s, updated_at = %s"
    " WHERE device_id = %s"
)
# PostgREST's upsert with `Prefer: resolution=merge-duplicates`, naming the two columns.
UPSERT_NAMING = (
    "INSERT INTO public.device_nameplate (device_id, serial_number, updated_by, updated_at)"
    " VALUES (%s, %s, %s, %s) ON CONFLICT (device_id) DO UPDATE"
    " SET serial_number = EXCLUDED.serial_number, updated_by = EXCLUDED.updated_by,"
    " updated_at = EXCLUDED.updated_at"
)
# The dashboard's save: the fields alone.
UPSERT_FIELDS = (
    "INSERT INTO public.device_nameplate (device_id, serial_number) VALUES (%s, %s)"
    " ON CONFLICT (device_id) DO UPDATE SET serial_number = EXCLUDED.serial_number"
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class TheDatabaseStampsTheNameplate(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.device_nameplate_stamp()');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0210 is not applied to this database")
        for user_id in (MANAGER, ADMIN, OTHER):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@nameplate-stamp.test"),
            )
        for user_id, role in ((MANAGER, "Shopfloor_Manager"), (ADMIN, "Administrator")):
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id)"
                " SELECT %s, id FROM public.roles WHERE name = %s;",
                (user_id, role),
            )
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, 'Nameplate Stamp Cell 0210');",
                         (CELL,))
        self.cur.execute("INSERT INTO public.devices (id, name, cell_id) VALUES (%s, 'Nameplate_Stamp_0210', %s);",
                         (DEVICE, CELL))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def write(self, statement, params, user=None, role="authenticated"):
        """Run one write as PostgREST would for a token naming `user`, or as the owner's session
        when `role` is None. Returns the rows it touched."""
        if role is not None:
            claims = {"role": role} if user is None else {"sub": user, "role": role}
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
        self.cur.execute(statement, params)
        touched = self.cur.rowcount
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        return touched

    def stamp(self):
        """(updated_by, whether updated_at is this transaction's now()) of the fixture's nameplate."""
        self.cur.execute(
            "SELECT updated_by::text, updated_at = now() FROM public.device_nameplate WHERE device_id = %s;",
            (DEVICE,),
        )
        return self.cur.fetchone()

    def high_water(self):
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        return self.cur.fetchone()[0]

    # -- a Shopfloor Manager ----------------------------------------------------------------------

    def test_a_managers_insert_names_the_manager_at_the_servers_time(self):
        self.assertEqual(self.write(INSERT_NAMING, (DEVICE, "SN-1", OTHER, PAST), MANAGER), 1)
        self.assertEqual(self.stamp(), (MANAGER, True))

    def test_a_managers_update_names_the_manager_at_the_servers_time(self):
        self.write(INSERT_NAMING, (DEVICE, "SN-1", None, None), ADMIN)
        self.assertEqual(self.write(UPDATE_NAMING, ("SN-2", ADMIN, PAST, DEVICE), MANAGER), 1)
        self.assertEqual(self.stamp(), (MANAGER, True))

    def test_a_managers_upsert_names_the_manager_at_the_servers_time(self):
        self.write(INSERT_NAMING, (DEVICE, "SN-1", None, None), ADMIN)
        self.assertEqual(self.write(UPSERT_NAMING, (DEVICE, "SN-2", OTHER, PAST), MANAGER), 1)
        self.assertEqual(self.stamp(), (MANAGER, True))

    def test_the_dashboards_save_names_whoever_saved_it(self):
        # The dashboard sends the fields alone; the stamp fills in both columns on insert and update.
        self.write(UPSERT_FIELDS, (DEVICE, "SN-1"), ADMIN)
        self.assertEqual(self.stamp(), (ADMIN, True))
        self.write(UPSERT_FIELDS, (DEVICE, "SN-2"), MANAGER)
        self.assertEqual(self.stamp(), (MANAGER, True))

    # -- an Administrator -------------------------------------------------------------------------

    def test_an_administrators_insert_and_update_are_stamped_too(self):
        self.write(INSERT_NAMING, (DEVICE, "SN-1", OTHER, PAST), ADMIN)
        self.assertEqual(self.stamp(), (ADMIN, True))
        self.write(UPDATE_NAMING, ("SN-2", MANAGER, PAST, DEVICE), ADMIN)
        self.assertEqual(self.stamp(), (ADMIN, True))

    # -- no person behind the write ---------------------------------------------------------------

    def test_the_owners_session_records_nobody(self):
        self.write(INSERT_NAMING, (DEVICE, "SN-1", OTHER, PAST), role=None)
        self.assertEqual(self.stamp(), (None, True))
        self.write(UPDATE_NAMING, ("SN-2", MANAGER, PAST, DEVICE), role=None)
        self.assertEqual(self.stamp(), (None, True))

    def test_service_role_records_nobody(self):
        self.write(INSERT_NAMING, (DEVICE, "SN-1", OTHER, PAST), role="service_role")
        self.assertEqual(self.stamp(), (None, True))
        self.write(UPDATE_NAMING, ("SN-2", MANAGER, PAST, DEVICE), role="service_role")
        self.assertEqual(self.stamp(), (None, True))

    # -- the Audit Trail --------------------------------------------------------------------------

    def test_the_audit_rows_carry_the_stamp(self):
        mark = self.high_water()
        self.write(INSERT_NAMING, (DEVICE, "SN-1", OTHER, PAST), MANAGER)
        self.write(UPDATE_NAMING, ("SN-2", OTHER, PAST, DEVICE), MANAGER)
        self.cur.execute(
            "SELECT action, changed_by::text, old_data ->> 'updated_by', new_data ->> 'updated_by',"
            "       (new_data ->> 'updated_at')::timestamptz = now()"
            "  FROM public.audit_trail"
            " WHERE id > %s AND entity_type = 'device_nameplate' AND entity_id = %s ORDER BY id;",
            (mark, DEVICE),
        )
        self.assertEqual(self.cur.fetchall(), [
            ("INSERT", MANAGER, None, MANAGER, True),
            ("UPDATE", MANAGER, MANAGER, MANAGER, True),
        ])

    # -- the trigger itself -----------------------------------------------------------------------

    def test_the_trigger_is_before_insert_or_update_for_each_row_and_enabled(self):
        self.cur.execute(
            "SELECT tgtype & 23, tgenabled FROM pg_trigger"
            " WHERE tgrelid = 'public.device_nameplate'::regclass AND tgname = 'device_nameplate_stamp'"
            "   AND tgfoid = 'public.device_nameplate_stamp()'::regprocedure;"
        )
        # ROW (1), BEFORE (2), INSERT (4), UPDATE (16); 'O' fires in the ordinary session mode.
        self.assertEqual(self.cur.fetchall(), [(23, "O")])

    def test_its_function_runs_as_its_caller_with_a_pinned_search_path(self):
        self.cur.execute(
            "SELECT prosecdef, proconfig, pg_get_userbyid(proowner) FROM pg_proc"
            " WHERE oid = 'public.device_nameplate_stamp()'::regprocedure;"
        )
        definer, config, owner = self.cur.fetchone()
        self.assertFalse(definer)
        self.assertIn("search_path=public, pg_catalog", config)
        self.assertEqual(owner, "postgres")

    def test_no_api_role_may_execute_it(self):
        for role in ("anon", "authenticated", "service_role"):
            with self.subTest(role=role):
                self.cur.execute(
                    "SELECT has_function_privilege(%s, 'public.device_nameplate_stamp()', 'EXECUTE');",
                    (role,),
                )
                self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main()
