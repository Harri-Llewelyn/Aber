# suite:
#   lanes: db
#   why: 0229 -- that audit_trail_action_kinds() names every (action, kind) pair the trail's writers
#     can produce, read from the catalog, and no other, and that each pair carries the classes
#     audit_event_class() answers for it. The Audit Trail narrows its filters by its mirror.

"""
The Audit Trail knows which kinds each action is written for (0229).

    python supabase/migrations/test_the_audit_trail_knows_which_kinds_each_action_is_written_for.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * audit_trail_action_kinds() names every (action, kind) pair the trail's writers can produce, and
    no other. The writers are read from the catalog: the audit trigger on each table it is attached
    to, for the operations it fires on, and every function whose body inserts into audit_trail,
    with its kind and action read from the INSERT. A writer whose kind or action this cannot read
    fails the suite rather than passing with a pair unread.
  * Each pair's classes are the ones audit_event_class() answers for it, over snapshots that reach
    each of its rules.
  * It runs for the trail's readers and not for anon.

Read-only: nothing is written.
"""
import os
import re
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Snapshots that reach each of audit_event_class()'s rules: none, a flag that rose, a configuration
# field that changed, and an ordinary field that changed.
PROBES = (
    (None, None),
    ("{}", '{"is_archived": true}'),
    ('{"schema_id": "a"}', '{"schema_id": "b"}'),
    ('{"status": "a"}', '{"status": "b"}'),
)
INSERT = re.compile(r"INSERT\s+INTO\s+(?:public\.)?audit_trail\b", re.I)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def closing(s, open_at):
    """The index of the parenthesis closing the one at `open_at`, skipping quoted text."""
    depth, quoted = 0, False
    for i in range(open_at, len(s)):
        if s[i] == "'":
            quoted = not quoted
        elif not quoted and s[i] == "(":
            depth += 1
        elif not quoted and s[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def top_level(s):
    parts, depth, quoted, start = [], 0, False, 0
    for i, ch in enumerate(s):
        if ch == "'":
            quoted = not quoted
        elif not quoted and ch == "(":
            depth += 1
        elif not quoted and ch == ")":
            depth -= 1
        elif not quoted and depth == 0 and ch == ",":
            parts.append(s[start:i].strip())
            start = i + 1
    return parts + [s[start:].strip()]


def uncommented(sql):
    out = []
    for line in sql.split("\n"):
        quoted = False
        for i, ch in enumerate(line):
            if ch == "'":
                quoted = not quoted
            elif not quoted and line.startswith("--", i):
                line = line[:i]
                break
        out.append(line)
    return "\n".join(out)


class TheMap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.cur = cls.conn.cursor()

    @classmethod
    def tearDownClass(cls):
        cls.conn.rollback()
        cls.conn.close()

    def map(self):
        self.cur.execute("SELECT action, entity_type, classes FROM public.audit_trail_action_kinds();")
        return {(a, k): sorted(c) for a, k, c in self.cur.fetchall()}

    def check_values(self, table, column):
        """The values a CHECK on `table.column` allows, from `= 'x'` or `= ANY (ARRAY[...])`."""
        self.cur.execute(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c"
            " WHERE c.conrelid = %s::regclass AND c.contype = 'c';", (f"public.{table}",))
        for (definition,) in self.cur.fetchall():
            if re.match(rf"CHECK \(\(+{column}\b", definition):
                return set(re.findall(r"'([a-z_]+)'::text", definition))
        return None

    def trigger_tables(self, function):
        self.cur.execute(
            "SELECT c.relname, t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid"
            "  JOIN pg_proc p ON p.oid = t.tgfoid"
            " WHERE NOT t.tgisinternal AND p.proname = %s;", (function,))
        return self.cur.fetchall()

    def writers(self):
        """Every (action, kind) a writer can produce, and the INSERTs this could not read."""
        pairs, unread = set(), []
        self.cur.execute(
            "SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')"
            "   AND p.prosrc ~* 'INSERT\\s+INTO\\s+(public\\.)?audit_trail\\M';"
        )
        for name, source in self.cur.fetchall():
            body = uncommented(source)
            for m in INSERT.finditer(body):
                where = f"{name}()"
                opened = body.index("(", m.end())
                columns = [c.lower() for c in top_level(body[opened + 1:closing(body, opened)])]
                rest = body[closing(body, opened) + 1:]
                values = re.match(r"\s*VALUES\s*\(", rest, re.I)
                if "action" not in columns or "entity_type" not in columns or not values:
                    unread.append(f"{where}: not INSERT INTO audit_trail (..., entity_type, action, ...) VALUES (...)")
                    continue
                tuple_at = closing(body, opened) + 1 + values.end() - 1
                exprs = top_level(body[tuple_at + 1:closing(body, tuple_at)])
                kind = exprs[columns.index("entity_type")]
                action = exprs[columns.index("action")]
                kinds = self.resolve_kind(name, body, kind)
                actions = self.resolve_action(name, body, action)
                if kinds is None or actions is None:
                    unread.append(f"{where}: entity_type {kind}, action {action}")
                    continue
                if kinds == "TRIGGER":
                    # The audit trigger: the table it is on, for each operation it fires on.
                    for table, tgtype in self.trigger_tables(name):
                        for bit, op in ((4, "INSERT"), (8, "DELETE"), (16, "UPDATE")):
                            if tgtype & bit:
                                pairs.add((op, table))
                    continue
                pairs.update((a, k) for a in actions for k in kinds)
        return pairs, unread

    def resolve_kind(self, function, body, expr):
        if re.fullmatch(r"'[a-z_]+'", expr):
            return {expr[1:-1]}
        if expr == "TG_TABLE_NAME":
            return "TRIGGER"
        record = re.fullmatch(r"(\w+)\.entity_type", expr)
        if record:
            # NEW in a trigger: its table's CHECK. A record variable: its declared table's CHECK.
            if record.group(1).upper() == "NEW":
                tables = {t for t, _ in self.trigger_tables(function)}
            else:
                declared = re.search(rf"\b{record.group(1)}\s+(?:public\.)?([a-z_]+)(?:%ROWTYPE)?\s*;", body)
                tables = {declared.group(1)} if declared else set()
            allowed = [self.check_values(t, "entity_type") for t in tables]
            if len(tables) == 1 and allowed[0]:
                return allowed[0]
        return None

    def resolve_action(self, function, body, expr):
        if re.fullmatch(r"'[A-Z_]+'", expr):
            return {expr[1:-1]}
        if expr == "TG_OP":
            return {"INSERT", "UPDATE", "DELETE"}
        if re.fullmatch(r"[a-z_][a-z0-9_]*", expr):
            assigned = re.findall(rf"\b{expr}\s*:=\s*([^;]+);", body)
            if assigned and all(re.fullmatch(r"'[A-Z_]+'", a.strip()) for a in assigned):
                return {a.strip()[1:-1] for a in assigned}
        return None

    def test_it_names_every_pair_a_writer_can_produce_and_no_other(self):
        pairs, unread = self.writers()
        self.assertEqual(unread, [], "Read the new writer's shape here, or write its kind and action as literals")
        self.assertGreater(len(pairs), 60)
        declared = set(self.map())
        self.assertEqual(sorted(pairs - declared), [], "a writer produces these, and the map lacks them")
        self.assertEqual(sorted(declared - pairs), [], "the map lists these, and no writer produces them")

    def test_each_pair_s_classes_are_audit_event_class_s(self):
        for (action, kind), classes in sorted(self.map().items()):
            with self.subTest(action=action, kind=kind):
                found = set()
                for old, new in PROBES:
                    self.cur.execute(
                        "SELECT public.audit_event_class(%s, %s, public.audit_domain_for(%s, %s), %s::jsonb, %s::jsonb);",
                        (action, kind, kind, action, old, new))
                    found.add(self.cur.fetchone()[0])
                self.assertEqual(classes, sorted(found))

    def test_who_may_run_it(self):
        self.cur.execute(
            "SELECT has_function_privilege('authenticated', f, 'EXECUTE'),"
            "       has_function_privilege('service_role', f, 'EXECUTE'),"
            "       has_function_privilege('anon', f, 'EXECUTE'), p.provolatile"
            "  FROM (SELECT 'public.audit_trail_action_kinds()'::regprocedure AS f) x"
            "  JOIN pg_proc p ON p.oid = x.f;"
        )
        self.assertEqual(self.cur.fetchone(), (True, True, False, "i"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
