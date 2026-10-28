"""
A person can put a picture on their own account, and nobody else sees it (0213).

    python supabase/migrations/test_a_person_can_put_a_picture_on_their_account.py

Run against the migrated Supabase Postgres -- `npm run test:db` gives it a throwaway one. The db
lane has no storage-api, so the bucket's own checks (the type it admits, its size limit) and the
Storage API are test_account_pictures_stack.py's, in the stack lane.

Held here:

  * person_profiles.avatar_path is set and cleared by its owner alone, through set_own_picture(),
    which takes no id; it names only <their id>/avatar; every person role sets their own, and a
    machine identity, a removed person and anon are refused;
  * an Administrator's set_display_name() for someone else never touches it, and clearing the name
    of a person with a picture keeps the row;
  * a row made or cleared for a picture writes no rename row, and display_names_for() leaves a row
    with no name out, so nobody learns of a picture;
  * forget_person_picture() is service_role's alone, for a person whose access is removed;
  * the avatars policies, verbatim on a stand-in table: the owner reads, writes, replaces and
    deletes their own <id>/avatar and nothing else; another person, an Administrator, a machine
    identity, a removed person and anon reach nothing; and the file's self-check refuses a wider
    arm, a missing policy and a policy of another bucket that is not confined to it.

Every test rolls back.
"""
import os
import unittest

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STORAGE_POLICIES = os.path.join(REPO, "supabase", "storage-policies.sql")

PEOPLE = {
    "Administrator": "00000000-0000-4000-8000-0000000a1024",
    "Shopfloor_Manager": "00000000-0000-4000-8000-0000000b1024",
    "Auditor": "00000000-0000-4000-8000-0000000c1024",
    "Operator": "00000000-0000-4000-8000-0000000d1024",
    "Other": "00000000-0000-4000-8000-0000000e1024",
}
ROLE_OF = {"Other": "Operator"}
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"

OWNER = PEOPLE["Operator"]
PICTURE = f"{OWNER}/avatar"

# Not the bucket's schema: the policies' stand-in, which dies with the transaction.
PROBE = "avatars_probe"


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """The people as the owner, each call as a caller, and a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = connect()
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regprocedure('public.set_own_picture(boolean)');")
            applied = cur.fetchone()[0]
        finally:
            conn.rollback()
            conn.close()
        if not applied:
            raise unittest.SkipTest("0213 has not been applied")

    def setUp(self):
        self.conn = connect()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for name, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"picture-{name.lower()}-{user_id[-6:]}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, ROLE_OF.get(name, name)),
            )

    # -- callers ------------------------------------------------------------------------------

    def _as(self, caller):
        if caller == "anon":
            self.cur.execute("SET LOCAL ROLE anon;")
            claims = '{"role": "anon"}'
        elif caller == "service_role":
            self.cur.execute("SET LOCAL ROLE service_role;")
            claims = '{"role": "service_role"}'
        else:
            sub = {"ingestion": INGESTION, "playback": PLAYBACK}.get(caller) or PEOPLE[caller]
            self.cur.execute("SET LOCAL ROLE authenticated;")
            claims = '{"sub": "%s", "role": "authenticated"}' % sub
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))

    def _run(self, caller, sql, args=()):
        """One statement as `caller`, kept on success; a refusal leaves the fixture standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self._as(caller)
            self.cur.execute(sql, args)
            result = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        except Exception:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT call;")
        return result

    def set_picture(self, caller, present=True):
        return self._run(caller, "SELECT public.set_own_picture(%s);", (present,))[0][0]

    def set_name(self, caller, person, name):
        return self._run(caller, "SELECT public.set_display_name(%s, %s);", (PEOPLE[person], name))[0][0]

    def row(self, person="Operator"):
        self.cur.execute("SELECT display_name, avatar_path FROM public.person_profiles WHERE user_id = %s;",
                         (PEOPLE[person],))
        return self.cur.fetchone()

    def renames(self, person="Operator"):
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'user_roles' "
                         "AND entity_id = %s AND action = 'DISPLAY_NAME_CHANGED';", (PEOPLE[person],))
        return self.cur.fetchone()[0]

    def remove_access(self, person="Operator"):
        """What remove_person_access() leaves: no role, and the role kept to give back."""
        user_id = PEOPLE[person]
        self.cur.execute("INSERT INTO public.access_removals (user_id, role_id) SELECT user_id::uuid, role_id "
                         "FROM public.user_roles WHERE user_id = %s ON CONFLICT DO NOTHING;", (user_id,))
        self.cur.execute("DELETE FROM public.user_roles WHERE user_id = %s;", (user_id,))


