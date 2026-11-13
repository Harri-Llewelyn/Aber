# suite:
#   lanes: db
#   why: Prints what has_role() and has_authority() cost per call, and the plan of a read their
#     policy guards, so a change to either is measured before and after on the same database; and
#     what they cost for an app's token, which holds nothing (0235), and beside the MFA predicate a
#     write policy adds (0251). Fails only on a wrong answer, never on a number.

"""
The role checks every request makes are timed, and the numbers printed (no assertion on them).

    python supabase/migrations/test_role_checks_are_timed.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

has_role() and has_authority() run on every API request, so a change to either, or to the
user_roles column they read, is measured before and after by running this file on the same
database both times. It signs in as one person, as `authenticated`, and prints:

  * the median microseconds per call over RUNS runs of CALLS calls, for has_role() admitting,
    has_role() refusing and has_authority() admitting, beside the same loop with no call in it;
  * EXPLAIN ANALYZE of one RLS-guarded read whose policy calls has_role(), with the median
    execution time of RUNS runs;
  * the same checks for a token GoTrue issued to an app, which carries a client_id and holds no
    role (0235);
  * has_role() with mfa_satisfied() beside it, as a write policy asks (0251): with the MFA switch
    off, and on for an aal2 session, beside has_role() alone in the same run; and EXPLAIN ANALYZE of
    an UPDATE over WRITE_ROWS rows, whose policy reads the switch once, as an initplan.

It fails only when a check gives the wrong answer. A slow database prints a bigger number.
Every test rolls back.
"""
import json
import os
import statistics
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Fixed, so two runs are comparable. Changing either makes a new baseline.
CALLS = 10_000
RUNS = 5

ADMIN_ID = "7194a000-0000-4000-8000-0000000011a1"
OPERATOR_ID = "7194a000-0000-4000-8000-0000000011c1"

# The loop runs one expression CALLS times and reports the elapsed microseconds per call.
LOOP = """
DO $timed$
DECLARE
    v_start timestamptz;
    v_answer boolean;
BEGIN
    v_start := clock_timestamp();
    FOR i IN 1..{calls} LOOP
        v_answer := {expression};
    END LOOP;
    RAISE NOTICE 'timed % %', v_answer,
        extract(epoch FROM clock_timestamp() - v_start) * 1000000 / {calls};
END
$timed$;
"""


def loop(expression):
    return LOOP.format(calls=CALLS, expression=expression)


# Each loop is written out once, here, from the constants above.
CASES = [
    ("loop alone", loop("true"), True),
    ("has_role() admitting", loop("public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])"), True),
    ("has_role() refusing", loop("public.has_role(ARRAY['Auditor'])"), False),
    ("has_authority() admitting", loop("public.has_authority(ARRAY['audit_trail:read'])"), True),
]

# The same person's token as an app holds it: the claim test answers before the lookup.
APP_CLIENT_ID = "c0ffee00-0000-4000-8000-000000000001"
APP_CASES = [
    ("has_role(), an app's token", loop("public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])"), False),
    ("has_authority(), an app's token", loop("public.has_authority(ARRAY['audit_trail:read'])"), False),
]

# A write policy's two calls (0251), against has_role() alone in the same run, so both see one load.
MFA_SETTING = "security.require_mfa_for_managers"
GUARDED_CASES = [
    ("has_role() alone", loop("public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])"), True),
    ("has_role() + mfa_satisfied()", loop("public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) AND public.mfa_satisfied()"), True),
]
WRITE_ROWS = 10_000
GUARDED_WRITE = "EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON) UPDATE public.areas SET name = name WHERE name LIKE 'timing %';"

