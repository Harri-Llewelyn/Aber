"""
A machine has a name an operator gave it (0125), and holds what a machine may (0013).

    python supabase/migrations/test_machine_principal_naming.py

Requires the Supabase database (54322 by default) and 0022 applied; `npm run test:db` gives it a
throwaway one.

---------------------------------------------------------------------------------------------
THREE THINGS, EACH PINNED WHERE IT COULD DRIFT.

`create_machine_principal()` takes a name and writes `machine_principals` IN THE SAME TRANSACTION
as the `auth.users` row, so a principal created from the page cannot exist without one. A blank or
duplicate name is refused before anything exists, and the refusal names the name rather than a
constraint.

The 0080 two-argument form is GONE, not overloaded. PostgREST resolves an RPC by the argument
names in the body, and an overload whose extra arguments default makes every old-shape call
ambiguous (a 300 rather than a row). 0080 recreates that form on every boot; 0125 drops it on
every boot; this asserts the order held.

The name table reads for Administrator and Auditor, the two roles that label the audit lane, and
for nobody else. No write policy: the create function is the only write path at creation, and
`describe_machine_principal()` (0126) the only one after it -- Administrator only, rows that exist
only, and every change a PRINCIPAL_DESCRIBED row carrying what it replaced.

MACHINES PROPOSE, PEOPLE DECIDE (0013). Every permission is either on the allow-list or refused
with its own reason. What an allowed grant opens is exercised as the machine itself: schema:manage
forks, publishes and discards; proposal:create files a proposal that only a person can decide;
digital_thread:read reads the asset lane and never the security lane; archive:manage reads the
record of deleted assets. A revoked identity or token is refused before its write runs, the way
PostgREST runs auth_pre_request() ahead of every request.

A machine's write is filed as a service's whatever X-Aber-Actor header it sends (0020), and the
person deciding its proposal can read its name (0022) without being able to read the name table.

EVERY TEST ROLLS BACK. The fixtures are seeded inside the test's own transaction, and
`SET LOCAL ROLE` scopes the impersonation to it, so nothing is committed and nothing needs
cleaning up. `is_machine_principal()` is "no email, no password, no identity provider", so the
HUMAN fixtures carry an email or 0080's trigger would refuse them a role.
"""

import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors
import psycopg2.extras

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ALLOWED = ("telemetry:read", "quarantine:view", "digital_thread:read",
           "archive:manage", "proposal:create", "schema:manage")

