"""
Constraints, policies and triggers are re-created only when they differ (0001, section 3c).

db-init replays every file on every boot. Each DROP POLICY, CREATE POLICY and DROP TRIGGER makes
the image's supautils take ACCESS EXCLUSIVE on up to 24 GoTrue, Storage and Realtime tables, so
every policy and trigger is a call to replay_policy() or replay_trigger(). Each compares the live
object, as pg_dump writes it, with the statement it is given, and acts only on a difference.
0001's constraint guards do the same through live_constraint_definition(): dropping a foreign key
to auth.users takes ACCESS EXCLUSIVE on it, and adding it back scans the referencing table. Two
faults are possible, and this suite holds both off:

  * A FALSE "SAME" leaves a stale policy or constraint live for good: an RLS hole, or a rule the
    migrations no longer state, and nothing reports it. Every policy, trigger, CHECK and foreign
    key the chain states is changed in turn, and its own call or guard must put it back.
  * A STATEMENT THAT NEVER MATCHES is re-created on every boot. Nothing fails, and the locks are
    back. After the chain, every statement and guard equals its live object, running every call
    again takes no ACCESS EXCLUSIVE lock, and running every guard again keeps every constraint's
    oid.

The calls are read from the applied migrations, as db-init runs them. Every test rolls back.
"""
import os
import pathlib
import re
import unittest

import psycopg2
from psycopg2 import sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATIONS = pathlib.Path(__file__).resolve().parent
CALL = re.compile(
    r"^SELECT public\.replay_(policy|trigger)\('((?:[^']|'')+)', '((?:[^']|'')+)', \$ddl\$\n"
    r"(.*)\n\$ddl\$(?:, p_stated_by => '([^']+)')?\);$",
    re.M,
)
LIVE = {
    "policy": "SELECT public.live_policy_statement(%s::regclass, %s)",
    "trigger": "SELECT public.live_trigger_statement(%s::regclass, %s)",
}
ON_PROBE = {
    "policy": "SELECT public.replay_policy('public.replay_probe', %s, %s)",
    "trigger": "SELECT public.replay_trigger('public.replay_probe', %s, %s)",
}
DROP = {"policy": sql.SQL("DROP POLICY {} ON {}"), "trigger": sql.SQL("DROP TRIGGER {} ON {}")}
GUARD = re.compile(r"^DO \$c\$ BEGIN\n.*?^END \$c\$;$", re.M | re.S)
GUARD_COMPARES = re.compile(
    r"WHERE conname = '((?:[^']|'')+)'\n\s+AND conrelid = '((?:[^']|'')+)'::regclass\n"
    r"\s+AND public\.live_constraint_definition\(conrelid, conname\) <> '((?:[^']|'')*)'\) THEN")
CONSTRAINT_OIDS = """
    SELECT c.conrelid::regclass::text || ' ' || c.conname, c.oid
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'public'"""


def drop(cur, kind, table, name):
    cur.execute(DROP[kind].format(sql.Identifier(name), sql.Identifier(*table.split("."))))


def calls():
    """Every replay call in the applied migrations, in the order db-init runs them."""
    out = []
    for path in sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        for m in CALL.finditer(path.read_text(encoding="utf-8")):
            kind, table, name, statement, stated_by = m.groups()
            out.append({
                "file": path.name, "kind": kind, "table": table.replace("''", "'"),
                "name": name.replace("''", "'"), "statement": statement, "stated_by": stated_by,
                "sql": m.group(0),
            })
    return out


def guards():
    """Every constraint guard in the applied migrations, with what it compares."""
    out = []
    for path in sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        for m in GUARD.finditer(path.read_text(encoding="utf-8")):
            compares = GUARD_COMPARES.search(m.group(0))
            out.append({
                "file": path.name, "sql": m.group(0),
                "name": compares.group(1).replace("''", "'") if compares else None,
                "table": compares.group(2).replace("''", "'") if compares else None,
                "definition": compares.group(3).replace("''", "'") if compares else None,
            })
    return out


def stated():
    """The call that states each object in full: the last one without p_stated_by."""
    last = {}
    for c in calls():
        if not c["stated_by"]:
            last[(c["kind"], c["table"], c["name"])] = c
    return last


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class ReplayTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            connect().close()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")
        cls.calls = calls()
        cls.stated = stated()
        cls.guards = guards()

    def setUp(self):
        self.conn = connect()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def live(self, kind, table, name):
        self.cur.execute(LIVE[kind], (table, name))
        return self.cur.fetchone()[0]

    def replay(self, call):
        del self.conn.notices[:]
        self.cur.execute(call["sql"])
        return [n for n in self.conn.notices if " on " in n]


