"""
The digital thread's security lane, and the acts that make one necessary (archived migration 0070).

WHAT THIS SUITE IS DEFENDING:

  1. THE LANE IS A DATABASE CONTROL, NOT A RENDERED ONE. This repository has already made the
     other mistake once and written down what it cost: *"THIS REPLACES `VITE_ALLOW_SIGNUP`, which
     was a frontend flag and therefore never an access control."* So every read test presents a
     real `authenticated` session and asks PostgreSQL, never the page.

  2. THE DOMAIN CANNOT BE SUPPLIED BY THE WRITER. Nine call sites insert into this table. The
     trigger overwrites whatever arrives, so a writer cannot file its own act in the lane that
     suits it -- the same assertion `actor_source` refuses to accept off a request header.

  3. IT FAILS CLOSED. An entity_type nobody classified is 'security'. The two failures are not
     symmetrical, and the test names which one it is choosing.

  4. THE RULE IS AUTHORITY, NOT SUBJECT MATTER. `CREDENTIAL_ISSUED` stays readable by a
     Shopfloor_Manager because `0041` lets one mint a host-run gateway's broker credential. A
     Manager who performs an act must be able to read that they performed it; an empty lane is
     only honest when the rows in it are somebody else's.

  5. AUDITOR STOPS BEING A SYNONYM. It reads both lanes and can perform neither, which is what
     separation of duties means and what the role was named for.

Every test rolls back. The rows these provoke are audit rows, and 0003 makes the table
append-only -- a committed fixture is permanent.
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

# Self-seeded rather than the demo personas: CI's RLS job applies the migrations and deliberately
# not seed.sql, so a suite depending on `admin@aber.local` fails there with a failure that
# looks like the policy and is actually the fixture.
ADMIN_ID = "a0d17070-0000-4000-8000-00000000ad11"
MANAGER_ID = "a0d17070-0000-4000-8000-0000000000b9"
AUDITOR_ID = "a0d17070-0000-4000-8000-0000000000c7"
SUBJECT_ID = "a0d17070-0000-4000-8000-0000000000ff"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def as_user(cur, user_id):
    """Become `authenticated` with a JWT subject, the way PostgREST 12.2 does it: claims only."""
    cur.execute("SET LOCAL ROLE authenticated;")
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))


#: `{ kind: 'X', table: 'y', label: 'Z', domain: 'asset' }`, the shape constants.js holds.
_LANE_ENTRY = re.compile(
    r"\{\s*kind:\s*'(?P<kind>[^']+)',\s*"
    r"table:\s*'(?P<table>[^']+)',\s*"
    r"label:\s*'[^']*',\s*"
    r"domain:\s*'(?P<domain>[^']+)'\s*\}"
)


def dashboard_lanes():
    """
    `DIGITAL_THREAD_ENTITY_TYPES` from constants.js: the kinds the platform still records.

    Read as text because it is the only place the frontend's half of this decision is written
    down. Two suites want it -- one to check the two sides agree, one to scope an assertion to
    the rows the platform is still writing -- and a second copy would be a second answer.
    """
    path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "frontend", "src", "constants.js"
    )
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    start = source.index("export const DIGITAL_THREAD_ENTITY_TYPES")
    end = source.index("];", start)
    table = source[start:end]
    return table, [m.groupdict() for m in _LANE_ENTRY.finditer(table)]


class AuditDomainFixture(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.audit_domain_for(text, text)');")
                if cur.fetchone()[0] is None:
                    raise RuntimeError("audit_domain_for() is missing -- run archived migration 0070 first.")

                cur.execute(
                    "SELECT id, name FROM public.roles WHERE name IN %s;",
                    (("Administrator", "Shopfloor_Manager", "Auditor"),),
                )
                cls.role_id = {name: rid for rid, name in cur.fetchall()}
                for needed in ("Administrator", "Shopfloor_Manager", "Auditor"):
                    if needed not in cls.role_id:
                        raise RuntimeError(f"role {needed!r} is missing; 0001 did not run cleanly.")

                # These three grants are themselves ROLE_GRANTED rows now, which is the feature.
                # ON CONFLICT DO NOTHING keeps a re-run from appending three more.
                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id)"
                    " VALUES (%s, %s), (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (ADMIN_ID, cls.role_id["Administrator"],
                     MANAGER_ID, cls.role_id["Shopfloor_Manager"],
                     AUDITOR_ID, cls.role_id["Auditor"]),
                )
                conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def _security_row(self, cur):
        """Provoke one security row and return its id. A role grant, which is the headline gap."""
        cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
            (SUBJECT_ID, self.role_id["Administrator"]),
        )
        cur.execute(
            "SELECT id FROM public.digital_thread"
            " WHERE entity_type = 'user_roles' ORDER BY id DESC LIMIT 1;"
        )
        return cur.fetchone()[0]


class TheClassifier(AuditDomainFixture):

    def test_identity_and_authority_are_security(self):
        with self.conn.cursor() as cur:
            for entity in ("service_principals", "user_roles", "system_settings"):
                cur.execute("SELECT public.audit_domain_for(%s, 'INSERT');", (entity,))
                self.assertEqual(cur.fetchone()[0], "security", entity)

    def test_the_shopfloor_is_asset(self):
        with self.conn.cursor() as cur:
            for entity in ("cells", "devices", "gateways", "links"):
                cur.execute("SELECT public.audit_domain_for(%s, 'UPDATE');", (entity,))
                self.assertEqual(cur.fetchone()[0], "asset", entity)

    def test_a_schema_is_asset(self):
        """
        THE ONE EXCEPTION TO THE AUTHORITY RULE, and 0120 is where it was made.

        Writing a schema is Administrator-only, so the rule above would file it as security --
        and it did, by falling through the fail-closed default, until a Manager reported a
        Schemas lane that could only answer "no events". `schemas_select_authenticated` is
        USING (true): every authenticated user already reads the registry, so a security lane
        made the HISTORY of a world-readable table more secret than the table. The other three
        security lanes do not have that shape; their tables are restricted too.
        """
        with self.conn.cursor() as cur:
            cur.execute("SELECT public.audit_domain_for('schemas', 'UPDATE');")
            self.assertEqual(cur.fetchone()[0], "asset")

    def test_credential_issued_stays_asset(self):
        """
        THE RULE IS AUTHORITY, NOT SUBJECT MATTER, and this is the case that separates them.

        CREDENTIAL_ISSUED reads like a row a Shopfloor_Manager should not read. But 0041
        admits a Shopfloor_Manager to authorize_host_gateway_credential(), so filing it as security
        would mean a Manager mints a broker credential and the record of their own act disappears.
        An empty lane is only honest when the rows in it belong to somebody else.
        """
        with self.conn.cursor() as cur:
            cur.execute("SELECT public.audit_domain_for('gateways', 'CREDENTIAL_ISSUED');")
            self.assertEqual(cur.fetchone()[0], "asset")

    def test_token_minted_is_security(self):
        """Minting for a service principal is Administrator-only (0042, 0044), so reading it is."""
        with self.conn.cursor() as cur:
            cur.execute("SELECT public.audit_domain_for('service_principals', 'TOKEN_MINTED');")
            self.assertEqual(cur.fetchone()[0], "security")

    def test_an_unclassified_entity_fails_closed(self):
        """
        The safe failure is a lane a Shopfloor_Manager cannot see -- visible, complained about,
        corrected in a line. The unsafe one is a privileged act they can see, silently.
        """
        with self.conn.cursor() as cur:
            cur.execute("SELECT public.audit_domain_for('a_table_invented_later', 'INSERT');")
            self.assertEqual(cur.fetchone()[0], "security")

    def test_every_row_of_a_kind_still_recorded_agrees_with_it(self):
        """
        Nothing has been written past the trigger, and every reclassification has been backfilled.

        SCOPED TO THE KINDS THE PLATFORM STILL RECORDS, because the unscoped form asserts
        something that is false on any database with history. A type that was reclassified, or
        whose table was later retired, keeps the lane its rows were stamped with -- and for a
        retired type the classifier's answer is its FAIL-CLOSED DEFAULT rather than a judgement
        about those rows. A live stack carried ten `area_floors` rows stamped `asset` from before
        0113 retired that table.

        An empty database has no history, so the unscoped assertion passed in CI and in every
        throwaway run, and aborted the migration chain the first time it met a real deployment --
        0120's self-check had copied it.
        """
        _, lanes = dashboard_lanes()
        recorded = [lane["table"] for lane in lanes]
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT entity_type, count(*) FROM public.digital_thread"
                " WHERE entity_type = ANY(%s)"
                "   AND audit_domain IS DISTINCT FROM"
                "       public.audit_domain_for(entity_type, action)"
                " GROUP BY 1;",
                (recorded,),
            )
            disagreeing = cur.fetchall()
            self.assertEqual(
                disagreeing, [],
                "rows disagree with the classifier -- a row in the wrong lane is readable by the "
                "wrong role, which is the whole subject of 0070."
            )


class TheDomainCannotBeSupplied(AuditDomainFixture):

    def test_a_writer_cannot_file_its_own_act_in_the_asset_lane(self):
        # Runs as the table owner, which is the only role that can INSERT here at all -- 0026
        # closed the direct path for service_role. That makes this a test of the TRIGGER rather
        # than of a policy, which is the point: the trigger is what nine call sites rely on.
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.digital_thread"
                " (entity_type, entity_id, action, audit_domain, actor_source)"
                " VALUES ('service_principals', %s, 'TOKEN_MINTED', 'asset', 'service')"
                " RETURNING audit_domain;",
                (SUBJECT_ID,),
            )
            self.assertEqual(
                cur.fetchone()[0], "security",
                "a caller supplied 'asset' for a service-principal act and it stuck. The stamp "
                "must OVERWRITE rather than default, or classifying an act becomes the writer's "
                "assertion about itself."
            )

    def test_the_check_constraint_refuses_a_third_lane(self):
        with self.conn.cursor() as cur:
            # The trigger normalises anything an INSERT supplies, so the constraint is reached by
            # an UPDATE -- available here because 0003 exempts the owner deliberately.
            row = self._security_row(cur)
            with self.assertRaises(psycopg2.errors.CheckViolation):
                cur.execute(
                    "UPDATE public.digital_thread SET audit_domain = 'governance' WHERE id = %s;",
                    (row,),
                )


class TheActsNothingRecorded(AuditDomainFixture):

    def test_a_role_grant_is_recorded_and_names_the_role(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                (SUBJECT_ID, self.role_id["Administrator"]),
            )
            cur.execute(
                "SELECT action, audit_domain, entity_id, new_data->>'role'"
                "  FROM public.digital_thread WHERE entity_type = 'user_roles'"
                " ORDER BY id DESC LIMIT 1;"
            )
            action, domain, entity_id, role = cur.fetchone()
            self.assertEqual(action, "ROLE_GRANTED")
            self.assertEqual(domain, "security")
            self.assertEqual(str(entity_id), SUBJECT_ID)
            # THE NAME, NOT JUST THE ID. `role_id` is an integer from a sequence; a reader of the
            # audit trail in a year should not have to resolve it against a table that may have
            # moved on.
            self.assertEqual(role, "Administrator")

    def test_a_role_revocation_is_recorded(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                (SUBJECT_ID, self.role_id["Administrator"]),
            )
            cur.execute("DELETE FROM public.user_roles WHERE user_id = %s;", (SUBJECT_ID,))
            cur.execute(
                "SELECT action, audit_domain, old_data->>'role'"
                "  FROM public.digital_thread WHERE entity_type = 'user_roles'"
                " ORDER BY id DESC LIMIT 1;"
            )
            self.assertEqual(cur.fetchone(), ("ROLE_REVOKED", "security", "Administrator"))

    def test_a_settings_change_is_recorded(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT key FROM public.system_settings LIMIT 1;")
            row = cur.fetchone()
            if row is None:
                self.skipTest("no system_settings rows seeded")
            cur.execute(
                "UPDATE public.system_settings SET label = label || ' ' WHERE key = %s;", (row[0],)
            )
            cur.execute(
                "SELECT action, audit_domain FROM public.digital_thread"
                " WHERE entity_type = 'system_settings' ORDER BY id DESC LIMIT 1;"
            )
            self.assertEqual(cur.fetchone(), ("UPDATE", "security"))

    def test_the_grant_carries_an_actor_source(self):
        """`digital_thread` rows without one are unattributable, which 0005 exists to prevent."""
        with self.conn.cursor() as cur:
            row = self._security_row(cur)
            cur.execute("SELECT actor_source FROM public.digital_thread WHERE id = %s;", (row,))
            self.assertIn(cur.fetchone()[0], ("user", "service", "migration"))


class TheLaneIsEnforcedInPostgres(AuditDomainFixture):

    def _visible(self, cur, row_id):
        cur.execute("SELECT count(*) FROM public.digital_thread WHERE id = %s;", (row_id,))
        return cur.fetchone()[0] == 1

    def test_a_manager_cannot_read_a_role_grant(self):
        with self.conn.cursor() as cur:
            row = self._security_row(cur)
            as_user(cur, MANAGER_ID)
            self.assertFalse(
                self._visible(cur, row),
                "a Shopfloor_Manager can read the security lane. Hiding the section in the page "
                "would not have been an access control -- the row stays reachable through "
                "PostgREST with the same token."
            )

    def test_an_administrator_can_read_a_role_grant(self):
        with self.conn.cursor() as cur:
            row = self._security_row(cur)
            as_user(cur, ADMIN_ID)
            self.assertTrue(self._visible(cur, row))

    def test_an_auditor_can_read_a_role_grant(self):
        """
        The whole reason `Auditor` exists. It holds one permission, `digital_thread:read`, and
        until 0070 did nothing a read-only Administrator could not.
        """
        with self.conn.cursor() as cur:
            row = self._security_row(cur)
            as_user(cur, AUDITOR_ID)
            self.assertTrue(self._visible(cur, row))

    def test_a_manager_still_reads_the_asset_lane(self):
        """
        The refusal above must be about the LANE, not about the Manager losing the page. Their own
        shopfloor history is the thing this role opens the Digital Thread for.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM public.digital_thread WHERE audit_domain = 'asset'"
                " ORDER BY id DESC LIMIT 1;"
            )
            row = cur.fetchone()
            if row is None:
                self.skipTest("no asset rows recorded yet")
            as_user(cur, MANAGER_ID)
            self.assertTrue(self._visible(cur, row[0]))

    def test_a_manager_can_read_a_schema_change(self):
        """
        0120, end to end rather than on the classifier alone. The lane the dashboard offers a
        Shopfloor_Manager has to be one PostgreSQL will answer, or the filter is a promise the
        policy breaks.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.schemas (schema_name, schema_definition)"
                " VALUES ('Audit_Domain_Fixture_Schema', '{}'::jsonb);"
            )
            cur.execute(
                "SELECT id, audit_domain FROM public.digital_thread"
                " WHERE entity_type = 'schemas' ORDER BY id DESC LIMIT 1;"
            )
            row_id, domain = cur.fetchone()
            self.assertEqual(domain, "asset", "the schema INSERT was stamped into the wrong lane")

            as_user(cur, MANAGER_ID)
            self.assertTrue(
                self._visible(cur, row_id),
                "a Shopfloor_Manager cannot read a schema change. The Schemas filter is offered "
                "to that role, so this is a lane the page draws and the policy empties."
            )

    def test_a_manager_still_reads_a_gateway_credential_issue(self):
        """The authority rule, asserted end to end rather than only on the classifier."""
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM public.digital_thread WHERE action = 'CREDENTIAL_ISSUED'"
                " ORDER BY id DESC LIMIT 1;"
            )
            row = cur.fetchone()
            if row is None:
                self.skipTest("no CREDENTIAL_ISSUED rows recorded yet")
            as_user(cur, MANAGER_ID)
            self.assertTrue(
                self._visible(cur, row[0]),
                "a Shopfloor_Manager lost sight of a credential issue they are allowed to perform."
            )

    def test_an_operator_reads_neither_lane(self):
        """Unchanged by 0070, and worth pinning: splitting one policy into two can widen."""
        with self.conn.cursor() as cur:
            row = self._security_row(cur)
            cur.execute("SET LOCAL ROLE authenticated;")
            cur.execute('SET LOCAL "request.jwt.claims" = \'{"sub": "%s"}\';'
                        % "a0d17070-0000-4000-8000-00000000000e")
            self.assertFalse(self._visible(cur, row))
            cur.execute("SELECT count(*) FROM public.digital_thread;")
            self.assertEqual(cur.fetchone()[0], 0)

    def test_the_wide_policy_is_gone(self):
        """
        Permissive policies for one command are OR'd, so leaving the old one in place would grant
        Shopfloor_Manager the security lane through the back door -- and every test above would
        still pass, because they assert what the two new policies allow.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT policyname FROM pg_policies"
                " WHERE schemaname = 'public' AND tablename = 'digital_thread'"
                " ORDER BY policyname;"
            )
            self.assertEqual(
                [r[0] for r in cur.fetchall()],
                ["digital_thread_select_asset", "digital_thread_select_security"]
            )