# Every other permission, and the reason create_machine_principal() gives for refusing it.
REFUSED = {
    "device:manage": "device writes are made by people",
    "quarantine:approve": "quarantine decisions are made by people",
    "quarantine:reject": "quarantine decisions are made by people",
    "cell:manage": "for a machine it would only decide change proposals, and deciding is a "
                   "person's act: machines propose, people decide",
    "gateway:manage": "for a machine it would only decide change proposals, and deciding is a "
                      "person's act: machines propose, people decide",
    "authz:manage": "access control stays with people",
    "link:manage": "no check a machine passes consults it",
    "gitops:manage": "no check a machine passes consults it",
}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class NamingBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regclass('public.machine_principals');")
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("0125 has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        self.admin = self.person("Administrator")
        self.auditor = self.person("Auditor")
        self.manager = self.person("Shopfloor_Manager")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------

    def person(self, role):
        """An auth.users row that can sign in (it has an email), holding one role."""
        user_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.users (instance_id, id, aud, role, email) "
            "VALUES ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s);",
            (user_id, f"{user_id}@naming.test"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) "
            "SELECT %s, id FROM public.roles WHERE name = %s;",
            (user_id, role),
        )
        self.assertEqual(self.cur.rowcount, 1, f"role {role} is missing; 0001 did not run cleanly")
        return user_id

    def as_user(self, user_id):
        """Become `authenticated` with a JWT subject, the way PostgREST does it: claims only."""
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))

    def as_postgres(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute('RESET "request.jwt.claims";')

    def create(self, name, permissions=("telemetry:read",), purpose=None):
        self.cur.execute(
            "SELECT * FROM public.create_machine_principal(%s, %s::text[], %s);",
            (name, list(permissions), purpose),
        )
        return self.cur.fetchone()


class TheNameIsWrittenWithTheIdentity(NamingBase):

    def test_a_created_principal_carries_its_name_and_purpose(self):
        self.as_user(self.admin)
        row = self.create("Line 4 OEE report", ALLOWED, "Reads the hourly rollup for the OEE board.")
        # 0080's return shape, kept: a changed return type cannot ship under a name 0080 replays.
        self.assertEqual(sorted(row.keys()), ["permissions", "principal_id"])
        self.assertEqual(sorted(row["permissions"]), sorted(ALLOWED))

        self.as_postgres()
        self.cur.execute(
            "SELECT name, purpose, created_by FROM public.machine_principals WHERE principal_id = %s;",
            (row["principal_id"],),
        )
        stored = self.cur.fetchone()
        self.assertEqual(stored["name"], "Line 4 OEE report")
        self.assertEqual(stored["purpose"], "Reads the hourly rollup for the OEE board.")
        self.assertEqual(str(stored["created_by"]), self.admin)

        # STILL A MACHINE: the name lives in its own table, and the auth.users row carries only
        # an id, which is what keeps is_machine_principal() true and the account unable to sign in.
        self.cur.execute("SELECT public.is_machine_principal(%s);", (row["principal_id"],))
        self.assertTrue(self.cur.fetchone()["is_machine_principal"])

    def test_the_audit_row_carries_the_name(self):
        self.as_user(self.admin)
        row = self.create("Kiln telemetry mirror", purpose="  ")
        self.as_postgres()
        self.cur.execute(
            "SELECT new_data, changed_by FROM public.digital_thread "
            "WHERE entity_type = 'service_principals' AND entity_id = %s AND action = 'INSERT';",
            (row["principal_id"],),
        )
        audit = self.cur.fetchone()
        self.assertIsNotNone(audit, "create_machine_principal() wrote no audit row")
        self.assertEqual(audit["new_data"]["name"], "Kiln telemetry mirror")
        # A purpose of whitespace is no purpose, on the row and in the thread alike.
        self.assertIsNone(audit["new_data"]["purpose"])
        self.assertEqual(str(audit["changed_by"]), self.admin)

    def test_the_name_is_trimmed_and_the_purpose_emptied_to_null(self):
        self.as_user(self.admin)
        row = self.create("  Trimmed  ", purpose="")
        self.as_postgres()
        self.cur.execute(
            "SELECT name, purpose FROM public.machine_principals WHERE principal_id = %s;",
            (row["principal_id"],),
        )
        stored = self.cur.fetchone()
        self.assertEqual(stored["name"], "Trimmed")
        self.assertIsNone(stored["purpose"])


class WhatIsRefusedAndWhenNothingExists(NamingBase):

    def _refused(self, errcls, name, permissions=("telemetry:read",), purpose=None):
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(errcls) as ctx:
            self.create(name, permissions, purpose)
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        return str(ctx.exception)

    def _machine_count(self):
        self.as_postgres()
        self.cur.execute(
            "SELECT count(*) AS n FROM auth.users u WHERE public.is_machine_principal(u.id);"
        )
        return self.cur.fetchone()["n"]

    def test_a_blank_name_is_refused_before_anything_exists(self):
        before = self._machine_count()
        self.as_user(self.admin)
        message = self._refused(psycopg2.errors.InvalidParameterValue, "   ")
        self.assertIn("name is required", message)
        self.assertEqual(self._machine_count(), before)

    def test_a_duplicate_name_is_refused_ignoring_case_and_whitespace(self):
        self.as_user(self.admin)
        self.create("Line 4 SCADA reader")
        before_users = self._machine_count()
        self.as_user(self.admin)
        message = self._refused(psycopg2.errors.UniqueViolation, "  line 4 scada READER ")
        self.assertIn("already exists", message)
        # The refusal came from the function's own check, which names the name, and not from the
        # index -- and either way, no second identity was made.
        self.assertEqual(self._machine_count(), before_users)

    def test_a_name_over_eighty_characters_is_refused(self):
        self.as_user(self.admin)
        self._refused(psycopg2.errors.InvalidParameterValue, "x" * 81)

    def test_a_permission_outside_the_allow_list_is_still_refused(self):
        self.as_user(self.admin)
        message = self._refused(
            psycopg2.errors.InvalidParameterValue, "Writer", ("device:manage",)
        )
        self.assertIn("not grantable", message)

    def test_no_permission_is_still_refused(self):
        self.as_user(self.admin)
        self._refused(psycopg2.errors.InvalidParameterValue, "Empty", ())

    def test_a_shopfloor_manager_is_refused(self):
        self.as_user(self.manager)
        self._refused(psycopg2.errors.InsufficientPrivilege, "Not yours")

    def test_the_table_refuses_a_blank_name_on_its_own(self):
        """The CHECK constraint, not only the function: a future write path meets the same rule."""
        machine = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (machine,))
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute(
                "INSERT INTO public.machine_principals (principal_id, name) VALUES (%s, '  ');",
                (machine,),
            )
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")


