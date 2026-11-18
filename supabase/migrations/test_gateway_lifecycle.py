# suite:
#   lanes: db
#   why: Walks docs/gateway-lifecycle.md. Every step of a gateway's life, for each type and from each
#     starting state the page lists, leaves the right gateway row, setup tokens, credential record and
#     revocation request behind. A step that leaves the wrong thing fails silently: a setup token that
#     still redeems for a gateway that is not Remote, a credential nobody asked the broker to disable,
#     a record that says a credential was issued while the broker refuses it. A row the code gets
#     wrong today is marked as expected to fail, so whoever fixes it has to remove the mark.

"""
What each gateway lifecycle step leaves behind, for each type (docs/gateway-lifecycle.md).

    python supabase/migrations/test_gateway_lifecycle.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

The tables of that page are held here, one class for each, and each test names the row it holds. The
steps a person takes are taken as a Shopfloor Manager would take them, through the `authenticated`
role: the clean-up triggers are SECURITY DEFINER because that role has no grant on the token table,
the Vault or the revocation call, and a test run as the owner would not notice one that stopped being.

WHAT THE BROKER IS TO THIS SUITE. A revocation is asked of the credential service through pg_net, so
it is the request in `net.http_request_queue` and the row in `gateway_revocation_requests` that are
asserted, with the stamp `credential_revoked_at`. The account itself, in Dynamic Security, is read by
supabase/functions/enroll-gateway/test_gateway_lifecycle_broker.py in the stack lane.

KNOWN BUGS. A row the code gets wrong today carries a `known_bug` mark with the bug's title, which is
unittest's `expectedFailure`: a test that fails is expected, and one that passes is an UNEXPECTED
SUCCESS, which fails the run. Whoever fixes the bug removes the mark and the key in the page.
pytest is not a dependency of the db lane, so it is not `pytest.mark.xfail(strict=True)`.

EVERY TEST ROLLS BACK. The suite writes Audit Trail rows and Vault secrets on purpose, and the audit
table cannot be pruned, so nothing it does is committed. net.http_post queues inside the caller's
transaction, so the rollback un-queues each revocation and nothing reaches a credential service.
`now()` is one instant inside a transaction, so a stamp that has to be older than an issue is set back.
"""
import json
import os
import re
import unittest
import uuid

import psycopg2
import psycopg2.errors
import psycopg2.extras

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# The two columns each selectable type writes, as utils/gatewayType.js's gatewayTypeFields().
TYPES = {
    "remote": ("remote", False),
    "third_party": ("third_party", False),
    "host": ("host", False),
    "simulated": ("host", True),
}
DASHBOARD_ISSUED = ("third_party", "host", "simulated")

# The Service_Ingestor machine principal (0046): the identity the daemon's token names.
INGESTION_PRINCIPAL = "b0000000-0000-4000-8000-000000000002"

# The six columns a proposal may carry for a gateway.
PROPOSABLE = ("name", "description", "cell_id", "area_id", "location_scope", "access_url")