class EveryCallMatchesTheLiveObject(ReplayTestCase):

    def test_the_chain_states_its_policies_and_triggers_through_the_calls(self):
        kinds = {k for k, _, _ in self.stated}
        self.assertEqual(kinds, {"policy", "trigger"})
        self.assertGreaterEqual(len(self.stated), 100, "fewer replay calls than the chain holds")

    def test_every_statement_is_the_live_object_as_pg_dump_writes_it(self):
        differ = []
        for (kind, table, name), c in self.stated.items():
            live = self.live(kind, table, name)
            if live != c["statement"]:
                differ.append(f"{c['file']}: {kind} {name} on {table}\n    stated: {c['statement']}\n"
                              f"    live:   {live}")
        self.assertEqual(differ, [], "these are re-created on every boot:\n  " + "\n  ".join(differ))

    def test_every_call_that_defers_names_an_object_that_exists(self):
        for c in (c for c in self.calls if c["stated_by"]):
            with self.subTest(file=c["file"], name=c["name"]):
                self.assertIn((c["kind"], c["table"], c["name"]), self.stated)
                self.assertIsNotNone(self.live(c["kind"], c["table"], c["name"]))

    def test_replaying_every_call_takes_no_access_exclusive_lock(self):
        changed = []
        for c in self.calls:
            changed += self.replay(c)
        self.cur.execute(
            "SELECT l.relation::regclass::text FROM pg_locks l"
            " WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.mode = 'AccessExclusiveLock'"
            " ORDER BY 1")
        self.assertEqual([r[0] for r in self.cur.fetchall()], [])
        self.assertEqual(changed, [], "a call re-created an object that had not changed")


class AStalePolicyIsPutBack(ReplayTestCase):
    """Each part of CREATE POLICY, changed live, and the file's own call putting it back."""

    def mutations(self, statement, table):
        # FOR ALL where a command is named, and FOR UPDATE (which takes both clauses) where none is.
        command = re.sub(r" FOR (SELECT|INSERT|UPDATE|DELETE)", "", statement, count=1)
        if command == statement:
            command = statement.replace(f" ON {table}", f" ON {table} FOR UPDATE", 1)
        out = {
            "roles": re.sub(r" TO \S+?(?= USING| WITH CHECK|;)", " TO anon", statement, count=1),
            "restrictive": statement.replace(f" ON {table}", f" ON {table} AS RESTRICTIVE", 1),
            "command": command,
        }
        if " USING (" in statement:
            out["using"] = statement.replace(" USING (", " USING (false AND ", 1)
        if " WITH CHECK (" in statement:
            out["with check"] = statement.replace(" WITH CHECK (", " WITH CHECK (false AND ", 1)
        return out

    def test_every_policy_comes_back_from_each_change(self):
        policies = [c for (kind, _, _), c in self.stated.items() if kind == "policy"]
        self.assertGreater(len(policies), 50)
        for c in policies:
            for part, changed in self.mutations(c["statement"], c["table"]).items():
                with self.subTest(policy=c["name"], part=part):
                    self.assertNotEqual(changed, c["statement"], "the mutation changed nothing")
                    self.cur.execute("SAVEPOINT each")
                    drop(self.cur, "policy", c["table"], c["name"])
                    self.cur.execute(changed)
                    self.assertNotEqual(self.live("policy", c["table"], c["name"]), c["statement"])
                    notices = self.replay(c)
                    self.assertEqual(self.live("policy", c["table"], c["name"]), c["statement"])
                    self.assertTrue(any("re-created" in n for n in notices), notices)
                    self.cur.execute("ROLLBACK TO SAVEPOINT each")

    def test_a_missing_policy_is_created(self):
        c = self.stated[("policy", "public.areas", "areas_select_authenticated")]
        drop(self.cur, "policy", c["table"], c["name"])
        notices = self.replay(c)
        self.assertEqual(self.live("policy", c["table"], c["name"]), c["statement"])
        self.assertTrue(any(n.rstrip().endswith("created") for n in notices), notices)