class EachRefusalGivesItsReason(NamingBase):
    """0013: every permission is allowed or refused, and a refusal says which rule refused it."""

    def _refusal(self, name, permissions):
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as ctx:
            self.create(name, permissions)
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        return ctx.exception.diag.message_primary

    def test_every_permission_has_been_decided_for_machines(self):
        self.cur.execute("SELECT name FROM public.permissions;")
        names = {r["name"] for r in self.cur.fetchall()}
        self.assertEqual(
            sorted(names - set(ALLOWED) - set(REFUSED)), [],
            "a permission nobody decided for machines: create_machine_principal() refuses it with "
            "no stated reason until it is allowed or given one",
        )
        self.assertEqual(sorted(set(ALLOWED) | set(REFUSED)), sorted(names))

    def test_each_refused_permission_gets_its_own_reason(self):
        self.as_user(self.admin)
        for perm, reason in REFUSED.items():
            with self.subTest(permission=perm):
                message = self._refusal(f"Wants {perm}", [perm])
                self.assertIn("not grantable to a machine identity", message)
                self.assertIn(f"{perm} ({reason}", message)
                # The premise that stopped being true is not the reason any more.
                self.assertNotIn("revoked", message)

    def test_several_are_named_once_each_in_the_order_asked(self):
        self.as_user(self.admin)
        message = self._refusal(
            "Mixed", ["telemetry:read", "cell:manage", "device:manage", "cell:manage"]
        )
        self.assertEqual(message.count("cell:manage ("), 1)
        self.assertLess(message.index("cell:manage ("), message.index("device:manage ("))
        self.assertNotIn("telemetry:read (", message)

    def test_a_name_that_is_no_permission_says_so(self):
        self.as_user(self.admin)
        self.assertIn("telemetry:reed (no such permission)",
                      self._refusal("Typo", ["telemetry:reed"]))

    def test_all_six_are_granted_together(self):
        self.as_user(self.admin)
        principal = self.create("Holds all six", ALLOWED)["principal_id"]
        self.as_postgres()
        self.cur.execute(
            "SELECT p.name FROM public.principal_permissions pp "
            "JOIN public.permissions p ON p.id = pp.permission_id WHERE pp.principal_id = %s;",
            (principal,),
        )
        self.assertEqual(sorted(r["name"] for r in self.cur.fetchall()), sorted(ALLOWED))


class MachineBase(NamingBase):
    """A machine created by the Administrator fixture, acted as the way PostgREST does."""

    def machine(self, name, permissions):
        self.as_user(self.admin)
        principal = str(self.create(name, permissions)["principal_id"])
        self.as_postgres()
        return principal

    def seed_schema(self):
        """An active v1 schema, seeded as the owner so the provenance trigger allows it."""
        self.cur.execute(
            "INSERT INTO public.schemas (schema_name, description, schema_definition) "
            "VALUES (%s, 'machine principal fixture', '{\"type\": \"object\"}'::jsonb) "
            "RETURNING id::text;",
            (f"MACHINE_PRINCIPAL_{uuid.uuid4().hex[:12]}",),
        )
        return self.cur.fetchone()["id"]

    def refused(self, errcls, sql, params=()):
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(errcls) as ctx:
            self.cur.execute(sql, params)
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        return ctx.exception.diag.message_primary