def known_bug(title):
    """Mark a row the code gets wrong today, by the title of the bug that says so."""
    def mark(test):
        test.known_bug = title
        return unittest.expectedFailure(test)
    return mark


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class Lifecycle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.gateway_credential_was_replaced(public.gateways)');")
                if not cur.fetchone()[0]:
                    raise unittest.SkipTest("0288 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # REPEATABLE READ, so the queue counts the requests this test queued and nothing else:
        # pg_net's worker deleting a request it has sent would move a READ COMMITTED count.
        self.conn.set_session(isolation_level="REPEATABLE READ")
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        self.admin = self.person("Administrator")
        self.manager = self.person("Shopfloor_Manager")
        self.operator = self.person("Operator")

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- people and roles -------------------------------------------------------------------------

    def person(self, role):
        """A person who can sign in (an email), holding one role: audit_trail.changed_by is a key."""
        user_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO auth.users (instance_id, id, aud, role, email) "
            "VALUES ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s);",
            (user_id, f"{user_id}@gateway-lifecycle.test"))
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles WHERE name = %s;",
            (user_id, role))
        self.assertEqual(self.cur.rowcount, 1, f"role {role} is missing; 0001 did not run cleanly")
        return user_id

    def become(self, user_id):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;',
                         (json.dumps({"sub": user_id, "email": f"{user_id}@gateway-lifecycle.test"}),))

    def owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute('RESET "request.jwt.claims";')

    def as_(self, user_id, sql, args=None):
        """One statement as that person, and the rows it returns, if it returns any."""
        self.become(user_id)
        self.cur.execute(sql, args)
        rows = self.cur.fetchall() if self.cur.description else None
        self.owner()
        return rows

    def refused(self, user_id, sql, args=None, error=psycopg2.Error):
        """The statement is refused as that person, and the transaction goes on."""
        self.cur.execute("SAVEPOINT attempt;")
        self.become(user_id)
        try:
            with self.assertRaises(error) as caught:
                self.cur.execute(sql, args)
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
            self.owner()
        return caught.exception

    # -- gateways ---------------------------------------------------------------------------------

    def gateway(self, kind="remote", status="OFFLINE", enrolled=False, issued=False, token=False,
                kept_copy=False):
        """
        A gateway as a step leaves it. `issued` is the CREDENTIAL_ISSUED row a mint writes, an hour
        ago, and `kept_copy` the Vault copy beside it. `token` is a live setup token.
        """
        gid = str(uuid.uuid4())
        deployment, simulated = TYPES[kind]
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, description, deployment, is_simulated, status, enrolled_at)"
            " VALUES (%s, %s, 'gateway lifecycle suite', %s, %s, %s,"
            "         CASE WHEN %s THEN now() - interval '1 hour' END) RETURNING sparkplug_id;",
            (gid, f"Test_Lifecycle_{gid[:8]}", deployment, simulated, status, enrolled))
        sparkplug_id = self.cur.fetchone()["sparkplug_id"]
        if issued:
            self.record_issue(gid, minutes_ago=60)
        if kept_copy:
            self.cur.execute("SELECT vault.create_secret('not-a-real-password', %s, 'lifecycle suite');",
                             (f"gateway_broker_password:{gid}",))
        if token:
            self.token(gid)
        return gid, sparkplug_id

    def record_issue(self, gid, minutes_ago=0):
        """The CREDENTIAL_ISSUED row a mint leaves, as of `minutes_ago`."""
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data, changed_by,"
            "       actor_source, causation_id, recorded_at)"
            " VALUES ('gateways', %s, 'CREDENTIAL_ISSUED', NULL, '{}'::jsonb, NULL, 'service', txid_current(),"
            "         now() - make_interval(mins => %s));", (gid, minutes_ago))

    def token(self, gid, expires_in="30 minutes", created_ago="0 minutes"):
        """A setup token as issue_gateway_enrollment_token() writes it. Returns the raw value."""
        raw = uuid.uuid4().hex + uuid.uuid4().hex
        self.cur.execute(
            "INSERT INTO public.gateway_enrollment_tokens (gateway_id, token_hash, created_at, expires_at)"
            " VALUES (%s, encode(extensions.digest(%s, 'sha256'), 'hex'),"
            "         now() - %s::interval, now() + %s::interval);",
            (gid, raw, created_ago, expires_in))
        return raw

    def row(self, gid):
        self.cur.execute("SELECT * FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()

    def live_status(self, gid):
        self.cur.execute("SELECT live_status FROM public.gateway_status WHERE id = %s;", (gid,))
        return self.cur.fetchone()["live_status"]

    def tokens(self, gid):
        """(live, consumed): what the table holds for this gateway, expired or not."""
        self.cur.execute(
            "SELECT count(*) FILTER (WHERE consumed_at IS NULL) AS live,"
            "       count(*) FILTER (WHERE consumed_at IS NOT NULL) AS consumed"
            " FROM public.gateway_enrollment_tokens WHERE gateway_id = %s;", (gid,))
        row = self.cur.fetchone()
        return row["live"], row["consumed"]

    def holds_credential(self, gid):
        self.cur.execute(
            "SELECT public.gateway_has_broker_credential(g) AS held FROM public.gateways g WHERE g.id = %s;", (gid,))
        return self.cur.fetchone()["held"]

    def queue(self):
        """Every revocation and forge sweep this transaction has asked for, by the URL it was sent to."""
        self.cur.execute("SELECT count(*) AS n FROM net.http_request_queue;")
        return self.cur.fetchone()["n"]

    def revocations_asked(self, sparkplug_id):
        self.cur.execute(
            "SELECT count(*) AS n FROM net.http_request_queue"
            " WHERE url LIKE '%%/revoke-gateway-credential' AND position(%s::bytea IN body) > 0;",
            (sparkplug_id.encode(),))
        return self.cur.fetchone()["n"]

    def forge_sweeps_asked(self):
        self.cur.execute("SELECT count(*) AS n FROM net.http_request_queue WHERE url LIKE '%%/forge-sweep';")
        return self.cur.fetchone()["n"]

    def request_recorded(self, gid):
        self.cur.execute(
            "SELECT EXISTS (SELECT 1 FROM public.gateway_revocation_requests WHERE gateway_id = %s) AS found;", (gid,))
        return self.cur.fetchone()["found"]

    def copy_kept(self, gid):
        self.cur.execute("SELECT EXISTS (SELECT 1 FROM vault.secrets WHERE name = %s) AS found;",
                         (f"gateway_broker_password:{gid}",))
        return self.cur.fetchone()["found"]

    def trail(self, gid):
        self.cur.execute(
            "SELECT action, changed_by::text AS changed_by, new_data FROM public.audit_trail"
            " WHERE entity_id = %s ORDER BY id;", (gid,))
        return self.cur.fetchall()

    def actions(self, gid):
        return [r["action"] for r in self.trail(gid)]

    # -- the steps, as a person takes them --------------------------------------------------------

    def issue_setup(self, gid, user=None):
        rows = self.as_(user or self.manager, "SELECT token FROM public.issue_gateway_enrollment_token(%s, 30);", (gid,))
        return rows[0]["token"]

    def set_columns(self, gid, user=None, **columns):
        names = list(columns)
        sql = "UPDATE public.gateways SET " + ", ".join(f"{n} = %s" for n in names) + " WHERE id = %s;"
        self.as_(user or self.manager, sql, [columns[n] for n in names] + [gid])

    def change_type(self, gid, kind):
        deployment, simulated = TYPES[kind]
        self.set_columns(gid, deployment=deployment, is_simulated=simulated)

    def archive(self, gid, days=30):
        self.as_(self.manager,
                 "UPDATE public.gateways SET is_archived = true, archived_at = now(),"
                 " auto_delete_at = CASE WHEN %s::int IS NULL THEN NULL ELSE now() + make_interval(days => %s::int) END"
                 " WHERE id = %s;", (days, days, gid))

    def restore(self, gid):
        self.as_(self.manager,
                 "UPDATE public.gateways SET is_archived = false, archived_at = NULL, auto_delete_at = NULL"
                 " WHERE id = %s;", (gid,))

    def consume(self, raw):
        self.cur.execute("SELECT * FROM public.consume_gateway_enrollment_token(%s);", (raw,))
        return self.cur.fetchall()

    def peek(self, raw):
        self.cur.execute("SELECT * FROM public.peek_gateway_enrollment_token(%s);", (raw,))
        return self.cur.fetchall()

    def enrol(self, gid, raw):
        """What enroll-gateway does to the database: claim the token, then record the enrolment."""
        claimed = self.consume(raw)
        self.assertEqual(len(claimed), 1, "the token was not redeemable")
        self.cur.execute(
            "UPDATE public.gateways SET status = 'AWAITING_BIRTH', enrolled_at = now(), agent_version = '1.0.0'"
            " WHERE id = %s;", (gid,))
        return claimed[0]

    def first_heartbeat(self, gid, age="0 seconds"):
        """What the ingestion daemon writes on a node's first message: it is the one caller the gate admits."""
        self.as_(INGESTION_PRINCIPAL,
                 "SELECT public.ingest_record_gateway_health(%s::uuid, 'ONLINE', now() - %s::interval, NULL);", (gid, age))

    def issue_credential(self, gid, user=None, password="not-a-real-password"):
        """What gateway-credential asks of the database once the broker holds the account."""
        user = user or self.manager
        self.as_(user, "SELECT * FROM public.authorize_host_gateway_credential(%s);", (gid,))
        self.as_(user, "SELECT public.record_gateway_credential_issued(%s);", (gid,))
        return self.as_(user, "SELECT public.keep_gateway_credential(%s, %s) AS kept;", (gid, password))[0]["kept"]

    def old_stamp(self, gid, minutes=10):
        """Set the revocation stamp back, so a credential issued now is newer than it."""
        self.cur.execute(
            "UPDATE public.gateways SET credential_revoked_at = now() - make_interval(mins => %s) WHERE id = %s;",
            (minutes, gid))

    def a_machine(self):
        """A machine principal that may only propose."""
        rows = self.as_(
            self.admin,
            "SELECT principal_id::text AS principal_id FROM public.create_machine_principal(%s, ARRAY['proposal:create']::text[], 'lifecycle suite');",
            (f"Lifecycle suite {uuid.uuid4().hex[:8]}",))
        return rows[0]["principal_id"]

    PROPOSE = ("INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
               " VALUES ('gateways', %s, %s::jsonb, 'from the lifecycle suite') RETURNING id;")

    def a_machine_proposes(self, gid, patch):
        """A machine files a proposal against a gateway. Returns the machine and the proposal."""
        machine = self.a_machine()
        return machine, self.as_(machine, self.PROPOSE, (gid, json.dumps(patch)))[0]["id"]


# -------------------------------------------------------------------------------------------------
# Registration and setup
# -------------------------------------------------------------------------------------------------
class RegistrationAndSetup(Lifecycle):

    def test_register_leaves_every_type_offline_with_nothing_behind_it(self):
        for kind, (deployment, simulated) in TYPES.items():
            with self.subTest(kind=kind):
                gid = str(uuid.uuid4())
                self.as_(self.manager,
                         "INSERT INTO public.gateways (id, name, deployment, is_simulated) VALUES (%s, %s, %s, %s);",
                         (gid, f"Test_Register_{gid[:8]}", deployment, simulated))
                row = self.row(gid)
                self.assertEqual(row["status"], "OFFLINE")
                self.assertEqual(self.live_status(gid), "OFFLINE")
                self.assertIsNone(row["enrolled_at"])
                self.assertIsNone(row["credential_revoked_at"])
                self.assertEqual(self.tokens(gid), (0, 0))
                self.assertFalse(self.holds_credential(gid))
                self.assertFalse(self.request_recorded(gid))
                self.assertRegex(row["sparkplug_id"], r"^gwy[0-9a-f]{21}$")
                self.assertEqual(self.actions(gid), ["INSERT"])
                self.assertEqual(self.trail(gid)[0]["changed_by"], self.manager)

    def test_no_api_role_can_register_a_playback_gateway(self):
        self.refused(self.manager,
                     "INSERT INTO public.gateways (name, deployment, is_simulated, is_shadow)"
                     " VALUES ('Hand made playback', 'host', true, true);")

    def test_setup_moves_a_remote_gateway_to_awaiting_setup_with_one_live_token(self):
        gid, _ = self.gateway("remote")
        self.issue_setup(gid)
        self.assertEqual(self.row(gid)["status"], "PENDING_ENROLLMENT")
        self.assertEqual(self.live_status(gid), "PENDING_ENROLLMENT")
        self.assertEqual(self.tokens(gid), (1, 0))
        self.assertIsNone(self.row(gid)["enrolled_at"])
        self.assertFalse(self.holds_credential(gid))
        rows = self.trail(gid)
        self.assertEqual([r["action"] for r in rows], ["INSERT", "UPDATE"])
        self.assertEqual(rows[-1]["new_data"]["status"], "PENDING_ENROLLMENT")
        self.assertEqual(rows[-1]["changed_by"], self.manager)

    def test_a_token_lives_thirty_minutes_by_default_and_a_day_at_most(self):
        gid, _ = self.gateway("remote")
        self.issue_setup(gid)
        self.cur.execute(
            "SELECT expires_at - created_at AS span FROM public.gateway_enrollment_tokens WHERE gateway_id = %s;", (gid,))
        self.assertEqual(self.cur.fetchone()["span"].total_seconds(), 30 * 60)
        for minutes in (0, 1441):
            self.refused(self.manager, "SELECT * FROM public.issue_gateway_enrollment_token(%s, %s);", (gid, minutes),
                         psycopg2.errors.InvalidParameterValue)

    def test_a_second_setup_cancels_the_first_and_writes_no_row(self):
        gid, _ = self.gateway("remote")
        first = self.issue_setup(gid)
        rows = len(self.trail(gid))
        second = self.issue_setup(gid)
        self.assertNotEqual(first, second)
        self.assertEqual(self.tokens(gid), (1, 1))
        self.assertEqual(self.row(gid)["status"], "PENDING_ENROLLMENT")
        self.assertEqual(len(self.trail(gid)), rows, "the status did not change, so there is nothing to record")
        self.assertEqual(self.consume(first), [], "the cancelled token still redeems")
        self.assertEqual(len(self.consume(second)), 1)

    def test_setup_for_an_appliance_that_never_published_returns_it_to_awaiting_setup(self):
        gid, _ = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)
        enrolled_at = self.row(gid)["enrolled_at"]
        self.issue_setup(gid)
        row = self.row(gid)
        self.assertEqual(row["status"], "PENDING_ENROLLMENT")
        self.assertEqual(row["enrolled_at"], enrolled_at, "the enrolment is the record of the credential it holds")
        self.assertEqual(self.tokens(gid), (1, 0))
        self.assertEqual(self.actions(gid), ["INSERT", "UPDATE"])

    def test_setup_is_refused_to_every_type_that_is_not_remote(self):
        for kind in DASHBOARD_ISSUED:
            with self.subTest(kind=kind):
                gid, _ = self.gateway(kind)
                self.refused(self.manager, "SELECT * FROM public.issue_gateway_enrollment_token(%s, 30);", (gid,),
                             psycopg2.errors.InvalidParameterValue)
                self.assertEqual(self.tokens(gid), (0, 0))
                self.assertEqual(self.row(gid)["status"], "OFFLINE")

    def test_setup_is_refused_to_the_playback_gateway(self):
        self.cur.execute("SELECT id FROM public.gateways WHERE is_shadow ORDER BY created_at LIMIT 1;")
        gid = self.cur.fetchone()["id"]
        self.refused(self.manager, "SELECT * FROM public.issue_gateway_enrollment_token(%s, 30);", (gid,),
                     psycopg2.errors.InvalidParameterValue)

    def test_setup_is_a_manager_s_or_an_administrator_s_act(self):
        gid, _ = self.gateway("remote")
        self.refused(self.operator, "SELECT * FROM public.issue_gateway_enrollment_token(%s, 30);", (gid,),
                     psycopg2.errors.InsufficientPrivilege)
        self.issue_setup(gid, user=self.admin)
        self.assertEqual(self.tokens(gid), (1, 0))

    @known_bug("Issuing a setup token for an archived gateway succeeds and moves it to Awaiting setup")
    def test_setup_is_refused_to_an_archived_gateway(self):
        gid, _ = self.gateway("remote")
        self.archive(gid)
        self.refused(self.manager, "SELECT * FROM public.issue_gateway_enrollment_token(%s, 30);", (gid,),
                     psycopg2.errors.InvalidParameterValue)

    def test_an_unused_token_expires_and_the_gateway_goes_on_waiting(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT")
        raw = self.token(gid, expires_in="-90 minutes", created_ago="2 hours")
        self.assertEqual(self.consume(raw), [])
        self.assertEqual(self.peek(raw), [])
        self.assertEqual(self.tokens(gid), (1, 0), "an expired token is refused, not burned")
        self.assertEqual(self.row(gid)["status"], "PENDING_ENROLLMENT")
        self.assertEqual(self.live_status(gid), "PENDING_ENROLLMENT")
        self.assertEqual(self.actions(gid), ["INSERT"], "an expiry writes nothing")
        # Set up again is the way on.
        fresh = self.issue_setup(gid)
        self.assertEqual(self.tokens(gid), (1, 1))
        self.assertEqual(len(self.consume(fresh)), 1)


class Enrolment(Lifecycle):

    def test_enrolment_claims_the_token_and_records_an_enrolment_with_no_stamp(self):
        gid, sparkplug_id = self.gateway("remote")
        raw = self.issue_setup(gid)
        claimed = self.enrol(gid, raw)
        self.assertEqual((claimed["sparkplug_id"], claimed["gateway_id"]), (sparkplug_id, gid))
        row = self.row(gid)
        self.assertEqual(row["status"], "AWAITING_BIRTH")
        self.assertEqual(self.live_status(gid), "AWAITING_BIRTH")
        self.assertIsNotNone(row["enrolled_at"])
        self.assertIsNone(row["credential_revoked_at"])
        self.assertEqual(self.tokens(gid), (0, 1))
        self.assertTrue(self.holds_credential(gid))
        self.assertEqual(self.actions(gid), ["INSERT", "UPDATE", "UPDATE"])

    def test_one_token_has_one_winner(self):
        gid, _ = self.gateway("remote")
        raw = self.issue_setup(gid)
        self.assertEqual(len(self.consume(raw)), 1)
        self.assertEqual(self.consume(raw), [])

    def test_an_unknown_or_malformed_token_gets_no_rows(self):
        for raw in ("0" * 64, "not a token", "", "A" * 64):
            with self.subTest(raw=raw[:8]):
                self.assertEqual(self.consume(raw), [])
                self.assertEqual(self.peek(raw), [])

    def test_an_archived_gateway_is_not_enrolled(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT")
        self.archive(gid)
        raw = self.token(gid)
        self.assertEqual(self.peek(raw), [])
        self.assertEqual(self.consume(raw), [])
        self.assertEqual(self.tokens(gid), (1, 0), "a refused token is not burned")

    def test_a_gateway_that_is_not_remote_is_not_enrolled(self):
        for kind in DASHBOARD_ISSUED:
            with self.subTest(kind=kind):
                gid, _ = self.gateway(kind)
                raw = self.token(gid)
                self.assertEqual(self.peek(raw), [])
                self.assertEqual(self.consume(raw), [])
                self.assertEqual(self.tokens(gid), (1, 0))

    def test_the_first_birth_clears_the_waiting_state_of_every_type(self):
        for kind, status, enrolled in (("remote", "AWAITING_BIRTH", True), ("remote", "OFFLINE", True),
                                       ("third_party", "OFFLINE", False), ("host", "OFFLINE", False),
                                       ("simulated", "OFFLINE", False)):
            with self.subTest(kind=kind, status=status):
                gid, _ = self.gateway(kind, status=status, enrolled=enrolled)
                rows = len(self.trail(gid))
                self.first_heartbeat(gid)
                self.assertEqual(self.row(gid)["status"], "ONLINE")
                self.assertEqual(self.live_status(gid), "ONLINE")
                self.assertEqual(len(self.trail(gid)), rows + 1, "the change of status is one row")
                self.assertEqual(self.trail(gid)[-1]["new_data"]["status"], "ONLINE")
                self.first_heartbeat(gid)
                self.assertEqual(len(self.trail(gid)), rows + 1, "a heartbeat that changes no status writes no row")

    def test_a_silent_gateway_reads_stale_and_a_waiting_one_never_does(self):
        gid, _ = self.gateway("remote")
        self.first_heartbeat(gid, age="10 minutes")
        self.assertEqual(self.live_status(gid), "STALE")
        waiting, _ = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)
        self.cur.execute("UPDATE public.gateways SET last_heartbeat = now() - interval '1 hour' WHERE id = %s;", (waiting,))
        self.assertEqual(self.live_status(waiting), "AWAITING_BIRTH")


# -------------------------------------------------------------------------------------------------
# Credentials
# -------------------------------------------------------------------------------------------------
class Credentials(Lifecycle):

    def test_an_issue_records_it_keeps_a_copy_and_leaves_the_status_alone(self):
        for kind in DASHBOARD_ISSUED:
            with self.subTest(kind=kind):
                gid, _ = self.gateway(kind)
                self.assertFalse(self.holds_credential(gid))
                self.assertTrue(self.issue_credential(gid))
                self.assertTrue(self.holds_credential(gid))
                self.assertTrue(self.copy_kept(gid))
                row = self.row(gid)
                self.assertEqual(row["status"], "OFFLINE", "the gateway reads OFFLINE until it publishes")
                self.assertIsNone(row["enrolled_at"])
                self.assertIsNone(row["credential_revoked_at"])
                issued = [r for r in self.trail(gid) if r["action"] == "CREDENTIAL_ISSUED"]
                self.assertEqual(len(issued), 1)
                self.assertEqual(issued[0]["changed_by"], self.manager)
                self.assertNotIn("password", json.dumps(issued[0]["new_data"]))

    def test_issuing_again_replaces_the_copy_and_adds_a_row(self):
        gid, _ = self.gateway("host")
        self.issue_credential(gid, password="first-password-for-the-suite")
        self.issue_credential(gid, password="second-password-for-the-suite")
        self.assertEqual(self.actions(gid).count("CREDENTIAL_ISSUED"), 2)
        self.cur.execute("SELECT count(*) AS n FROM vault.secrets WHERE name = %s;", (f"gateway_broker_password:{gid}",))
        self.assertEqual(self.cur.fetchone()["n"], 1)
        shown = self.as_(self.admin, "SELECT * FROM public.show_gateway_credential(%s);", (gid,))[0]
        self.assertEqual(shown["password"], "second-password-for-the-suite")

    def test_showing_is_an_administrator_s_and_each_showing_is_a_row_without_the_password(self):
        gid, _ = self.gateway("third_party")
        self.issue_credential(gid)
        self.refused(self.manager, "SELECT * FROM public.show_gateway_credential(%s);", (gid,),
                     psycopg2.errors.InsufficientPrivilege)
        self.as_(self.admin, "SELECT * FROM public.show_gateway_credential(%s);", (gid,))
        shown = [r for r in self.trail(gid) if r["action"] == "CREDENTIAL_SHOWN"]
        self.assertEqual(len(shown), 1)
        self.assertEqual(shown[0]["changed_by"], self.admin)
        self.assertNotIn("password", json.dumps(shown[0]["new_data"]))
        self.assertEqual(self.row(gid)["status"], "OFFLINE")

    def test_the_credential_is_refused_to_a_remote_gateway(self):
        gid, _ = self.gateway("remote")
        self.refused(self.manager, "SELECT * FROM public.authorize_host_gateway_credential(%s);", (gid,),
                     psycopg2.errors.InvalidParameterValue)
        self.assertFalse(self.as_(self.manager, "SELECT public.keep_gateway_credential(%s, 'x') AS kept;", (gid,))[0]["kept"])

    def test_the_credential_is_refused_to_an_archived_gateway_of_every_type(self):
        for kind in DASHBOARD_ISSUED:
            with self.subTest(kind=kind):
                gid, _ = self.gateway(kind)
                self.archive(gid)
                self.refused(self.manager, "SELECT * FROM public.authorize_host_gateway_credential(%s);", (gid,),
                             psycopg2.errors.InvalidParameterValue)
                self.assertFalse(self.as_(self.manager, "SELECT public.keep_gateway_credential(%s, 'x') AS kept;", (gid,))[0]["kept"])

    def test_the_credential_is_a_manager_s_act(self):
        gid, _ = self.gateway("host")
        self.refused(self.operator, "SELECT * FROM public.authorize_host_gateway_credential(%s);", (gid,),
                     psycopg2.errors.InsufficientPrivilege)

    def test_the_playback_gateway_is_issued_one_and_keeps_no_copy(self):
        self.cur.execute("SELECT id FROM public.gateways WHERE is_shadow ORDER BY created_at LIMIT 1;")
        gid = self.cur.fetchone()["id"]
        self.as_(self.manager, "SELECT * FROM public.authorize_host_gateway_credential(%s);", (gid,))
        self.assertFalse(self.as_(self.manager, "SELECT public.keep_gateway_credential(%s, 'x') AS kept;", (gid,))[0]["kept"],
                         "the worker is handed its password, so no copy is kept")

    def test_a_credential_issued_after_a_revocation_outranks_its_stamp(self):
        gid, _ = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)
        self.change_type(gid, "host")
        self.old_stamp(gid)
        stamp = self.row(gid)["credential_revoked_at"]
        self.assertFalse(self.holds_credential(gid), "nothing has been issued to the Host gateway yet")
        self.issue_credential(gid)
        self.assertTrue(self.holds_credential(gid))
        self.assertEqual(self.row(gid)["credential_revoked_at"], stamp, "the stamp is older, and stays")