class AnOwnerSetsTheirOwn(Base):

    def test_a_person_sets_and_clears_their_own_picture(self):
        self.assertEqual(self.set_picture("Operator"), PICTURE)
        self.assertEqual(self.row(), (None, PICTURE), "a picture alone is a row with no name")
        self.assertIsNone(self.set_picture("Operator", False))
        self.assertIsNone(self.row(), "no name and no picture is no row")

    def test_clearing_the_picture_keeps_the_name(self):
        self.set_name("Operator", "Operator", "Owain Operator")
        self.set_picture("Operator")
        self.assertEqual(self.row(), ("Owain Operator", PICTURE))
        self.set_picture("Operator", False)
        self.assertEqual(self.row(), ("Owain Operator", None))

    def test_setting_it_twice_and_clearing_nothing_change_nothing_more(self):
        self.set_picture("Operator")
        self.assertEqual(self.set_picture("Operator"), PICTURE)
        self.assertEqual(self.row(), (None, PICTURE))
        self.set_picture("Operator", False)
        self.assertIsNone(self.set_picture("Operator", None), "NULL clears, as for a name")
        self.assertIsNone(self.row())

    def test_every_person_role_sets_their_own_auditor_included(self):
        for role in ("Administrator", "Shopfloor_Manager", "Auditor", "Operator"):
            with self.subTest(role=role):
                self.assertEqual(self.set_picture(role), f"{PEOPLE[role]}/avatar")
                self.assertEqual(self.row(role), (None, f"{PEOPLE[role]}/avatar"))

    def test_a_machine_identity_a_removed_person_and_anon_are_refused(self):
        for caller in ("ingestion", "playback", "anon"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self.set_picture(caller)
        self.remove_access("Operator")
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.set_picture("Operator")
        self.assertIsNone(self.row())

    def test_the_column_names_only_its_owner_s_object(self):
        for path in (f"{PEOPLE['Other']}/avatar", f"{OWNER}/avatar.png", f"{OWNER}/other", "avatar"):
            with self.subTest(path=path):
                self.cur.execute("SAVEPOINT bad;")
                with self.assertRaises(pg_errors.CheckViolation):
                    self.cur.execute("INSERT INTO public.person_profiles (user_id, avatar_path) VALUES (%s, %s);",
                                     (OWNER, path))
                self.cur.execute("ROLLBACK TO SAVEPOINT bad;")

    def test_a_row_holds_a_name_or_a_picture(self):
        with self.assertRaises(pg_errors.CheckViolation):
            self.cur.execute("INSERT INTO public.person_profiles (user_id) VALUES (%s);", (OWNER,))

    def test_nobody_writes_the_row_around_the_functions(self):
        self.set_picture("Operator")
        for sql in ("UPDATE public.person_profiles SET avatar_path = NULL WHERE user_id = %s;",
                    "DELETE FROM public.person_profiles WHERE user_id = %s;"):
            with self.subTest(sql=sql):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._run("Operator", sql, (OWNER,))
        self.assertEqual(self.row(), (None, PICTURE))

    def test_another_person_reads_nothing_of_it(self):
        self.set_picture("Operator")
        for caller in ("Other", "Administrator", "Auditor"):
            with self.subTest(caller=caller):
                rows = self._run(caller, "SELECT avatar_path FROM public.person_profiles WHERE user_id = %s;",
                                 (OWNER,))
                self.assertEqual(rows, [])
        self.assertEqual(self._run("Operator", "SELECT avatar_path FROM public.person_profiles WHERE user_id = %s;",
                                   (OWNER,)), [(PICTURE,)])


class AnAdministratorCannotTouchIt(Base):

    def setUp(self):
        super().setUp()
        self.set_picture("Operator")

    def test_naming_another_person_keeps_their_picture(self):
        self.assertEqual(self.set_name("Administrator", "Operator", "Owain Operator"), "Owain Operator")
        self.assertEqual(self.row(), ("Owain Operator", PICTURE))

    def test_clearing_another_person_s_name_keeps_the_row_while_it_holds_a_picture(self):
        self.set_name("Administrator", "Operator", "Owain Operator")
        self.assertIsNone(self.set_name("Administrator", "Operator", ""))
        self.assertEqual(self.row(), (None, PICTURE))
        self.assertIsNone(self.set_name("Administrator", "Operator", None))
        self.assertEqual(self.row(), (None, PICTURE), "clearing no name deleted the picture")

    def test_clearing_a_name_with_no_picture_still_deletes_the_row(self):
        self.set_name("Administrator", "Other", "Olwen Other")
        self.set_name("Administrator", "Other", "")
        self.assertIsNone(self.row("Other"))

    def test_set_own_picture_acts_on_the_caller_alone(self):
        self.set_picture("Administrator", False)
        self.assertEqual(self.row(), (None, PICTURE), "an Administrator cleared another person's picture")
        self.set_picture("Administrator")
        self.assertEqual(self.row("Administrator"), (None, f"{PEOPLE['Administrator']}/avatar"))
        self.assertEqual(self.row(), (None, PICTURE))

    def test_forgetting_a_picture_is_service_role_s_and_only_once_access_is_removed(self):
        for caller in ("Administrator", "Operator", "anon"):
            with self.subTest(caller=caller):
                with self.assertRaises(pg_errors.InsufficientPrivilege):
                    self._run(caller, "SELECT public.forget_person_picture(%s);", (OWNER,))
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self._run("service_role", "SELECT public.forget_person_picture(%s);", (OWNER,))
        self.assertEqual(self.row(), (None, PICTURE))

        self.remove_access("Operator")
        self._run("service_role", "SELECT public.forget_person_picture(%s);", (OWNER,))
        self.assertIsNone(self.row(), "a row with no name stays after its picture is forgotten")
        self._run("service_role", "SELECT public.forget_person_picture(%s);", (OWNER,))

    def test_forgetting_a_picture_keeps_the_name(self):
        self.set_name("Operator", "Operator", "Owain Operator")
        self.remove_access("Operator")
        self._run("service_role", "SELECT public.forget_person_picture(%s);", (OWNER,))
        self.assertEqual(self.row(), ("Owain Operator", None))


class NobodyElseLearnsOfIt(Base):

    def test_a_picture_writes_no_rename_row(self):
        self.set_picture("Operator")
        self.set_picture("Operator", False)
        self.set_picture("Operator")
        self.remove_access("Operator")
        self._run("service_role", "SELECT public.forget_person_picture(%s);", (OWNER,))
        self.assertEqual(self.renames(), 0)

    def test_a_name_beside_a_picture_writes_one_rename_row_each_way(self):
        self.set_picture("Operator")
        self.set_name("Operator", "Operator", "Owain Operator")
        self.set_name("Administrator", "Operator", "")
        self.cur.execute("SELECT old_data, new_data, changed_by FROM public.audit_trail WHERE entity_type = 'user_roles' "
                         "AND entity_id = %s AND action = 'DISPLAY_NAME_CHANGED' ORDER BY recorded_at, id;", (OWNER,))
        rows = self.cur.fetchall()
        self.assertEqual([(r[0], r[1]) for r in rows], [
            ({"display_name": None}, {"display_name": "Owain Operator"}),
            ({"display_name": "Owain Operator"}, {"display_name": None}),
        ])
        self.assertEqual(str(rows[1][2]), PEOPLE["Administrator"])

    def test_display_names_for_leaves_out_a_row_with_no_name(self):
        self.set_picture("Operator")
        answered = self._run("Operator", "SELECT * FROM public.display_names_for(%s::uuid[]);", ([OWNER],))
        self.assertEqual(answered, [], "the answer tells the caller a picture exists")
        self.set_name("Operator", "Operator", "Owain Operator")
        answered = self._run("Operator", "SELECT user_id::text, display_name FROM public.display_names_for(%s::uuid[]);",
                             ([OWNER],))
        self.assertEqual(answered, [(OWNER, "Owain Operator")])

    def test_the_people_lists_carry_no_picture(self):
        self.set_picture("Operator")
        for fn, read in (("public.list_people()", "SELECT display_name FROM public.list_people() WHERE user_id = %s;"),
                         ("public.list_user_accounts()",
                          "SELECT display_name FROM public.list_user_accounts() WHERE user_id = %s;")):
            with self.subTest(fn=fn):
                self.cur.execute("SELECT pg_get_function_result(%s::regprocedure);", (fn,))
                self.assertNotIn("avatar", self.cur.fetchone()[0])
                self.assertEqual(self._run("Administrator", read, (OWNER,)), [(None,)])


class TheBucketPolicies(Base):
    """The avatars policies from storage-policies.sql, verbatim, on a stand-in table."""

    DELETE_POLICY = ('DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;\n'
                     'CREATE POLICY "avatars_delete_own" ON storage.objects\n'
                     '  FOR DELETE TO authenticated\n'
                     "  USING (bucket_id = 'avatars' AND public.is_own_avatar_object(storage.objects.name));\n")
    SELECT_ARM = ("  FOR SELECT TO authenticated\n"
                  "  USING (bucket_id = 'avatars' AND public.is_own_avatar_object(storage.objects.name));")

    def _section(self, edit=lambda text: text):
        """The bucket's policies and the DO block that checks them, pointed at the stand-in."""
        with open(STORAGE_POLICIES, encoding="utf-8") as f:
            text = edit(f.read())
        block = text[text.index("-- avatars:"):]
        block = (block.replace("storage.objects", PROBE + ".objects")
                      .replace("schemaname = 'storage'", f"schemaname = '{PROBE}'"))
        self.assertNotIn("storage.", block)
        self.assertNotIn("'storage'", block)
        return block

    def setUp(self):
        super().setUp()
        self.cur.execute("CREATE SCHEMA avatars_probe;")
        self.cur.execute("CREATE TABLE avatars_probe.objects (bucket_id text NOT NULL, name text NOT NULL, metadata jsonb);")
        self.cur.execute("ALTER TABLE avatars_probe.objects ENABLE ROW LEVEL SECURITY;")
        # The grants storage-policies.sql gives storage.objects.
        self.cur.execute("GRANT USAGE ON SCHEMA avatars_probe TO anon, authenticated;")
        self.cur.execute("GRANT SELECT ON avatars_probe.objects TO anon;")
        self.cur.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON avatars_probe.objects TO authenticated;")
        self.cur.execute(self._section())
        self.cur.execute("INSERT INTO avatars_probe.objects (bucket_id, name) VALUES ('avatars', %s);", (PICTURE,))

    def _sees(self, caller, name=PICTURE):
        return self._run(caller, "SELECT count(*) FROM avatars_probe.objects WHERE bucket_id = 'avatars' "
                                 "AND name = %s;", (name,))[0][0] == 1

    def _writes(self, caller, name, bucket="avatars"):
        self.cur.execute("SAVEPOINT w;")
        try:
            self._run(caller, "INSERT INTO avatars_probe.objects (bucket_id, name) VALUES (%s, %s);", (bucket, name))
            return True
        except pg_errors.InsufficientPrivilege:
            return False
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT w;")

    def _updates(self, caller, name=PICTURE):
        self.cur.execute("SAVEPOINT u;")
        try:
            return self._run(caller, "UPDATE avatars_probe.objects SET metadata = '{}' WHERE bucket_id = 'avatars' "
                                     "AND name = %s;", (name,)) == 1
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT u;")

    def _deletes(self, caller, name=PICTURE):
        self.cur.execute("SAVEPOINT d;")
        try:
            return self._run(caller, "DELETE FROM avatars_probe.objects WHERE bucket_id = 'avatars' AND name = %s;",
                             (name,)) == 1
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT d;")

    def test_the_owner_reads_writes_replaces_and_deletes_their_own_picture(self):
        self.assertTrue(self._sees("Operator"))
        self.assertTrue(self._updates("Operator"), "an upsert of the picture would be refused")
        self.assertTrue(self._deletes("Operator"))
        self._run("Operator", "DELETE FROM avatars_probe.objects WHERE name = %s;", (PICTURE,))
        self.assertTrue(self._writes("Operator", PICTURE))

    def test_every_person_role_reaches_their_own(self):
        for role in ("Administrator", "Shopfloor_Manager", "Auditor", "Operator"):
            with self.subTest(role=role):
                self.assertTrue(self._writes(role, f"{PEOPLE[role]}/avatar"))

    def test_nobody_else_reaches_it(self):
        for caller in ("Other", "Administrator", "Shopfloor_Manager", "Auditor", "ingestion", "playback"):
            with self.subTest(caller=caller):
                self.assertFalse(self._sees(caller), f"{caller} reads another person's picture")
                self.assertFalse(self._updates(caller), f"{caller} replaces another person's picture")
                self.assertFalse(self._deletes(caller), f"{caller} deletes another person's picture")
                self.assertFalse(self._writes(caller, PICTURE), f"{caller} writes at another person's path")
        self.assertFalse(self._sees("anon"))

    def test_only_the_fixed_name_under_their_own_folder(self):
        for name in (f"{OWNER}/avatar.png", f"{OWNER}/other", f"{OWNER}/avatar/x", f"x/{OWNER}/avatar",
                     f"{OWNER}avatar", "avatar", f"{PEOPLE['Other']}/avatar"):
            with self.subTest(name=name):
                self.assertFalse(self._writes("Operator", name))
        self.assertFalse(self._writes("Operator", PICTURE, bucket="area-plans"),
                         "the avatars policies admitted a write to another bucket")

    def test_a_removed_person_reaches_nothing_even_their_own(self):
        self.remove_access("Operator")
        self.assertFalse(self._sees("Operator"))
        self.assertFalse(self._deletes("Operator"))
        self.assertFalse(self._writes("Operator", PICTURE))

    def test_the_files_own_self_check_passes_on_what_it_states_twice(self):
        """An arm the self-check misreads would fail the storage-policies Job on every boot."""
        self.cur.execute(self._section())
        self.cur.execute(self._section())

    def test_the_self_check_refuses_an_administrator_arm(self):
        def widen(text):
            self.assertIn(self.SELECT_ARM, text, "the SELECT policy moved; update SELECT_ARM")
            return text.replace(self.SELECT_ARM, self.SELECT_ARM[:-2]
                                + " OR public.has_role(ARRAY['Administrator']));")
        with self.assertRaisesRegex(pg_errors.RaiseException, "other than the picture's owner"):
            self.cur.execute(self._section(widen))

    def test_the_self_check_refuses_a_missing_policy(self):
        def drop(text):
            self.assertIn(self.DELETE_POLICY, text, "the DELETE policy moved; update DELETE_POLICY")
            return text.replace(self.DELETE_POLICY, 'DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;\n')
        with self.assertRaisesRegex(pg_errors.RaiseException, "avatars_delete_own is missing"):
            self.cur.execute(self._section(drop))

    def test_the_self_check_refuses_an_avatars_policy_it_does_not_make(self):
        self.cur.execute("CREATE POLICY avatars_select_shared ON avatars_probe.objects FOR SELECT TO authenticated "
                         "USING (bucket_id = 'avatars');")
        with self.assertRaisesRegex(pg_errors.RaiseException, "avatars_select_shared"):
            self.cur.execute(self._section())

    def test_the_self_check_reads_another_bucket_s_policy_confined_by_its_first_test(self):
        head = "CREATE POLICY confined ON avatars_probe.objects FOR SELECT TO authenticated USING "
        for using in (head + "(bucket_id = 'area-plans');",
                      head + "(bucket_id = 'area-plans' AND public.has_role(ARRAY['Administrator']));",
                      head + "(bucket_id = 'area-plans' AND (public.has_role(ARRAY['Administrator']) OR true));"):
            with self.subTest(using=using):
                self.cur.execute("SAVEPOINT c;")
                self.cur.execute(using)
                self.cur.execute(self._section())
                self.cur.execute("ROLLBACK TO SAVEPOINT c;")

    def test_the_self_check_refuses_another_policy_that_could_admit_somebody_to_a_picture(self):
        on = " ON avatars_probe.objects "
        for name, ddl in (
            ("everything", "CREATE POLICY everything" + on + "FOR SELECT TO authenticated USING (true);"),
            ("either", "CREATE POLICY either" + on + "FOR SELECT TO authenticated "
                       "USING (bucket_id = 'area-plans' OR public.has_role(ARRAY['Administrator']));"),
            ("arm_or", "CREATE POLICY arm_or" + on + "FOR SELECT TO authenticated "
                       "USING ((bucket_id = 'area-plans' AND true) OR bucket_id = 'avatars');"),
            ("named", "CREATE POLICY named" + on + "FOR DELETE TO authenticated USING (bucket_id = 'avatars');"),
            ("no_using", "CREATE POLICY no_using" + on + "FOR UPDATE TO authenticated WITH CHECK (bucket_id = 'area-plans');"),
            ("second", "CREATE POLICY second" + on + "FOR SELECT TO anon "
                       "USING (public.has_role(ARRAY['Auditor']) AND bucket_id = 'area-plans');"),
        ):
            with self.subTest(policy=name):
                self.cur.execute("SAVEPOINT c;")
                self.cur.execute(ddl)
                with self.assertRaisesRegex(pg_errors.RaiseException, f"{name}.*is not confined"):
                    self.cur.execute(self._section())
                self.cur.execute("ROLLBACK TO SAVEPOINT c;")


if __name__ == "__main__":
    unittest.main(verbosity=2)