class AMachineMayVersionASchema(MachineBase):
    """schema:manage reaches a machine through has_authority() in the three schema RPCs."""

    def setUp(self):
        super().setUp()
        self.root = self.seed_schema()
        self.writer = self.machine("Schema sync", ("schema:manage",))
        self.reader = self.machine("Schema reader", ("telemetry:read",))

    def test_a_machine_holding_it_forks_publishes_and_discards(self):
        self.as_user(self.writer)
        self.cur.execute("SELECT public.fork_schema(%s, 'from the sync job') AS draft;", (self.root,))
        draft = self.cur.fetchone()["draft"]
        self.assertEqual(draft["status"], "draft")
        self.cur.execute("SELECT public.publish_schema_version(%s) AS published;", (draft["id"],))
        self.assertEqual(self.cur.fetchone()["published"]["schema"]["status"], "active")
        self.cur.execute("SELECT public.fork_schema(%s) AS draft;", (draft["id"],))
        second = self.cur.fetchone()["draft"]
        self.cur.execute("SELECT public.discard_schema_draft(%s) AS discarded;", (second["id"],))
        self.assertEqual(self.cur.fetchone()["discarded"]["discarded_schema_id"], second["id"])

        # The thread names the machine and files the act as a service's, never as a person's.
        self.as_postgres()
        self.cur.execute(
            "SELECT changed_by::text, actor_source FROM public.digital_thread "
            "WHERE entity_type = 'schemas' AND entity_id = %s AND action = 'INSERT';",
            (draft["id"],),
        )
        self.assertEqual(self.cur.fetchone(), {"changed_by": self.writer, "actor_source": "service"})

    def test_a_machine_without_it_is_refused_each_rpc(self):
        self.as_user(self.reader)
        for sql in ("SELECT public.fork_schema(%s);",
                    "SELECT public.publish_schema_version(%s);",
                    "SELECT public.discard_schema_draft(%s);"):
            with self.subTest(sql=sql):
                self.refused(psycopg2.errors.InsufficientPrivilege, sql, (self.root,))
        self.as_postgres()
        self.cur.execute(
            "SELECT count(*) AS n FROM public.schemas WHERE parent_schema_id = %s;", (self.root,)
        )
        self.assertEqual(self.cur.fetchone()["n"], 0)

    def test_it_still_cannot_write_the_table_directly(self):
        # The write policies on `schemas` name Administrator, which no machine holds.
        self.as_user(self.writer)
        self.cur.execute(
            "UPDATE public.schemas SET description = 'edited' WHERE id = %s;", (self.root,)
        )
        self.assertEqual(self.cur.rowcount, 0)


class AMachineIsFiledAsAServiceWhateverItDeclares(MachineBase):
    """
    0020: log_digital_thread_event() believes an X-Aber-Actor header only from the caller it
    describes. PostgREST exposes the header as the request.headers GUC, which is what is set here.
    """

    INGESTOR = "b0000000-0000-4000-8000-000000000002"

    def setUp(self):
        super().setUp()
        self.root = self.seed_schema()
        self.writer = self.machine("Declaring writer", ("schema:manage",))

    def declare(self, value):
        self.cur.execute('SET LOCAL "request.headers" = %s;', (json.dumps({"x-aber-actor": value}),))

    def filed_as(self, draft_id):
        self.as_postgres()
        self.cur.execute(
            "SELECT changed_by::text, actor_source FROM public.digital_thread "
            "WHERE entity_type = 'schemas' AND entity_id = %s AND action = 'INSERT';",
            (draft_id,),
        )
        return self.cur.fetchone()

    def cell_filed_as(self):
        """Insert a cell in the session as it stands, and read how its audit row was filed."""
        cell = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, %s);",
                         (cell, f"Declared {cell[:8]}"))
        self.as_postgres()
        self.cur.execute(
            "SELECT actor_source FROM public.digital_thread "
            "WHERE entity_type = 'cells' AND entity_id = %s AND action = 'INSERT';",
            (cell,),
        )
        return self.cur.fetchone()["actor_source"]

    def test_a_machine_is_a_service_whatever_it_declares(self):
        for value in ("migration", "ingestion", "service", "user", "a-cron-job"):
            with self.subTest(header=value):
                # Each fork undone, so the root has no draft for the next value to collide with.
                self.cur.execute("SAVEPOINT declared;")
                try:
                    self.as_user(self.writer)
                    self.declare(value)
                    self.cur.execute("SELECT public.fork_schema(%s) AS draft;", (self.root,))
                    draft = self.cur.fetchone()["draft"]
                    self.assertEqual(self.filed_as(draft["id"]),
                                     {"changed_by": self.writer, "actor_source": "service"})
                finally:
                    self.cur.execute("ROLLBACK TO SAVEPOINT declared;")

    def test_the_ingestion_principal_is_still_believed(self):
        # The daemon's own identity and header, as ingestion.py sends them.
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;',
                         (json.dumps({"sub": self.INGESTOR}),))
        self.declare("ingestion")
        self.assertEqual(self.cell_filed_as(), "ingestion")

    def test_the_service_key_cannot_claim_a_migration(self):
        # A JWT with no `sub`, as the edge functions' service-role client sends.
        self.cur.execute("SET LOCAL ROLE service_role;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;',
                         (json.dumps({"role": "service_role"}),))
        self.declare("migration")
        self.assertEqual(self.cell_filed_as(), "service")

    def test_the_owner_session_with_no_token_may(self):
        # No JWT at all: the owner's session, here acting as service_role, which on its own would
        # be filed as a service.
        self.cur.execute("SET LOCAL ROLE service_role;")
        self.declare("migration")
        self.assertEqual(self.cell_filed_as(), "migration")