# -------------------------------------------------------------------------------------------------
# Changing the type
# -------------------------------------------------------------------------------------------------
# A starting state of each type, and what it holds: (kind, state) -> how to build it, and whether it
# holds a broker credential under its type.
REMOTE_STATES = {
    "unset": dict(status="OFFLINE"),
    "pending": dict(status="PENDING_ENROLLMENT", token=True),
    "awaiting_birth": dict(status="AWAITING_BIRTH", enrolled=True),
    "online": dict(status="ONLINE", enrolled=True),
}
ISSUED_STATES = {
    "plain": dict(),
    "issued": dict(status="ONLINE", issued=True, kept_copy=True),
}


class ChangingTheType(Lifecycle):

    def test_every_change_ends_what_the_page_says_it_ends(self):
        starts = [(kind, state, spec) for kind in ("remote",) for state, spec in REMOTE_STATES.items()]
        starts += [(kind, state, spec) for kind in DASHBOARD_ISSUED for state, spec in ISSUED_STATES.items()]
        for kind, state, spec in starts:
            for end in TYPES:
                if end == kind:
                    continue
                with self.subTest(start=f"{kind}/{state}", end=end):
                    self.cur.execute("SAVEPOINT walk;")
                    gid, sparkplug_id = self.gateway(kind, **spec)
                    holds = self.holds_credential(gid)
                    status = self.row(gid)["status"]
                    crosses = (kind == "remote") != (end == "remote")
                    rows = len(self.trail(gid))

                    self.change_type(gid, end)

                    row = self.row(gid)
                    asked = self.revocations_asked(sparkplug_id)
                    self.assertEqual(len(self.trail(gid)), rows + 1, "the change and what it ended are one row")
                    if not crosses:
                        self.assertEqual((row["status"], asked, row["credential_revoked_at"]), (status, 0, None))
                        self.assertEqual(self.tokens(gid)[0], 1 if spec.get("token") else 0)
                        self.assertEqual(self.copy_kept(gid), bool(spec.get("kept_copy")))
                        self.assertEqual(self.holds_credential(gid), holds)
                    else:
                        self.assertEqual(self.tokens(gid)[0], 0, "a setup token outlived the type that issued it")
                        self.assertEqual(asked, 1 if holds else 0, "revocation is asked for what the old type held, and only that")
                        self.assertEqual(row["credential_revoked_at"] is not None, holds)
                        self.assertEqual(self.request_recorded(gid), holds)
                        self.assertFalse(self.copy_kept(gid))
                        expected = "OFFLINE" if end == "remote" or status in ("PENDING_ENROLLMENT", "AWAITING_BIRTH") else status
                        self.assertEqual(row["status"], expected)
                    self.cur.execute("ROLLBACK TO SAVEPOINT walk;")

    def test_the_change_is_one_row_by_the_person_that_made_it(self):
        gid, _ = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)
        self.change_type(gid, "third_party")
        rows = self.trail(gid)
        self.assertEqual(rows[-1]["action"], "UPDATE")
        self.assertEqual(rows[-1]["changed_by"], self.manager)
        self.assertEqual(rows[-1]["new_data"]["deployment"], "third_party")
        self.assertEqual(rows[-1]["new_data"]["status"], "OFFLINE")
        self.assertIsNotNone(rows[-1]["new_data"]["credential_revoked_at"])

    def test_a_setup_token_issued_before_the_change_does_not_redeem_after_it(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT")
        raw = self.issue_setup(gid)
        self.change_type(gid, "host")
        self.assertEqual(self.consume(raw), [])
        self.assertEqual(self.peek(raw), [])

    def test_saving_the_type_it_has_ends_nothing(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT", token=True)
        self.change_type(gid, "remote")
        self.assertEqual(self.tokens(gid), (1, 0))
        self.assertEqual(self.row(gid)["status"], "PENDING_ENROLLMENT")

    def test_the_playback_gateway_cannot_leave_its_type(self):
        self.cur.execute("SELECT id FROM public.gateways WHERE is_shadow ORDER BY created_at LIMIT 1;")
        gid = self.cur.fetchone()["id"]
        for kind in ("remote", "third_party", "host"):
            with self.subTest(kind=kind):
                deployment, simulated = TYPES[kind]
                self.refused(self.manager,
                             "UPDATE public.gateways SET deployment = %s, is_simulated = %s WHERE id = %s;",
                             (deployment, simulated, gid), psycopg2.errors.CheckViolation)
        self.change_type(gid, "simulated")
        self.assertTrue(self.row(gid)["is_shadow"])

    def test_the_clean_up_leaves_an_archived_gateway_alone(self):
        gid, sparkplug_id = self.gateway("host", issued=True, kept_copy=True)
        self.archive(gid)
        asked = self.revocations_asked(sparkplug_id)
        self.change_type(gid, "remote")
        self.assertEqual(self.revocations_asked(sparkplug_id), asked, "an archived gateway's credential was ended when it was archived")

    @known_bug("Changing the type of an archived gateway leaves the old type's status behind")
    def test_an_archived_remote_gateway_changed_to_host_reads_offline_when_restored(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT", token=True)
        self.archive(gid)
        self.change_type(gid, "host")
        self.restore(gid)
        self.assertEqual(self.row(gid)["status"], "OFFLINE")

    @known_bug("gateway_has_broker_credential() counts a Remote gateway's enrolment after the credential was revoked")
    def test_a_remote_gateway_changed_away_and_back_holds_no_credential(self):
        gid, sparkplug_id = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)
        self.change_type(gid, "host")
        self.change_type(gid, "remote")
        self.old_stamp(gid)
        self.assertFalse(self.holds_credential(gid), "the credential was revoked and the appliance has not enrolled again")

    @known_bug("gateway_has_broker_credential() counts a Remote gateway's enrolment after the credential was revoked")
    def test_leaving_remote_again_asks_for_no_second_revocation(self):
        gid, sparkplug_id = self.gateway("remote", status="AWAITING_BIRTH", enrolled=True)
        self.change_type(gid, "host")
        self.change_type(gid, "remote")
        before = self.revocations_asked(sparkplug_id)
        self.change_type(gid, "host")
        self.assertEqual(self.revocations_asked(sparkplug_id), before)


# -------------------------------------------------------------------------------------------------
# Renaming and changing the group
# -------------------------------------------------------------------------------------------------
class RenamingAndTheGroup(Lifecycle):

    def untouched_by(self, kind, change):
        """Take the step, and prove nothing else about the gateway moved."""
        spec = REMOTE_STATES["pending"] if kind == "remote" else ISSUED_STATES["issued"]
        gid, sparkplug_id = self.gateway(kind, **spec)
        before = self.row(gid)
        tokens, queue, copy, rows = self.tokens(gid), self.queue(), self.copy_kept(gid), len(self.trail(gid))
        change(gid)
        after = self.row(gid)
        for column in ("status", "enrolled_at", "credential_revoked_at", "deployment", "is_simulated", "is_archived",
                       "sparkplug_id", "forge_repository_at"):
            self.assertEqual(after[column], before[column], column)
        self.assertEqual((self.tokens(gid), self.queue(), self.copy_kept(gid)), (tokens, queue, copy))
        self.assertEqual(len(self.trail(gid)), rows + 1)
        self.assertEqual(self.trail(gid)[-1]["action"], "UPDATE")
        self.assertEqual(self.trail(gid)[-1]["changed_by"], self.manager)
        return gid, after

    def test_a_rename_changes_the_name_and_nothing_else_of_every_type(self):
        for kind in TYPES:
            with self.subTest(kind=kind):
                gid, after = self.untouched_by(kind, lambda g: self.set_columns(g, name="Renamed by the suite " + kind))
                self.assertEqual(after["name"], "Renamed by the suite " + kind)

    def test_a_group_change_moves_the_address_and_nothing_else_of_every_type(self):
        for kind in TYPES:
            with self.subTest(kind=kind):
                gid, after = self.untouched_by(kind, lambda g: self.set_columns(g, sparkplug_group="Another group"))
                self.assertEqual(after["sparkplug_group"], "Another group")

    def test_a_token_redeemed_after_a_group_change_carries_the_new_group(self):
        gid, sparkplug_id = self.gateway("remote")
        raw = self.issue_setup(gid)
        self.set_columns(gid, sparkplug_group="Moved group")
        claimed = self.consume(raw)
        self.assertEqual((claimed[0]["sparkplug_id"], claimed[0]["sparkplug_group"]), (sparkplug_id, "Moved group"))

    def test_the_group_is_never_empty_and_never_a_topic_wildcard(self):
        gid, _ = self.gateway("host")
        for group in ("", "a/b", "a+b", "a#b"):
            with self.subTest(group=group):
                self.refused(self.manager, "UPDATE public.gateways SET sparkplug_group = %s WHERE id = %s;", (group, gid),
                             psycopg2.errors.CheckViolation)

    def test_the_sparkplug_id_is_issued_identity_and_cannot_be_written(self):
        gid, _ = self.gateway("host")
        self.refused(self.manager, "UPDATE public.gateways SET sparkplug_id = 'gwy000000000000000000000' WHERE id = %s;",
                     (gid,))


# -------------------------------------------------------------------------------------------------
# Archive, restore, auto-delete and delete
# -------------------------------------------------------------------------------------------------
class Archiving(Lifecycle):

    def test_archiving_a_remote_gateway_never_enrolled_cancels_its_token_and_asks_for_nothing(self):
        gid, sparkplug_id = self.gateway("remote", status="PENDING_ENROLLMENT", token=True)
        self.archive(gid, days=30)
        row = self.row(gid)
        self.assertTrue(row["is_archived"])
        self.assertIsNotNone(row["archived_at"])
        self.assertIsNotNone(row["auto_delete_at"])
        self.assertEqual(row["status"], "PENDING_ENROLLMENT")
        self.assertEqual(self.tokens(gid), (0, 1))
        self.assertEqual(self.revocations_asked(sparkplug_id), 0, "no account was ever issued, so none is asked for")
        self.assertIsNone(row["credential_revoked_at"])
        self.assertEqual(self.actions(gid), ["INSERT", "UPDATE"])
        self.assertEqual(self.trail(gid)[-1]["changed_by"], self.manager)

    def test_archiving_an_enrolled_remote_gateway_asks_for_its_account_and_stamps_it(self):
        gid, sparkplug_id = self.gateway("remote", status="ONLINE", enrolled=True)
        self.archive(gid)
        self.assertEqual(self.revocations_asked(sparkplug_id), 1)
        self.assertTrue(self.request_recorded(gid), "no request was recorded for the sweep to judge")
        self.assertIsNotNone(self.row(gid)["credential_revoked_at"])
        self.assertEqual(self.row(gid)["status"], "ONLINE", "the broker's drop of the session is what makes it OFFLINE")

    def test_archiving_a_dashboard_issued_gateway_with_a_credential_asks_stamps_and_forgets_the_copy(self):
        for kind in DASHBOARD_ISSUED:
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.gateway(kind, **ISSUED_STATES["issued"])
                self.assertTrue(self.copy_kept(gid))
                self.archive(gid)
                self.assertEqual(self.revocations_asked(sparkplug_id), 1)
                self.assertIsNotNone(self.row(gid)["credential_revoked_at"])
                self.assertFalse(self.copy_kept(gid), "the password of an ended credential can still be shown")

    def test_archiving_a_gateway_that_holds_no_credential_asks_for_nothing(self):
        for kind in DASHBOARD_ISSUED:
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.gateway(kind)
                self.archive(gid)
                self.assertEqual(self.revocations_asked(sparkplug_id), 0)
                self.assertIsNone(self.row(gid)["credential_revoked_at"])

    def test_archiving_asks_the_forge_only_for_a_gateway_that_has_a_repository(self):
        gid, _ = self.gateway("remote", status="ONLINE", enrolled=True)
        self.archive(gid)
        self.assertEqual(self.forge_sweeps_asked(), 0, "no repository, nothing in the forge to follow")
        with_repository, _ = self.gateway("remote", status="ONLINE", enrolled=True)
        self.cur.execute("UPDATE public.gateways SET forge_repository_at = now() WHERE id = %s;", (with_repository,))
        self.archive(with_repository)
        self.assertEqual(self.forge_sweeps_asked(), 1)

    def test_the_only_playback_gateway_cannot_be_archived(self):
        self.cur.execute("SELECT id FROM public.gateways WHERE is_shadow AND NOT is_archived ORDER BY created_at LIMIT 1;")
        gid = self.cur.fetchone()["id"]
        self.refused(self.manager, "UPDATE public.gateways SET is_archived = true WHERE id = %s;", (gid,))

    def test_an_archived_gateway_cannot_be_enrolled_or_issued_a_credential(self):
        remote, _ = self.gateway("remote", status="PENDING_ENROLLMENT")
        self.archive(remote)
        self.assertEqual(self.consume(self.token(remote)), [])
        host, _ = self.gateway("host")
        self.archive(host)
        self.refused(self.manager, "SELECT * FROM public.authorize_host_gateway_credential(%s);", (host,),
                     psycopg2.errors.InvalidParameterValue)


class Restoring(Lifecycle):

    def test_restoring_a_remote_gateway_never_enrolled_returns_it_to_awaiting_setup(self):
        gid, _ = self.gateway("remote", status="PENDING_ENROLLMENT", token=True)
        self.archive(gid)
        self.restore(gid)
        row = self.row(gid)
        self.assertFalse(row["is_archived"])
        self.assertIsNone(row["archived_at"])
        self.assertIsNone(row["auto_delete_at"], "restoring clears the timer rather than pausing it")
        self.assertEqual(row["status"], "PENDING_ENROLLMENT")
        self.assertEqual(self.tokens(gid), (0, 1), "a cancelled token does not come back")
        self.assertEqual(self.actions(gid), ["INSERT", "UPDATE", "UPDATE"])
        # It is set up again with a fresh one.
        self.assertEqual(len(self.consume(self.issue_setup(gid))), 1)

    def test_restoring_asks_the_broker_for_nothing_and_does_not_re_enable_an_account(self):
        for kind, spec in (("remote", REMOTE_STATES["online"]), ("host", ISSUED_STATES["issued"])):
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.gateway(kind, **spec)
                self.archive(gid)
                asked = self.revocations_asked(sparkplug_id)
                self.restore(gid)
                self.assertEqual(self.revocations_asked(sparkplug_id), asked)
                self.assertEqual(self.row(gid)["status"], spec.get("status", "OFFLINE"))

    def test_restoring_does_not_bring_back_the_copy_of_a_password(self):
        gid, _ = self.gateway("host", **ISSUED_STATES["issued"])
        self.archive(gid)
        self.restore(gid)
        self.assertFalse(self.copy_kept(gid))

    def test_restoring_asks_the_forge_to_take_the_repository_back_out(self):
        gid, _ = self.gateway("remote", status="ONLINE", enrolled=True)
        self.cur.execute("UPDATE public.gateways SET forge_repository_at = now() WHERE id = %s;", (gid,))
        self.archive(gid)
        before = self.forge_sweeps_asked()
        self.restore(gid)
        self.assertEqual(self.forge_sweeps_asked(), before + 1)

    def test_a_restored_gateway_is_issued_a_credential_again(self):
        gid, _ = self.gateway("host", **ISSUED_STATES["issued"])
        self.archive(gid)
        self.restore(gid)
        self.old_stamp(gid)
        self.assertTrue(self.issue_credential(gid))
        self.assertTrue(self.holds_credential(gid))

    @known_bug("Restoring a gateway clears its credential's revocation stamp while the broker account stays disabled")
    def test_restoring_an_enrolled_remote_gateway_keeps_its_credential_revoked(self):
        gid, _ = self.gateway("remote", status="ONLINE", enrolled=True)
        self.archive(gid)
        self.assertIsNotNone(self.row(gid)["credential_revoked_at"])
        self.restore(gid)
        self.assertIsNotNone(self.row(gid)["credential_revoked_at"],
                             "the account is still disabled, and the record now says it is not")

    @known_bug("Restoring a gateway clears its credential's revocation stamp while the broker account stays disabled")
    def test_restoring_a_dashboard_issued_gateway_does_not_count_its_old_credential_again(self):
        gid, _ = self.gateway("host", **ISSUED_STATES["issued"])
        self.archive(gid)
        self.restore(gid)
        self.assertFalse(self.holds_credential(gid), "the account is disabled until a credential is issued again")


class DeletingAndAutoDeleting(Lifecycle):

    def purge(self):
        """The retention job, as the database holds it."""
        self.cur.execute("SELECT command FROM cron.job WHERE jobname = 'purge_expired_archives';")
        command = self.cur.fetchone()["command"]
        self.assertIn("DELETE FROM public.gateways", command)
        self.cur.execute(command)

    def expire(self, gid):
        self.cur.execute("UPDATE public.gateways SET auto_delete_at = now() - interval '1 hour' WHERE id = %s;", (gid,))

    def test_the_retention_job_deletes_an_archived_gateway_whose_timer_ran_out_and_no_other(self):
        due, _ = self.gateway("host", issued=True)
        self.archive(due)
        self.expire(due)
        never, _ = self.gateway("host")
        self.archive(never, days=None)
        later, _ = self.gateway("host")
        self.archive(later, days=30)
        active, _ = self.gateway("host")
        self.purge()
        self.assertIsNone(self.row_or_none(due), "the timer ran out")
        for kept in (never, later, active):
            self.assertIsNotNone(self.row_or_none(kept))

    def row_or_none(self, gid):
        self.cur.execute("SELECT * FROM public.gateways WHERE id = %s;", (gid,))
        return self.cur.fetchone()

    def test_the_retention_job_asks_for_an_enrolled_remote_gateway_s_account_once_more(self):
        gid, sparkplug_id = self.gateway("remote", status="ONLINE", enrolled=True)
        self.archive(gid)
        self.expire(gid)
        before = self.revocations_asked(sparkplug_id)
        self.purge()
        self.assertIsNone(self.row_or_none(gid))
        self.assertEqual(self.revocations_asked(sparkplug_id), before + 1)
        self.assertEqual(self.actions(gid)[-1], "DELETE")

    def test_a_deleted_gateway_takes_its_tokens_and_its_copy_and_leaves_a_tombstone_if_it_was_archived(self):
        gid, _ = self.gateway("host", **ISSUED_STATES["issued"])
        archived, _ = self.gateway("remote", status="PENDING_ENROLLMENT", token=True)
        self.archive(archived)
        self.as_(self.manager, "DELETE FROM public.gateways WHERE id = %s;", (archived,))
        self.assertEqual(self.tokens(archived), (0, 0))
        self.cur.execute("SELECT count(*) AS n FROM public.retired_entities WHERE entity_id = %s;", (archived,))
        self.assertEqual(self.cur.fetchone()["n"], 1)
        self.as_(self.manager, "DELETE FROM public.gateways WHERE id = %s;", (gid,))
        self.assertFalse(self.copy_kept(gid))
        self.cur.execute("SELECT count(*) AS n FROM public.retired_entities WHERE entity_id = %s;", (gid,))
        self.assertEqual(self.cur.fetchone()["n"], 0, "a gateway that never went through the lifecycle leaves no tombstone")
        self.assertEqual(self.actions(gid)[-1], "DELETE")
        self.assertEqual(self.trail(gid)[-1]["changed_by"], self.manager)

    def test_deleting_a_gateway_that_holds_a_credential_asks_for_its_account(self):
        for kind, spec in (("remote", REMOTE_STATES["awaiting_birth"]), ("third_party", ISSUED_STATES["issued"]),
                           ("host", ISSUED_STATES["issued"]), ("simulated", ISSUED_STATES["issued"])):
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.gateway(kind, **spec)
                self.as_(self.manager, "DELETE FROM public.gateways WHERE id = %s;", (gid,))
                self.assertEqual(self.revocations_asked(sparkplug_id), 1)

    def test_deleting_a_gateway_that_holds_none_asks_for_nothing(self):
        for kind, spec in (("remote", REMOTE_STATES["pending"]), ("host", ISSUED_STATES["plain"])):
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.gateway(kind, **spec)
                self.as_(self.manager, "DELETE FROM public.gateways WHERE id = %s;", (gid,))
                self.assertEqual(self.revocations_asked(sparkplug_id), 0)

    def test_the_playback_gateway_is_never_deleted(self):
        self.cur.execute("SELECT id FROM public.gateways WHERE is_shadow ORDER BY created_at LIMIT 1;")
        gid = self.cur.fetchone()["id"]
        self.refused(self.manager, "DELETE FROM public.gateways WHERE id = %s;", (gid,))


# -------------------------------------------------------------------------------------------------
# Proposals
# -------------------------------------------------------------------------------------------------
class Proposals(Lifecycle):

    def test_a_machine_proposes_a_rename_and_a_person_applies_it_with_nothing_else_moving(self):
        for kind in TYPES:
            with self.subTest(kind=kind):
                spec = REMOTE_STATES["pending"] if kind == "remote" else ISSUED_STATES["issued"]
                gid, sparkplug_id = self.gateway(kind, **spec)
                before = self.row(gid)
                tokens, queue, copy = self.tokens(gid), self.queue(), self.copy_kept(gid)
                machine, proposal = self.a_machine_proposes(gid, {"name": f"Proposed {kind}", "description": "by a machine"})

                self.as_(self.manager, "SELECT public.approve_proposal(%s);", (proposal,))

                after = self.row(gid)
                self.assertEqual((after["name"], after["description"]), (f"Proposed {kind}", "by a machine"))
                for column in ("status", "enrolled_at", "credential_revoked_at", "deployment", "is_simulated", "is_archived",
                               "sparkplug_id", "sparkplug_group"):
                    self.assertEqual(after[column], before[column], column)
                self.assertEqual((self.tokens(gid), self.queue(), self.copy_kept(gid)), (tokens, queue, copy))
                actions = self.actions(gid)
                self.assertEqual(actions.count("PROPOSAL_APPLIED"), 1)
                self.assertEqual(self.trail(gid)[-1]["action"], "PROPOSAL_APPLIED")
                applied = [r for r in self.trail(gid) if r["action"] == "PROPOSAL_APPLIED"][0]
                self.assertEqual(applied["changed_by"], self.manager)
                self.assertEqual(applied["new_data"]["proposed_by"], machine)
                self.assertEqual(applied["new_data"]["approved_by"], self.manager)
                updates = [r for r in self.trail(gid) if r["action"] == "UPDATE" and r["changed_by"] == self.manager]
                self.assertEqual(len(updates), 1, "the approval writes the columns once, as the approver")

    def test_a_machine_cannot_decide_its_own_proposal(self):
        gid, _ = self.gateway("host")
        machine, proposal = self.a_machine_proposes(gid, {"name": "Proposed by a machine"})
        self.refused(machine, "SELECT public.approve_proposal(%s);", (proposal,), psycopg2.errors.InsufficientPrivilege)
        self.assertNotEqual(self.row(gid)["name"], "Proposed by a machine")

    def test_a_proposal_cannot_carry_a_type_a_group_an_archive_a_status_or_a_credential(self):
        gid, _ = self.gateway("remote")
        machine = self.a_machine()
        for column, value in (("deployment", "host"), ("is_simulated", True), ("sparkplug_group", "Elsewhere"),
                              ("is_archived", True), ("status", "ONLINE"), ("credential_revoked_at", "2026-01-01T00:00:00Z"),
                              ("enrolled_at", "2026-01-01T00:00:00Z"), ("auto_delete_at", "2026-01-01T00:00:00Z")):
            with self.subTest(column=column):
                self.refused(machine, self.PROPOSE, (gid, json.dumps({column: value})), psycopg2.errors.InvalidParameterValue)

    def test_the_columns_a_proposal_may_carry_are_the_six_the_page_names(self):
        self.cur.execute("SELECT public.proposable_columns('gateways') AS columns;")
        self.assertEqual(sorted(self.cur.fetchone()["columns"]), sorted(PROPOSABLE))


# -------------------------------------------------------------------------------------------------
# The page and the code agree about what they name
# -------------------------------------------------------------------------------------------------
class TheTypesTheDatabaseAdmits(Lifecycle):

    def test_the_deployment_constraint_admits_exactly_the_three_values_the_page_has_a_row_for(self):
        self.cur.execute(
            "SELECT public.live_constraint_definition('public.gateways'::regclass, 'gateways_deployment_valid') AS definition;")
        admitted = set(re.findall(r"'([a-z_]+)'::text", self.cur.fetchone()["definition"]))
        self.assertEqual(admitted, {"host", "remote", "third_party"},
                         "a new deployment type needs a row in docs/gateway-lifecycle.md and a walk here")


if __name__ == "__main__":
    unittest.main(verbosity=2)