# user_roles' own policy calls has_role() beside a column comparison, so it shows both halves.
GUARDED_READ = "SELECT user_id, role_id FROM public.user_roles"
EXPLAINED = "EXPLAIN (ANALYZE, COSTS OFF, SUMMARY ON) SELECT user_id, role_id FROM public.user_roles;"
READ_ONE = "SELECT count(*) FROM public.user_roles r WHERE r.user_id::text = %s;"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class TheRoleChecksAreTimed(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        for user_id, role in ((ADMIN_ID, "Administrator"), (OPERATOR_ID, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@timing.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id)"
                " SELECT %s, id FROM public.roles WHERE name = %s;",
                (user_id, role),
            )
        self.cur.execute("SET ROLE authenticated;")
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true);",
            (json.dumps({"sub": ADMIN_ID, "role": "authenticated"}),),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def timed(self, statement):
        """Microseconds per call for each run, and the answer the last call gave."""
        per_call, answer = [], None
        for _ in range(RUNS):
            del self.conn.notices[:]
            self.cur.execute(statement)
            line = next(n for n in self.conn.notices if "timed " in n)
            _, _, verdict, micros = line.strip().rsplit(" ", 3)
            answer = verdict == "t"
            per_call.append(float(micros))
        return per_call, answer

    def test_each_check_is_timed_and_answers_as_before(self):
        print(f"\n  {CALLS} calls x {RUNS} runs, as {ADMIN_ID} (Administrator), median us per call:")
        for label, statement, expected in CASES:
            per_call, answer = self.timed(statement)
            self.assertEqual(answer, expected, label)
            runs = ", ".join(f"{t:.2f}" for t in per_call)
            print(f"    {label:28} {statistics.median(per_call):8.2f}   ({runs})")

    def test_an_apps_token_is_timed_and_holds_nothing(self):
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true);",
            (json.dumps({"sub": ADMIN_ID, "role": "authenticated", "client_id": APP_CLIENT_ID}),),
        )
        print(f"\n  {CALLS} calls x {RUNS} runs, as {ADMIN_ID} through {APP_CLIENT_ID}, median us per call:")
        for label, statement, expected in APP_CASES:
            per_call, answer = self.timed(statement)
            self.assertEqual(answer, expected, label)
            runs = ", ".join(f"{t:.2f}" for t in per_call)
            print(f"    {label:28} {statistics.median(per_call):8.2f}   ({runs})")

    def test_a_write_policy_s_mfa_term_is_timed(self):
        for on, aal in ((False, "aal1"), (True, "aal2")):
            self.cur.execute("RESET ROLE;")
            self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = %s;",
                             ("true" if on else "false", MFA_SETTING))
            self.cur.execute("SET ROLE authenticated;")
            self.cur.execute(
                "SELECT set_config('request.jwt.claims', %s, true);",
                (json.dumps({"sub": ADMIN_ID, "role": "authenticated", "aal": aal}),),
            )
            print(f"\n  {CALLS} calls x {RUNS} runs, as {ADMIN_ID} at {aal}, MFA {'on' if on else 'off'}, median us per call:")
            for label, statement, expected in GUARDED_CASES:
                per_call, answer = self.timed(statement)
                self.assertEqual(answer, expected, label)
                runs = ", ".join(f"{t:.2f}" for t in per_call)
                print(f"    {label:28} {statistics.median(per_call):8.2f}   ({runs})")

    def test_a_guarded_write_reads_the_switch_once(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("INSERT INTO public.areas (name) SELECT 'timing ' || n FROM generate_series(1, %s) n;",
                         (WRITE_ROWS,))
        self.cur.execute("UPDATE public.system_settings SET value = 'true' WHERE key = %s;", (MFA_SETTING,))
        self.cur.execute("SET ROLE authenticated;")
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true);",
            (json.dumps({"sub": ADMIN_ID, "role": "authenticated", "aal": "aal2"}),),
        )
        executions, plan = [], []
        for _ in range(RUNS):
            self.cur.execute(GUARDED_WRITE)
            plan = [row[0] for row in self.cur.fetchall()]
            executions.append(float(next(line for line in plan if line.startswith("Execution Time"))
                                    .split(":")[1].split()[0]))
        self.assertTrue(any("InitPlan" in line for line in plan), "the MFA term is not an initplan")
        updated = next(line for line in plan if line.lstrip().startswith("Update on areas"))
        self.assertIn("actual", updated)
        print(f"\n  EXPLAIN ANALYZE of an UPDATE over {WRITE_ROWS} areas, as an aal2 Administrator with MFA on, "
              f"median execution {statistics.median(executions):.3f} ms of {RUNS} runs. The last plan:")
        for line in plan:
            print(f"    {line}")

    def test_an_operator_is_refused_what_an_administrator_is_admitted(self):
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true);",
            (json.dumps({"sub": OPERATOR_ID, "role": "authenticated"}),),
        )
        self.cur.execute(
            "SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']),"
            "       public.has_role(ARRAY['Operator']),"
            "       public.has_authority(ARRAY['audit_trail:read']);"
        )
        self.assertEqual(self.cur.fetchone(), (False, True, False))

    def test_a_guarded_read_is_explained(self):
        executions, plan = [], []
        for _ in range(RUNS):
            self.cur.execute(EXPLAINED)
            plan = [row[0] for row in self.cur.fetchall()]
            executions.append(float(next(line for line in plan if line.startswith("Execution Time"))
                                    .split(":")[1].split()[0]))
        self.cur.execute(READ_ONE, (OPERATOR_ID,))
        self.assertEqual(self.cur.fetchone()[0], 1, "an Administrator reads everyone's role")
        print(f"\n  EXPLAIN ANALYZE {GUARDED_READ}; as an Administrator, median execution "
              f"{statistics.median(executions):.3f} ms of {RUNS} runs. The last plan:")
        for line in plan:
            print(f"    {line}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