class AMachineProposesAndAPersonDecides(MachineBase):
    """proposal:create reaches a machine through the change_proposals INSERT policy; deciding does not."""

    def setUp(self):
        super().setUp()
        self.cell = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.cells (id, name) VALUES (%s, %s);",
            (self.cell, f"Machine proposal cell {self.cell[:8]}"),
        )
        self.proposer = self.machine("Line planner", ("proposal:create",))
        self.bystander = self.machine("Line reader", ("telemetry:read",))

    def propose(self, who):
        self.as_user(who)
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale) "
            "VALUES ('cells', %s, %s::jsonb, 'from the planner') RETURNING id;",
            (self.cell, json.dumps({"description": "Moved by the planner"})),
        )
        return self.cur.fetchone()["id"]

    def test_a_machine_holding_it_files_a_proposal(self):
        proposal = self.propose(self.proposer)
        self.as_postgres()
        self.cur.execute(
            "SELECT proposed_by::text, status FROM public.change_proposals WHERE id = %s;",
            (proposal,),
        )
        self.assertEqual(self.cur.fetchone(), {"proposed_by": self.proposer, "status": "open"})

    def test_a_machine_without_it_is_refused(self):
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.propose(self.bystander)
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")

    def test_the_machine_cannot_decide_it_and_a_person_can(self):
        proposal = self.propose(self.proposer)
        self.as_user(self.proposer)
        self.refused(psycopg2.errors.InsufficientPrivilege,
                     "SELECT public.approve_proposal(%s);", (proposal,))
        self.refused(psycopg2.errors.InsufficientPrivilege,
                     "SELECT public.reject_proposal(%s, 'no');", (proposal,))

        self.as_user(self.manager)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        self.as_postgres()
        self.cur.execute("SELECT description FROM public.cells WHERE id = %s;", (self.cell,))
        self.assertEqual(self.cur.fetchone()["description"], "Moved by the planner")


class WhoeverDecidesReadsTheMachinesName(MachineBase):
    """
    0022: list_proposer_names() names the machine behind each proposal the caller may decide, by
    may_decide_proposal(). machine_principals itself stays closed to a Shopfloor_Manager.
    """

    def setUp(self):
        super().setUp()
        self.operator = self.person("Operator")
        self.cell = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.cells (id, name) VALUES (%s, %s);",
            (self.cell, f"Named proposer cell {self.cell[:8]}"),
        )
        self.planner = self.machine("Line 3 scheduler", ("proposal:create",))
        self.idle = self.machine("Proposes nothing", ("proposal:create",))
        self.propose(self.planner, {"description": "Moved by the scheduler"})

    def propose(self, who, patch):
        self.as_user(who)
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
            "VALUES ('cells', %s, %s::jsonb) RETURNING id;",
            (self.cell, json.dumps(patch)),
        )
        proposal = self.cur.fetchone()["id"]
        self.as_postgres()
        return proposal

    def names_for(self, who):
        self.as_user(who)
        self.cur.execute("SELECT principal_id::text, name FROM public.list_proposer_names();")
        names = {r["principal_id"]: r["name"] for r in self.cur.fetchall()}
        self.as_postgres()
        return names

    def test_a_shopfloor_manager_reads_the_name_of_the_machine_that_proposed(self):
        self.assertEqual(self.names_for(self.manager), {self.planner: "Line 3 scheduler"})

    def test_a_decided_proposal_still_names_its_machine(self):
        # The Decided list shows the proposer as well as the queue does.
        self.cur.execute(
            "SELECT id FROM public.change_proposals WHERE proposed_by = %s;", (self.planner,)
        )
        proposal = self.cur.fetchone()["id"]
        self.as_user(self.manager)
        self.cur.execute("SELECT public.reject_proposal(%s, 'not this week');", (proposal,))
        self.as_postgres()
        self.assertEqual(self.names_for(self.manager), {self.planner: "Line 3 scheduler"})

    def test_an_operator_who_may_not_decide_gets_nothing(self):
        self.assertEqual(self.names_for(self.operator), {})

    def test_an_auditor_who_may_not_decide_gets_nothing(self):
        # The Auditor reads machine_principals directly; this function answers for deciders only.
        self.assertEqual(self.names_for(self.auditor), {})

    def test_the_machine_itself_gets_nothing(self):
        self.assertEqual(self.names_for(self.planner), {})

    def test_a_person_who_proposed_has_no_row(self):
        # A person is named by the email the proposal carries; only machines are listed.
        self.propose(self.operator, {"description": "Moved by hand"})
        self.assertEqual(set(self.names_for(self.manager)), {self.planner})

    def test_anon_cannot_call_it(self):
        self.cur.execute("SET LOCAL ROLE anon;")
        self.refused(psycopg2.errors.InsufficientPrivilege,
                     "SELECT * FROM public.list_proposer_names();")