class TheDashboardAgreesWithTheClassifier(unittest.TestCase):
    """
    THE GUARD THAT WAS MISSING, and the reason 0120 was a bug for as long as it was.

    The lane a kind belongs to is written down twice, in two languages: `audit_domain_for()`
    decides which rows PostgreSQL returns, and `DIGITAL_THREAD_ENTITY_TYPES` in constants.js
    decides which filters the page OFFERS -- `digitalThreadEntityTypesFor()` drops the security
    ones for a Shopfloor_Manager. Nothing compared them. `schemas` said `asset` on one side and
    took the fail-closed `security` on the other for twelve migrations, so the page offered a
    Manager a Schemas filter that the policy could only answer with an empty timeline.

    Only the JS side is read as text. The SQL side is the function itself, called, so this cannot
    drift into agreeing with a regex instead of with the database.
    """

    @classmethod
    def setUpClass(cls):
        cls.table, cls.entries = dashboard_lanes()

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def test_every_lane_was_parsed(self):
        """
        A regex that matches nothing passes every assertion below it.

        Counted against `kind:`, not against a number written here: a lane retired on purpose
        would fail a hardcoded floor, and a lane whose literal is reformatted past the regex is
        exactly the silent skip this is for.
        """
        declared = self.table.count("kind:")
        self.assertEqual(
            len(self.entries), declared,
            "DIGITAL_THREAD_ENTITY_TYPES declares %d lane(s) and this suite parsed %d -- the "
            "literal's shape changed, so the lanes it missed are going unchecked."
            % (declared, len(self.entries))
        )
        self.assertGreater(declared, 0, "DIGITAL_THREAD_ENTITY_TYPES parsed as empty")

    def test_each_lane_lands_where_the_page_says_it_will(self):
        with self.conn.cursor() as cur:
            for entry in self.entries:
                cur.execute("SELECT public.audit_domain_for(%s, 'UPDATE');", (entry["table"],))
                self.assertEqual(
                    cur.fetchone()[0], entry["domain"],
                    "constants.js files %s (%s) under '%s'; audit_domain_for() does not. The "
                    "filter dropdown and the RLS policy disagree, so that lane is either offered "
                    "to a role that gets nothing or withheld from one entitled to it."
                    % (entry["kind"], entry["table"], entry["domain"])
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