class AStaleTriggerIsPutBack(ReplayTestCase):

    def test_every_trigger_comes_back_disabled_or_redefined(self):
        triggers = [c for (kind, _, _), c in self.stated.items() if kind == "trigger"]
        self.assertGreater(len(triggers), 30)
        for c in triggers:
            timing = re.sub(r"^(CREATE TRIGGER \S+) (BEFORE|AFTER) ",
                            lambda m: f"{m.group(1)} {'AFTER' if m.group(2) == 'BEFORE' else 'BEFORE'} ",
                            c["statement"], count=1)
            table, name = sql.Identifier(*c["table"].split(".")), sql.Identifier(c["name"])
            changes = {
                "disabled": [sql.SQL("ALTER TABLE {} DISABLE TRIGGER {}").format(table, name)],
                "replica": [sql.SQL("ALTER TABLE {} ENABLE REPLICA TRIGGER {}").format(table, name)],
                "timing": [DROP["trigger"].format(name, table), timing],
            }
            for part, statements in changes.items():
                with self.subTest(trigger=c["name"], part=part):
                    self.cur.execute("SAVEPOINT each")
                    for statement in statements:
                        self.cur.execute(statement)
                    self.assertNotEqual(self.live("trigger", c["table"], c["name"]), c["statement"])
                    notices = self.replay(c)
                    self.assertEqual(self.live("trigger", c["table"], c["name"]), c["statement"])
                    self.assertTrue(any("re-created" in n for n in notices), notices)
                    self.cur.execute("ROLLBACK TO SAVEPOINT each")


class EveryConstraintKeepsItsOid(ReplayTestCase):
    """0001's guards: the same two directions, for every constraint they guard."""

    def oids(self):
        self.cur.execute(CONSTRAINT_OIDS)
        return dict(self.cur.fetchall())

    def test_every_guard_compares_the_definition_it_adds(self):
        self.assertGreater(len(self.guards), 150)
        unparsed = [g["sql"].splitlines()[2] for g in self.guards if g["name"] is None]
        self.assertEqual(unparsed, [], "a guard that does not compare live_constraint_definition()")

    def test_every_guard_matches_its_live_constraint(self):
        differ = []
        for g in self.guards:
            self.cur.execute("SELECT public.live_constraint_definition(%s::regclass, %s)", (g["table"], g["name"]))
            live = self.cur.fetchone()[0]
            if live != g["definition"]:
                differ.append(f"{g['file']}: {g['name']} on {g['table']}\n    guard: {g['definition']}\n"
                              f"    live:  {live}")
        self.assertEqual(differ, [], "these are dropped and added back on every boot:\n  " + "\n  ".join(differ))

    def test_running_every_guard_again_keeps_every_oid_and_takes_no_lock(self):
        before = self.oids()
        for g in self.guards:
            self.cur.execute(g["sql"])
        after = self.oids()
        self.assertEqual(sorted(k for k in before if after.get(k) != before[k]), [],
                         "a guard dropped and added back a constraint that had not changed")
        self.cur.execute(
            "SELECT l.relation::regclass::text FROM pg_locks l"
            " WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.mode = 'AccessExclusiveLock'")
        self.assertEqual([r[0] for r in self.cur.fetchall()], [])

    def test_every_check_and_foreign_key_comes_back_from_a_change(self):
        self.cur.execute("SELECT n.nspname || '.' || r.relname || ' ' || c.conname FROM pg_constraint c"
                         " JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace"
                         " WHERE c.contype IN ('c', 'f') AND c.conparentid = 0")
        changeable = {r[0] for r in self.cur.fetchall()}
        targets = [g for g in self.guards if f"{g['table']} {g['name']}" in changeable]
        self.assertGreater(len(targets), 50)
        for g in targets:
            with self.subTest(constraint=g["name"]):
                table, name = sql.Identifier(*g["table"].split(".")), sql.Identifier(g["name"])
                self.cur.execute("SAVEPOINT each")
                self.cur.execute(sql.SQL("ALTER TABLE {} DROP CONSTRAINT {}").format(table, name))
                self.cur.execute(sql.SQL("ALTER TABLE {} ADD CONSTRAINT {} CHECK (true)").format(table, name))
                self.cur.execute(g["sql"])
                self.cur.execute("SELECT public.live_constraint_definition(%s::regclass, %s)", (g["table"], g["name"]))
                self.assertEqual(self.cur.fetchone()[0], g["definition"])
                self.cur.execute("ROLLBACK TO SAVEPOINT each")