class AMachineReadsTheAssetLaneOnly(MachineBase):
    """digital_thread:read opens the asset lane to a machine, never the security lane."""

    def setUp(self):
        super().setUp()
        # Seeded as the owner; the audit_domain trigger files each by its entity type.
        self.rows = {}
        for entity_type in ("devices", "service_principals"):
            self.cur.execute(
                "INSERT INTO public.digital_thread (entity_type, entity_id, action, actor_source) "
                "VALUES (%s, %s, 'UPDATE', 'service') RETURNING id, entity_id::text, audit_domain;",
                (entity_type, str(uuid.uuid4())),
            )
            row = self.cur.fetchone()
            self.rows[row["audit_domain"]] = row
        self.assertEqual(sorted(self.rows), ["asset", "security"])
        self.reader = self.machine("Thread reader", ("digital_thread:read",))
        self.other = self.machine("No thread", ("telemetry:read",))

    def visible(self, who):
        self.as_user(who)
        self.cur.execute(
            "SELECT id FROM public.digital_thread WHERE id = ANY(%s);",
            ([r["id"] for r in self.rows.values()],),
        )
        seen = {r["id"] for r in self.cur.fetchall()}
        self.as_postgres()
        return seen

    def test_it_reads_the_asset_lane_and_not_the_security_lane(self):
        self.assertEqual(self.visible(self.reader), {self.rows["asset"]["id"]})

    def test_without_it_a_machine_reads_neither(self):
        self.assertEqual(self.visible(self.other), set())

    def test_the_paged_read_agrees(self):
        # digital_thread_page() is SECURITY INVOKER, so the same policy decides what it returns.
        self.as_user(self.reader)
        self.cur.execute(
            "SELECT public.digital_thread_page(p_limit => 50, p_include_purged => true, "
            "p_entity_ids => %s::uuid[]) AS page;",
            ([r["entity_id"] for r in self.rows.values()],),
        )
        events = self.cur.fetchone()["page"]["events"]
        self.assertEqual([e["id"] for e in events], [self.rows["asset"]["id"]])


class AMachineReadsTheRecordOfDeletedAssets(MachineBase):
    """archive:manage reaches a machine through the retired_entities SELECT policy, and no further."""

    def setUp(self):
        super().setUp()
        self.retired = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.retired_entities (entity_type, entity_id, name, old_data) "
            "VALUES ('devices', %s, 'Retired press', '{}'::jsonb);",
            (self.retired,),
        )
        self.archivist = self.machine("Archive mirror", ("archive:manage",))
        self.other = self.machine("Not an archivist", ("telemetry:read",))

    def seen_by(self, who):
        self.as_user(who)
        self.cur.execute(
            "SELECT count(*) AS n FROM public.retired_entities WHERE entity_id = %s;",
            (self.retired,),
        )
        n = self.cur.fetchone()["n"]
        self.as_postgres()
        return n

    def test_it_reads_the_record_and_a_machine_without_it_does_not(self):
        self.assertEqual(self.seen_by(self.archivist), 1)
        self.assertEqual(self.seen_by(self.other), 0)


