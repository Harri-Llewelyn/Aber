# suite:
#   lanes: db
#   why: 0333. A link is on an area, a cell, a device or a gateway, and any other word is refused. Without it
#     a script could write a link no page shows. A site that already holds such a row still boots: the row is
#     named in the log and left as it is, and the constraint is validated once somebody has put it right.

"""
A link's kind is one of four (0333).

    python supabase/migrations/test_a_links_kind_is_one_of_four.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

  * The four words are accepted from the person the policies admit. Any other is refused to that person, to
    an Administrator, to the service-role key and to the owner, on an INSERT and on an UPDATE.
  * A boot over rows with another word adds the constraint NOT VALID, names each of them in a WARNING, and
    changes no row. A second boot says the same and changes nothing.
  * The first boot that finds no such row validates it, and no later boot reads the table for it.
  * A later file may widen the constraint, and a replay of this one leaves it as that file has it.

Every test rolls back.
"""
import glob
import json
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION = glob.glob(os.path.join(HERE, "0333_*.sql"))[0]

ADMINISTRATOR, MANAGER = "Administrator", "Shopfloor_Manager"
PEOPLE = {
    ADMINISTRATOR: "00000000-0000-4000-8000-00000001a333",
    MANAGER: "00000000-0000-4000-8000-00000001b333",
}
CALLERS = (MANAGER, ADMINISTRATOR, "service_role", None)
KINDS = ("area", "cell", "device", "gateway")
# No kind, a table's name, another case, a blank, and a word with what the log must quote.
OTHERS = ("nonsense", "devices", "Device", "", "it's")

INSERT = ("INSERT INTO public.links (entity_type, entity_id, display_name, url)"
          " VALUES (%s, %s, 'Test 0333', 'https://test.local/') RETURNING id;")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, each call as a caller, a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM pg_constraint WHERE conname = 'links_entity_type_known';")
            if cur.fetchone() is None:
                raise unittest.SkipTest(f"{os.path.basename(MIGRATION)} has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"links-0333-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    def as_caller(self, caller):
        """Become `caller`, as PostgREST does: role, then claims. None is the owner."""
        self.cur.execute("RESET ROLE;")
        claims = ""
        if caller == "service_role":
            self.cur.execute("SET LOCAL ROLE service_role;")
            claims = json.dumps({"role": "service_role"})
        elif caller is not None:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            claims = json.dumps({"sub": PEOPLE[caller], "role": "authenticated", "aal": "aal2"})
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))

    def run_as(self, caller, statement, args=()):
        """One statement as `caller`. A refusal leaves everything before it standing."""
        self.cur.execute("SAVEPOINT call;")
        try:
            self.as_caller(caller)
            self.cur.execute(statement, args)
            return str(self.cur.fetchone()[0]) if self.cur.description else self.cur.rowcount
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT call;")
            raise
        finally:
            self.as_caller(None)

    def constraint(self):
        """The constraint's oid and row version, whether it is validated, and what it says."""
        self.cur.execute(
            "SELECT oid, xmin::text, convalidated, public.live_constraint_definition(conrelid, conname)"
            "  FROM pg_constraint WHERE conname = 'links_entity_type_known'"
            "   AND conrelid = 'public.links'::regclass;")
        return self.cur.fetchone()

    def links(self):
        """Every link whole, with its row version."""
        self.cur.execute("SELECT ctid::text, xmin::text, to_jsonb(l) FROM public.links l ORDER BY id;")
        return self.cur.fetchall()

    def boot(self):
        """0333 as db-init runs it: what it said, one string each."""
        self.conn.notices.clear()
        with open(MIGRATION, encoding="utf-8", newline="") as f:
            self.cur.execute(f.read())
        return [notice.strip() for notice in self.conn.notices]

    def before_0333(self, *words):
        """A site from before 0333, with a link on each of `words`: their ids and what each is on."""
        self.cur.execute("ALTER TABLE public.links DROP CONSTRAINT links_entity_type_known;")
        planted = {}
        for word in words:
            on = str(uuid.uuid4())
            self.cur.execute(INSERT, (word, on))
            planted[str(self.cur.fetchone()[0])] = (word, on)
        return planted