class TheComparison(ReplayTestCase):
    """On a scratch table: the forms the chain does not use yet, and the refusals."""

    def setUp(self):
        super().setUp()
        self.cur.execute("CREATE TABLE public.replay_probe (id int, owner text)")
        self.cur.execute("ALTER TABLE public.replay_probe ENABLE ROW LEVEL SECURITY")

    def call(self, name, statement, kind="policy"):
        del self.conn.notices[:]
        self.cur.execute(ON_PROBE[kind], (name, statement))
        return list(self.conn.notices)

    def test_each_form_pg_dump_writes_matches_once_created(self):
        for name, statement in [
            ("Mixed Case", 'CREATE POLICY "Mixed Case" ON public.replay_probe USING ((id > 0));'),
            ("narrow", "CREATE POLICY narrow ON public.replay_probe AS RESTRICTIVE FOR UPDATE TO authenticated, "
                       "service_role USING ((owner = CURRENT_USER)) WITH CHECK ((id IS NOT NULL));"),
            ("bare", "CREATE POLICY bare ON public.replay_probe;"),
        ]:
            with self.subTest(name=name):
                self.assertTrue(any("created" in n for n in self.call(name, statement)))
                self.assertEqual(self.live("policy", "public.replay_probe", name), statement)
                self.assertEqual(self.call(name, statement), [], "a second call re-created it")

    def test_roles_are_compared_in_the_order_given(self):
        first = "CREATE POLICY two ON public.replay_probe TO authenticated, service_role USING (true);"
        swapped = "CREATE POLICY two ON public.replay_probe TO service_role, authenticated USING (true);"
        self.call("two", first)
        self.assertTrue(any("re-created" in n for n in self.call("two", swapped)))
        self.assertEqual(self.call("two", swapped), [])

    def test_a_statement_not_in_pg_dumps_form_is_re_created_with_a_warning(self):
        loose = "CREATE POLICY loose ON public.replay_probe FOR SELECT TO authenticated USING (id > 0);"
        self.call("loose", loose)
        notices = self.call("loose", loose)
        self.assertTrue(any("re-created on every boot" in n for n in notices), notices)
        self.assertEqual(self.live("policy", "public.replay_probe", "loose"),
                         "CREATE POLICY loose ON public.replay_probe FOR SELECT TO authenticated USING ((id > 0));")

    def test_a_statement_for_another_object_is_refused(self):
        for name, statement, kind in [
            ("one", "CREATE POLICY other ON public.replay_probe USING (true);", "policy"),
            ("one", "CREATE POLICY one ON public.areas USING (true);", "policy"),
            ("one_trg", "CREATE TRIGGER other_trg AFTER INSERT ON public.replay_probe"
                        " FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();", "trigger"),
            ("one_trg", "CREATE TRIGGER one_trg AFTER INSERT ON public.areas"
                        " FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();", "trigger"),
        ]:
            with self.subTest(statement=statement):
                self.cur.execute("SAVEPOINT each")
                with self.assertRaises(psycopg2.errors.RaiseException):
                    self.call(name, statement, kind)
                self.cur.execute("ROLLBACK TO SAVEPOINT each")

    def test_p_stated_by_creates_a_missing_object_and_leaves_a_present_one(self):
        old = "CREATE POLICY later ON public.replay_probe FOR SELECT TO authenticated USING (true);"
        new = "CREATE POLICY later ON public.replay_probe FOR SELECT TO authenticated USING ((id > 0));"
        sql = ("SELECT public.replay_policy('public.replay_probe', 'later', %s,"
               " p_stated_by => '0177_policies_check_the_caller_once_per_query.sql')")
        self.cur.execute(sql, (old,))
        self.assertEqual(self.live("policy", "public.replay_probe", "later"), old)
        self.call("later", new)
        self.cur.execute(sql, (old,))
        self.assertEqual(self.live("policy", "public.replay_probe", "later"), new)

    def test_no_api_role_may_call_them(self):
        for fn in ("public.live_constraint_definition(regclass, name)",
                   "public.replay_policy(regclass, name, text, text)",
                   "public.replay_trigger(regclass, name, text, text)",
                   "public.live_policy_statement(regclass, name)",
                   "public.live_trigger_statement(regclass, name)"):
            for role in ("anon", "authenticated", "service_role"):
                with self.subTest(function=fn, role=role):
                    self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE')", (role, fn))
                    self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