class ARevokedMachineCannotWrite(MachineBase):
    """
    PostgREST runs auth_pre_request() before every request, in the request's transaction, and a
    raise there aborts it. `request()` does the same, so a refusal here is a write that never ran.
    """

    def setUp(self):
        super().setUp()
        self.root = self.seed_schema()
        self.writer = self.machine("Revocable writer", ("schema:manage",))

    def request(self, sql, params=(), jti=None):
        claims = {"sub": self.writer, **({"jti": jti} if jti else {})}
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps(claims),))
        self.cur.execute("SELECT public.auth_pre_request();")
        self.cur.execute(sql, params)
        return self.cur.fetchone()

    def fork_refused(self, jti=None):
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as ctx:
            self.request("SELECT public.fork_schema(%s);", (self.root,), jti)
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        return ctx.exception.diag.message_primary

    def drafts(self):
        self.as_postgres()
        self.cur.execute(
            "SELECT count(*) AS n FROM public.schemas WHERE parent_schema_id = %s;", (self.root,)
        )
        return self.cur.fetchone()["n"]

    def mint(self):
        """A recorded token, as mint-service-token records one."""
        jti = str(uuid.uuid4())
        self.as_postgres()
        self.cur.execute(
            "SELECT public.record_service_token_issued(%s::uuid, %s, now() + interval '30 days');",
            (self.writer, jti),
        )
        return jti

    def test_before_revocation_the_write_runs(self):
        self.request("SELECT public.fork_schema(%s);", (self.root,), self.mint())
        self.assertEqual(self.drafts(), 1)

    def test_a_revoked_identity_is_refused_before_its_write_runs(self):
        self.as_user(self.admin)
        self.cur.execute("SELECT public.revoke_service_principal(%s, 'decommissioned');", (self.writer,))
        self.assertIn("identity has been revoked", self.fork_refused())
        self.assertEqual(self.drafts(), 0)

    def test_a_revoked_token_is_refused_and_another_still_works(self):
        withdrawn, kept = self.mint(), self.mint()
        self.as_user(self.admin)
        self.cur.execute("SELECT public.revoke_service_token(%s);", (withdrawn,))
        self.assertIn("token has been revoked", self.fork_refused(withdrawn))
        self.assertEqual(self.drafts(), 0)
        self.request("SELECT public.fork_schema(%s);", (self.root,), kept)
        self.assertEqual(self.drafts(), 1)


class TheOldFormIsGoneNotOverloaded(NamingBase):

    def test_exactly_one_declaration_and_it_takes_a_name(self):
        self.cur.execute(
            "SELECT pg_get_function_identity_arguments(p.oid) AS args "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'public' AND p.proname = 'create_machine_principal';"
        )
        args = [r["args"] for r in self.cur.fetchall()]
        self.assertEqual(
            args, ["p_name text, p_permissions text[], p_purpose text"],
            "a second declaration makes every RPC call ambiguous at PostgREST; 0080's "
            "two-argument form must be dropped by 0125 on every boot",
        )

    def test_the_two_argument_call_no_longer_resolves(self):
        self.as_user(self.admin)
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.UndefinedFunction):
            self.cur.execute(
                "SELECT * FROM public.create_machine_principal(%s::text[], %s);",
                (["telemetry:read"], "a note"),
            )
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")


class WhoMayReadTheNames(NamingBase):

    def setUp(self):
        super().setUp()
        self.as_user(self.admin)
        self.named = self.create("Visible to auditors")["principal_id"]
        self.as_postgres()

    def _visible_to(self, user_id):
        self.as_user(user_id)
        self.cur.execute(
            "SELECT count(*) AS n FROM public.machine_principals WHERE principal_id = %s;",
            (self.named,),
        )
        n = self.cur.fetchone()["n"]
        self.as_postgres()
        return n

    def test_administrator_and_auditor_read_it(self):
        self.assertEqual(self._visible_to(self.admin), 1)
        self.assertEqual(self._visible_to(self.auditor), 1)

    def test_a_shopfloor_manager_sees_nothing(self):
        # Zero rows rather than an error: RLS on a SELECT filters. The page treats an empty map as
        # "no names", which is what a Manager is also refused by list_machine_principals().
        self.assertEqual(self._visible_to(self.manager), 0)

    def test_no_write_policy_exists(self):
        self.as_user(self.admin)
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "UPDATE public.machine_principals SET name = 'Renamed' WHERE principal_id = %s;",
                (self.named,),
            )
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")

    def test_deleting_the_identity_takes_the_name_with_it(self):
        self.cur.execute("DELETE FROM auth.users WHERE id = %s;", (self.named,))
        self.cur.execute(
            "SELECT count(*) AS n FROM public.machine_principals WHERE principal_id = %s;",
            (self.named,),
        )
        self.assertEqual(self.cur.fetchone()["n"], 0)