class TheFourWords(Base):

    def test_each_is_accepted(self):
        for kind in KINDS:
            for caller in (MANAGER, ADMINISTRATOR):
                with self.subTest(kind=kind, caller=caller):
                    self.assertTrue(self.run_as(caller, INSERT, (kind, str(uuid.uuid4()))))

    def test_any_other_is_refused_to_everyone(self):
        for word in OTHERS:
            for caller in CALLERS:
                with self.subTest(word=word, caller=caller):
                    with self.assertRaises(pg_errors.CheckViolation) as raised:
                        self.run_as(caller, INSERT, (word, str(uuid.uuid4())))
                    self.assertEqual((raised.exception.pgcode, raised.exception.diag.constraint_name),
                                     ("23514", "links_entity_type_known"))

    def test_a_link_cannot_be_changed_to_another_word(self):
        link = self.run_as(MANAGER, INSERT, ("device", str(uuid.uuid4())))
        for caller in CALLERS:
            with self.subTest(caller=caller), self.assertRaises(pg_errors.CheckViolation):
                self.run_as(caller, "UPDATE public.links SET entity_type = 'nonsense' WHERE id = %s;", (link,))
        self.assertEqual(self.run_as(MANAGER, "UPDATE public.links SET entity_type = 'cell' WHERE id = %s;", (link,)), 1)

    def test_the_chain_leaves_it_validated(self):
        _, _, validated, says = self.constraint()
        self.assertTrue(validated)
        self.assertEqual(
            says, "CHECK ((entity_type = ANY (ARRAY['area'::text, 'cell'::text, 'device'::text, 'gateway'::text])))")


class ABootOverAnOddRow(Base):

    def test_the_rows_are_named_and_left_as_they_are(self):
        odd = self.before_0333(*OTHERS)
        before = self.links()
        said = self.boot()
        self.assertEqual(self.links(), before, "the boot changed a link")
        self.assertFalse(self.constraint()[2], "the constraint is validated over a row it refuses")
        self.assertEqual(len(said), len(odd), said)
        for link, (word, on) in odd.items():
            with self.subTest(word=word):
                quoted = word.replace("'", "''")
                self.assertEqual(
                    [line for line in said if link in line],
                    [f"WARNING:  0333: the link {link} is on '{quoted}' with the id '{on}', which is no kind a link can "
                     "be on, so no page shows it. Set its entity_type to area, cell, device or gateway, or delete the "
                     "row. The next boot checks it again."])

    def test_a_new_row_and_a_changed_one_are_held_meanwhile(self):
        [link] = self.before_0333("nonsense")
        self.boot()
        with self.assertRaises(pg_errors.CheckViolation):
            self.run_as(MANAGER, INSERT, ("nonsense", str(uuid.uuid4())))
        with self.assertRaises(pg_errors.CheckViolation):
            self.run_as(MANAGER, "UPDATE public.links SET entity_type = 'other' WHERE id = %s;", (link,))
        self.assertTrue(self.run_as(MANAGER, INSERT, ("device", str(uuid.uuid4()))))

    def test_a_second_boot_says_the_same_and_changes_nothing(self):
        self.before_0333("nonsense", "devices")
        first = self.boot()
        before = self.constraint(), self.links()
        self.assertEqual(sorted(self.boot()), sorted(first))
        self.assertEqual((self.constraint(), self.links()), before)

    def test_a_row_put_right_by_hand_is_validated_on_the_next_boot(self):
        fixed, deleted = self.before_0333("nonsense", "devices")
        self.boot()
        self.assertEqual(self.run_as(MANAGER, "UPDATE public.links SET entity_type = 'device' WHERE id = %s;", (fixed,)), 1)
        # One is right and one is not: still named, still NOT VALID.
        [line] = self.boot()
        self.assertIn(deleted, line)
        self.assertFalse(self.constraint()[2])
        self.assertEqual(self.run_as(ADMINISTRATOR, "DELETE FROM public.links WHERE id = %s;", (deleted,)), 1)
        kept = self.links()
        self.assertEqual(self.boot(), [])
        self.assertTrue(self.constraint()[2])
        self.assertEqual(self.links(), kept)
        before = self.constraint()
        self.assertEqual(self.boot(), [])
        self.assertEqual(self.constraint(), before, "a boot after it is validated touched it")

    def test_a_site_with_no_such_row_is_validated_at_once(self):
        self.before_0333(*KINDS)
        before = self.links()
        self.assertEqual(self.boot(), [])
        self.assertTrue(self.constraint()[2])
        self.assertEqual(self.links(), before)


class AReplay(Base):

    def test_it_changes_nothing(self):
        for kind in KINDS:
            self.run_as(MANAGER, INSERT, (kind, str(uuid.uuid4())))
        before = self.constraint(), self.links()
        self.assertEqual(self.boot(), [])
        self.assertEqual((self.constraint(), self.links()), before)

    def test_a_later_file_s_wider_constraint_is_left(self):
        self.cur.execute("ALTER TABLE public.links DROP CONSTRAINT links_entity_type_known;")
        self.cur.execute("ALTER TABLE public.links ADD CONSTRAINT links_entity_type_known CHECK"
                         " (entity_type IN ('area', 'cell', 'device', 'gateway', 'schema'));")
        self.assertTrue(self.run_as(MANAGER, INSERT, ("schema", str(uuid.uuid4()))))
        before = self.constraint(), self.links()
        self.assertEqual(self.boot(), [])
        self.assertEqual((self.constraint(), self.links()), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