class ANameCanBeChangedAgain(NamingBase):
    """0126: describe_machine_principal() is the one write path after creation."""

    def setUp(self):
        super().setUp()
        self.as_user(self.admin)
        self.subject = self.create("Before", purpose="Old purpose")["principal_id"]
        self.other = self.create("Taken")["principal_id"]
        self.as_postgres()

    def describe(self, principal_id, name, purpose=None):
        self.cur.execute(
            "SELECT public.describe_machine_principal(%s, %s, %s) AS audit_id;",
            (principal_id, name, purpose),
        )
        return self.cur.fetchone()["audit_id"]

    def _refused(self, errcls, principal_id, name, purpose=None):
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(errcls) as ctx:
            self.describe(principal_id, name, purpose)
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        return str(ctx.exception)

    def _row(self, principal_id):
        self.as_postgres()
        self.cur.execute(
            "SELECT name, purpose FROM public.machine_principals WHERE principal_id = %s;",
            (principal_id,),
        )
        return self.cur.fetchone()

    def test_the_row_changes_and_the_thread_keeps_what_it_replaced(self):
        self.as_user(self.admin)
        audit_id = self.describe(self.subject, "  After  ", "New purpose")
        self.assertIsNotNone(audit_id)
        self.assertEqual(self._row(self.subject), {"name": "After", "purpose": "New purpose"})
        self.cur.execute(
            "SELECT action, old_data, new_data, changed_by FROM public.digital_thread WHERE id = %s;",
            (audit_id,),
        )
        audit = self.cur.fetchone()
        self.assertEqual(audit["action"], "PRINCIPAL_DESCRIBED")
        self.assertEqual(audit["old_data"], {"name": "Before", "purpose": "Old purpose"})
        self.assertEqual(audit["new_data"], {"name": "After", "purpose": "New purpose"})
        self.assertEqual(str(audit["changed_by"]), self.admin)

    def test_an_unchanged_save_writes_nothing(self):
        self.as_user(self.admin)
        self.assertIsNone(self.describe(self.subject, "Before", "Old purpose"))
        # A purpose of whitespace is the same as the stored NULL would be, but here the stored
        # purpose is text, so only an identical pair is "unchanged".
        self.as_postgres()
        self.cur.execute(
            "SELECT count(*) AS n FROM public.digital_thread "
            "WHERE entity_id = %s AND action = 'PRINCIPAL_DESCRIBED';",
            (self.subject,),
        )
        self.assertEqual(self.cur.fetchone()["n"], 0)

    def test_keeping_ones_own_name_is_not_a_collision(self):
        self.as_user(self.admin)
        self.assertIsNotNone(self.describe(self.subject, "before", "Old purpose"))
        self.assertEqual(self._row(self.subject)["name"], "before")

    def test_another_rows_name_is_refused(self):
        self.as_user(self.admin)
        message = self._refused(psycopg2.errors.UniqueViolation, self.subject, " taken ")
        self.assertIn("already exists", message)
        self.assertEqual(self._row(self.subject)["name"], "Before")

    def test_a_pinned_identity_has_no_row_to_describe(self):
        # A machine principal with no machine_principals row, as the three pinned ones are.
        pinned = str(uuid.uuid4())
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (pinned,))
        self.as_user(self.admin)
        message = self._refused(psycopg2.errors.InvalidParameterValue, pinned, "Renamed")
        self.assertIn("no name row", message)

    def test_a_person_cannot_be_described(self):
        self.as_user(self.admin)
        message = self._refused(psycopg2.errors.InvalidParameterValue, self.auditor, "Renamed")
        self.assertIn("not a machine principal", message)

    def test_a_shopfloor_manager_is_refused(self):
        self.as_user(self.manager)
        self._refused(psycopg2.errors.InsufficientPrivilege, self.subject, "Renamed")
        self.assertEqual(self._row(self.subject)["name"], "Before")

    def test_a_blank_name_is_refused(self):
        self.as_user(self.admin)
        self._refused(psycopg2.errors.InvalidParameterValue, self.subject, "   ")


if __name__ == "__main__":
    unittest.main(verbosity=2)
