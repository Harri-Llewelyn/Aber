# suite:
#   lanes: stack
#   why: The broker's half of the gateway lifecycle table (docs/gateway-lifecycle.md). Only the live
#     broker has Dynamic Security, so only a stack can say whether an account is enabled, disabled or
#     absent after a step, and whether the platform's record agrees. A Host and a Third-party gateway
#     are issued, re-issued, archived, restored and deleted; a Remote gateway is enrolled through
#     enroll-gateway, type-changed, archived, restored and deleted. A revocation the
#     broker never received is asked again after the gateway is archived and deleted. A record that
#     says a credential is held while the broker refuses it, or the reverse, is silent: nothing errors
#     and the gateway just stays out. Needs no gateway online: it connects as the account it has just
#     made, once, to a probe topic. SKIPS, with its reason, without the stack, the seeded
#     Administrator or the credential service's token in its container.

"""
The broker's account against the platform's record, after each lifecycle step (docs/gateway-lifecycle.md).

    SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_PUBLISHABLE_KEY=... python \
        supabase/functions/enroll-gateway/test_gateway_lifecycle_broker.py

Requires the stack up, the service-role key and the publishable key (as test_enroll_gateway.py does),
the seeded Administrator (a setup token and a credential are issued as a person issues them), and a
credential service that holds its token in its own container.

WHAT IT COMPARES. After every step it reads the gateway's client from the credential service's
inventory (the broker's own list, read inside the service's container with the token that container
holds) and asks the database two questions: whether `gateway_has_broker_credential()` says the
gateway holds a credential, and what `credential_revoked_at` says. The record and the broker must
agree: a held credential is an account that exists and is enabled, and a revoked one is an account
that is disabled or was never made. A step whose record and broker disagree is the finding.

WHAT IT MAKES. Every gateway is named `Test_Lifecycle_Broker_...`. A crashed run leaves rows the next
run reclaims by that name, deleted as a person deletes them, so the revocation lands before the
account is removed. When the class ends it deletes each gateway it made and each broker account, in
that order, whatever happened. A revocation is waited for until the credential service has answered
it, so a revoke on its way never disables an account made under the same name afterwards.

KNOWN BUGS. A row the code gets wrong today carries a `known_bug` mark with the bug's title, which is
unittest's `expectedFailure`: an unexpected success fails the run, so whoever fixes the bug removes
the mark and the key in docs/gateway-lifecycle.md. The db lane's test_gateway_lifecycle.py holds the
same rows against the database alone.

The mqtt probe is `mosquitto_pub` run inside the broker's container as the account: a published
message is a probe to a topic under the account's own edge node, and nothing reads it.
"""
import http.client
import json
import os
import sys
import time
import unittest
import urllib.parse
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "test-harness"))
import stack_exec  # noqa: E402  -- kubectl exec into the release's pods
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit
from test_enroll_gateway import (  # noqa: E402
    PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, database, delete_broker_account,
    delete_gateway_and_wait_for_revoke, enroll, rest, sign_in, sparkplug_id_of,
)

# Every gateway this suite makes starts with this, so a crashed run is reclaimed by name.
PREFIX = "Test_Lifecycle_Broker_"

# How long a revocation or a re-enabling may take to reach the broker: pg_net, the edge function,
# the credential service and the plugin, in that order.
BROKER_SECONDS = 90

# The REQUIRE_* flags make a skip a failure where the caller installed what is missing.
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")

# The broker's own list of clients, read from inside the credential service's container with the
# token that container holds: no token leaves the cluster and the host needs none.
_LIST_CLIENTS = """
fetch('http://127.0.0.1:9010/clients', {
  headers: { Authorization: 'Bearer ' + (process.env.MQTT_CREDENTIAL_SERVICE_TOKEN || '') },
})
  .then(async (r) => { console.log(r.status); console.log(await r.text()); })
  .catch((e) => { console.log('000'); console.log(JSON.stringify({ error: String(e) })); });
"""


def known_bug(title):
    """Mark a row the code gets wrong today, by the title of the bug that says so."""
    def mark(test):
        test.known_bug = title
        return unittest.expectedFailure(test)
    return mark


def skip_or_fail(message):
    """Skip when a person runs this ad hoc; fail where the stack is guaranteed to carry what is missing."""
    if STRICT:
        raise AssertionError(f"REQUIRE_SEEDED_ACCOUNTS=1, so this cannot be skipped: {message}")
    raise unittest.SkipTest(message)


def broker_clients():
    """The clients the broker holds right now, by username, from the credential service's inventory."""
    result = stack_exec.run("credential", "node", "-e", _LIST_CLIENTS)
    if result.returncode != 0:
        raise RuntimeError(f"could not read the broker's clients: {result.stderr.strip()}")
    status_line, _, body = result.stdout.partition("\n")
    status = int(status_line.strip() or 0)
    if status != 200:
        raise RuntimeError(f"the credential service answered {status} to GET /clients: {body.strip()[:200]}")
    return {c["username"]: c for c in json.loads(body)["clients"]}


def wait_until(predicate, what, timeout=BROKER_SECONDS, interval=2):
    """Poll until `predicate()` holds; fail naming what was waited for."""
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            return
        if time.monotonic() >= deadline:
            raise AssertionError(f"after {timeout}s: {what}")
        time.sleep(interval)


def probe(username, password, retry_for=15.0):
    """The broker's verdict on this account's credential: accepted, refused or unanswered."""
    return stack_exec.publish(
        username, password, f"spBv1.0/Aber/DBIRTH/{username}/probe", retry_for=retry_for)[0]


def sql_text(sql):
    return database(sql).strip()


@unittest.skipIf(not SERVICE_ROLE_KEY or not PUBLISHABLE_KEY,
                 "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY must be set")
class BrokerLifecycle(unittest.TestCase):
    made = []

    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no stack"
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")
        try:
            broker_clients()
        except Exception as err:  # noqa: BLE001
            skip_or_fail(f"the broker's clients cannot be read from the credential container: {err}")
        _, switch = rest("/system_settings?key=eq.security.require_mfa_for_managers&select=value")
        if switch and switch[0]["value"] is True:
            skip_or_fail("Settings requires a second factor of Administrators on this stack, which a script's session "
                         "cannot give, so it cannot issue a credential or a setup token")
        try:
            cls.admin_token = sign_in()
        except stack_sign_in.RateLimited:
            raise
        except Exception as err:  # noqa: BLE001
            skip_or_fail(f"could not sign in as the seeded Administrator -- apply supabase/seed.sql first ({err})")
        cls.reclaim()

    @classmethod
    def reclaim(cls):
        """Delete what a crashed run left, as a person would, waiting for each revocation."""
        _, rows = rest(f"/gateways?name=like.{PREFIX}*&select=id,sparkplug_id")
        for row in rows or []:
            delete_gateway_and_wait_for_revoke(row["id"], row["sparkplug_id"])
            delete_broker_account(row["sparkplug_id"])

    @classmethod
    def tearDownClass(cls):
        # Each gateway, then its account, whatever the last one did; the first failure is raised at the end.
        failure = None
        for gid in cls.made:
            try:
                delete_gateway_and_wait_for_revoke(gid, sparkplug_id_of(gid))
            except Exception as err:  # noqa: BLE001
                failure = failure or err
            finally:
                delete_broker_account(sparkplug_id_of(gid))
        cls.made.clear()
        if failure:
            raise failure

    # -- fixtures ---------------------------------------------------------------------------------

    def new_gateway(self, kind):
        """A registered gateway of this type, as the Register dialog leaves it."""
        deployment, simulated = {"remote": ("remote", False), "third_party": ("third_party", False),
                                 "host": ("host", False), "simulated": ("host", True)}[kind]
        gid = str(uuid.uuid4())
        status, rows = rest("/gateways", method="POST", prefer="return=representation", body={
            "id": gid, "name": f"{PREFIX}{kind}_{gid[:8]}", "status": "OFFLINE",
            "deployment": deployment, "is_simulated": simulated})
        self.assertLess(status, 300, rows)
        self.made.append(gid)
        self.assertEqual(rows[0]["sparkplug_id"], sparkplug_id_of(gid))
        return gid, rows[0]["sparkplug_id"]

    def call(self, function, body):
        """POST to an edge function as the signed-in Administrator: (status, parsed JSON or {raw})."""
        address = urllib.parse.urlsplit(SUPABASE_URL)
        connect = http.client.HTTPSConnection if address.scheme == "https" else http.client.HTTPConnection
        connection = connect(address.netloc, timeout=30)
        try:
            connection.request(
                "POST", f"{address.path.rstrip('/')}/functions/v1/{function}", body=json.dumps(body),
                headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {self.admin_token}",
                         "Content-Type": "application/json"})
            response = connection.getresponse()
            status, raw = response.status, response.read().decode()
        finally:
            connection.close()
        try:
            return status, json.loads(raw) if raw.strip() else None
        except json.JSONDecodeError:
            return status, {"raw": raw}

    def issue_credential(self, gid):
        """The Generate Broker Credential button, as the dashboard calls it. Returns the password."""
        status, body = self.call("gateway-credential", {"gateway_id": gid})
        self.assertEqual(status, 200, body)
        return body["password"]

    def issue_setup(self, gid):
        """The Set Up Gateway or Re-issue Setup button, as the dashboard calls it. Returns the token."""
        _, rows = rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
                       body={"p_gateway_id": gid, "p_ttl_minutes": 30})
        return rows[0]["token"]

    def setup_and_enrol(self, gid):
        """The Set Up Gateway button, then the appliance redeeming the token. Returns the password."""
        status, payload = enroll(self.issue_setup(gid), agent_version="1.4.2")
        self.assertEqual(status, 200, payload)
        return payload["mqtt_password"]

    def patch(self, gid, body):
        status, _ = rest(f"/gateways?id=eq.{gid}", method="PATCH", body=body)
        self.assertIn(status, (200, 204))

    def archive(self, gid):
        self.patch(gid, {"is_archived": True, "archived_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                         "auto_delete_at": None})

    def restore(self, gid):
        self.patch(gid, {"is_archived": False, "archived_at": None, "auto_delete_at": None})

    def change_type(self, gid, kind):
        deployment, simulated = {"remote": ("remote", False), "third_party": ("third_party", False),
                                 "host": ("host", False), "simulated": ("host", True)}[kind]
        self.patch(gid, {"deployment": deployment, "is_simulated": simulated})

    def as_if_the_revocation_never_landed(self, gid, sparkplug_id):
        """
        What a revocation the broker never received leaves: the account enabled, and the platform's
        debt with no confirmed request. The account is turned back on through the credential service's
        admin credential, as delete_broker_account() deletes one.
        """
        if str(uuid.UUID(gid)) != gid or sparkplug_id_of(gid) != sparkplug_id:
            raise ValueError(f"not this suite's gateway: {gid!r} {sparkplug_id!r}")
        stack_exec.run(
            "credential", "sh", "-c",
            'mosquitto_ctrl -h "${MQTT_HOST:-mosquitto}" -u "$MQTT_DYNSEC_ADMIN_USER" '
            f'-P "$MQTT_DYNSEC_ADMIN_PASSWORD" dynsec enableClient {sparkplug_id}',
        )
        sql_text(
            "INSERT INTO public.gateway_revocation_requests (gateway_id, request_id, requested_at) "
            f"VALUES ('{gid}', NULL, now()) ON CONFLICT (gateway_id) DO UPDATE SET request_id = NULL, requested_at = now()")
        self.wait_for_account(sparkplug_id, disabled=False)

    def owed_after_delete(self, sparkplug_id):
        return sql_text(f"SELECT count(*) FROM public.deleted_gateway_revocations WHERE sparkplug_id = '{sparkplug_id}'") != "0"

    def sweep_until_confirmed(self, sparkplug_id):
        """The revocation sweep, run as pg_cron runs it, until the deleted gateway's debt is confirmed."""
        def confirmed():
            sql_text("SELECT public.sweep_gateway_credential_revocations()")
            return not self.owed_after_delete(sparkplug_id)
        wait_until(confirmed, f"the sweep never had {sparkplug_id}'s revocation confirmed", interval=5)

    # -- what the platform says, and what the broker says -----------------------------------------

    def record(self, gid):
        """The platform's own record: the row's columns, and what the database counts as held."""
        _, rows = rest(f"/gateways?id=eq.{gid}&select=status,enrolled_at,credential_revoked_at,is_archived")
        held = sql_text(
            f"SELECT public.gateway_has_broker_credential(g) FROM public.gateways g WHERE g.id = '{gid}'") == "t"
        return {**rows[0], "held": held}

    def revocation_asked(self, gid):
        """Whether a revocation was asked for this gateway and not yet confirmed: its row for the sweep to judge."""
        return sql_text(f"SELECT count(*) FROM public.gateway_revocation_requests WHERE gateway_id = '{gid}'") != "0"

    def account(self, sparkplug_id):
        """The broker's client for this gateway, or None: absent, enabled or disabled."""
        return broker_clients().get(sparkplug_id)

    def wait_for_account(self, sparkplug_id, disabled):
        wait_until(lambda: (self.account(sparkplug_id) or {}).get("disabled") is disabled,
                   f"the broker's account {sparkplug_id} did not become {'disabled' if disabled else 'enabled'}")

    def assert_agree(self, gid, sparkplug_id):
        """The record and the broker tell one story: held means an enabled account, and only that."""
        client, record = self.account(sparkplug_id), self.record(gid)
        enabled = client is not None and not client["disabled"]
        self.assertEqual(
            record["held"], enabled,
            f"the platform says it {'holds' if record['held'] else 'holds no'} credential for {sparkplug_id}, "
            f"and the broker's account is {'absent' if client is None else 'disabled' if client['disabled'] else 'enabled'} "
            f"(credential_revoked_at {record['credential_revoked_at']})")

    def assert_refused(self, sparkplug_id, password):
        self.assertEqual(probe(sparkplug_id, password, retry_for=0), stack_exec.REFUSED,
                         f"the broker did not refuse {sparkplug_id}'s revoked credential")

    def assert_accepted(self, sparkplug_id, password):
        self.assertEqual(probe(sparkplug_id, password), stack_exec.ACCEPTED,
                         f"the broker did not accept {sparkplug_id}'s credential")


# -------------------------------------------------------------------------------------------------
# Third-party, Host and Simulated: issued in the dashboard
# -------------------------------------------------------------------------------------------------
class DashboardIssued(BrokerLifecycle):
    KINDS = ("third_party", "host", "simulated")

    def test_registering_makes_no_account(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.new_gateway(kind)
                self.assertIsNone(self.account(sparkplug_id))
                self.assert_agree(gid, sparkplug_id)

    def test_issuing_and_issuing_again_leave_one_enabled_account_and_the_latest_password(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.new_gateway(kind)
                first = self.issue_credential(gid)
                self.assertFalse(self.account(sparkplug_id)["disabled"])
                self.assert_accepted(sparkplug_id, first)
                self.assert_agree(gid, sparkplug_id)

                second = self.issue_credential(gid)
                self.assertNotEqual(first, second)
                self.assert_accepted(sparkplug_id, second)
                wait_until(lambda: probe(sparkplug_id, first, retry_for=0) == stack_exec.REFUSED,
                           "the replaced password still opens the account")
                self.assert_agree(gid, sparkplug_id)
                self.assertEqual(sql_text(
                    "SELECT count(*) FROM public.audit_trail WHERE entity_type = 'gateways' "
                    f"AND entity_id = '{gid}' AND action = 'CREDENTIAL_ISSUED'"), "2")

    def test_archiving_disables_the_account_and_the_record_says_so(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.new_gateway(kind)
                password = self.issue_credential(gid)
                self.archive(gid)
                self.wait_for_account(sparkplug_id, disabled=True)
                self.assert_refused(sparkplug_id, password)
                self.assertIsNotNone(self.record(gid)["credential_revoked_at"])
                self.assert_agree(gid, sparkplug_id)

    def test_archiving_a_gateway_with_no_credential_makes_no_account(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.new_gateway(kind)
                self.archive(gid)
                self.assertFalse(self.revocation_asked(gid), "a revocation was asked for an account never issued")
                self.assertIsNone(self.account(sparkplug_id), "revocation created an account that was never issued")

    def test_restoring_leaves_the_account_disabled(self):
        gid, sparkplug_id = self.new_gateway("host")
        password = self.issue_credential(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.restore(gid)
        self.assertTrue(self.account(sparkplug_id)["disabled"], "restoring re-enabled the broker account")
        self.assert_refused(sparkplug_id, password)

    def test_after_a_restore_the_record_agrees_with_the_account(self):
        gid, sparkplug_id = self.new_gateway("host")
        self.issue_credential(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.restore(gid)
        self.assert_agree(gid, sparkplug_id)

    def test_a_restored_gateway_is_issued_a_credential_again_and_the_account_comes_back(self):
        gid, sparkplug_id = self.new_gateway("third_party")
        old = self.issue_credential(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.restore(gid)
        new = self.issue_credential(gid)
        self.wait_for_account(sparkplug_id, disabled=False)
        self.assert_accepted(sparkplug_id, new)
        self.assert_refused(sparkplug_id, old)
        self.assert_agree(gid, sparkplug_id)

    def test_deleting_a_gateway_that_holds_a_credential_disables_its_account(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.new_gateway(kind)
                password = self.issue_credential(gid)
                delete_gateway_and_wait_for_revoke(gid, sparkplug_id)
                client = self.account(sparkplug_id)
                self.assertIsNotNone(client, "the plugin forgot the account, which a revocation does not do")
                self.assertTrue(client["disabled"])
                self.assert_refused(sparkplug_id, password)

    def test_a_revocation_that_never_landed_is_asked_again_after_the_gateway_is_deleted(self):
        gid, sparkplug_id = self.new_gateway("host")
        password = self.issue_credential(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.as_if_the_revocation_never_landed(gid, sparkplug_id)

        delete_gateway_and_wait_for_revoke(gid, sparkplug_id)
        self.assertTrue(self.owed_after_delete(sparkplug_id), "the revocation still owed went with the row")
        self.sweep_until_confirmed(sparkplug_id)
        self.assertTrue(self.account(sparkplug_id)["disabled"])
        self.assert_refused(sparkplug_id, password)

    def test_changing_among_the_dashboard_issued_types_leaves_the_account_enabled(self):
        gid, sparkplug_id = self.new_gateway("host")
        password = self.issue_credential(gid)
        for kind in ("third_party", "simulated", "host"):
            self.change_type(gid, kind)
            self.assertFalse(self.revocation_asked(gid), f"changing to {kind} asked for a revocation")
            self.assertFalse(self.account(sparkplug_id)["disabled"], f"changing to {kind} disabled the account")
            self.assert_accepted(sparkplug_id, password)
            self.assert_agree(gid, sparkplug_id)

    def test_changing_to_remote_disables_the_account_and_the_record_says_so(self):
        gid, sparkplug_id = self.new_gateway("third_party")
        password = self.issue_credential(gid)
        self.change_type(gid, "remote")
        self.wait_for_account(sparkplug_id, disabled=True)
        self.assert_refused(sparkplug_id, password)
        self.assertIsNotNone(self.record(gid)["credential_revoked_at"])
        self.assert_agree(gid, sparkplug_id)


# -------------------------------------------------------------------------------------------------
# Remote: enrolled through enroll-gateway
# -------------------------------------------------------------------------------------------------
class RemoteEnrolled(BrokerLifecycle):

    def test_setup_makes_no_account_and_enrolment_makes_one(self):
        gid, sparkplug_id = self.new_gateway("remote")
        self.assertIsNone(self.account(sparkplug_id))
        _, rows = rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
                       body={"p_gateway_id": gid, "p_ttl_minutes": 30})
        self.assertIsNone(self.account(sparkplug_id), "issuing a setup token made a broker account")
        self.assert_agree(gid, sparkplug_id)
        status, payload = enroll(rows[0]["token"], agent_version="1.4.2")
        self.assertEqual(status, 200, payload)
        self.assertFalse(self.account(sparkplug_id)["disabled"])
        self.assert_accepted(sparkplug_id, payload["mqtt_password"])
        record = self.record(gid)
        self.assertEqual(record["status"], "AWAITING_BIRTH")
        self.assertIsNotNone(record["enrolled_at"])
        self.assertIsNone(record["credential_revoked_at"])
        self.assert_agree(gid, sparkplug_id)

    def test_enrolling_again_replaces_the_password_on_the_one_account(self):
        gid, sparkplug_id = self.new_gateway("remote")
        first = self.setup_and_enrol(gid)
        before = len(broker_clients())
        second = self.setup_and_enrol(gid)
        self.assertNotEqual(first, second)
        self.assertEqual(len(broker_clients()), before, "a second enrolment made a second account")
        self.assert_accepted(sparkplug_id, second)
        self.assert_refused(sparkplug_id, first)
        self.assert_agree(gid, sparkplug_id)

    def test_leaving_remote_disables_the_account_and_the_record_says_so(self):
        for kind in ("host", "third_party"):
            with self.subTest(kind=kind):
                gid, sparkplug_id = self.new_gateway("remote")
                password = self.setup_and_enrol(gid)
                self.change_type(gid, kind)
                self.wait_for_account(sparkplug_id, disabled=True)
                self.assert_refused(sparkplug_id, password)
                self.assertIsNotNone(self.record(gid)["credential_revoked_at"])
                self.assert_agree(gid, sparkplug_id)

                # The new type is issued its own credential, and the account comes back for it.
                issued = self.issue_credential(gid)
                self.wait_for_account(sparkplug_id, disabled=False)
                self.assert_accepted(sparkplug_id, issued)
                self.assert_refused(sparkplug_id, password)
                self.assert_agree(gid, sparkplug_id)

    def test_a_change_of_type_that_never_landed_is_asked_again_after_an_archive_and_a_delete(self):
        gid, sparkplug_id = self.new_gateway("remote")
        password = self.setup_and_enrol(gid)
        self.change_type(gid, "host")
        self.wait_for_account(sparkplug_id, disabled=True)
        self.as_if_the_revocation_never_landed(gid, sparkplug_id)
        self.assert_accepted(sparkplug_id, password)

        # The archive's type holds no credential, so it asks nothing; the change's debt is what stays.
        self.archive(gid)
        self.assertTrue(self.revocation_asked(gid))
        delete_gateway_and_wait_for_revoke(gid, sparkplug_id)
        self.assertTrue(self.owed_after_delete(sparkplug_id), "the revocation still owed went with the row")
        self.sweep_until_confirmed(sparkplug_id)
        self.assertTrue(self.account(sparkplug_id)["disabled"])
        self.assert_refused(sparkplug_id, password)

    def test_leaving_remote_before_enrolment_makes_no_account(self):
        gid, sparkplug_id = self.new_gateway("remote")
        rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
             body={"p_gateway_id": gid, "p_ttl_minutes": 30})
        self.change_type(gid, "host")
        self.assertFalse(self.revocation_asked(gid), "a revocation was asked for an account never issued")
        self.assertIsNone(self.account(sparkplug_id))
        self.assert_agree(gid, sparkplug_id)

    def test_archiving_an_enrolled_gateway_disables_the_account(self):
        gid, sparkplug_id = self.new_gateway("remote")
        password = self.setup_and_enrol(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.assert_refused(sparkplug_id, password)
        self.assertIsNotNone(self.record(gid)["credential_revoked_at"])

    def test_archiving_a_gateway_never_enrolled_makes_no_account(self):
        gid, sparkplug_id = self.new_gateway("remote")
        rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
             body={"p_gateway_id": gid, "p_ttl_minutes": 30})
        self.archive(gid)
        self.assertFalse(self.revocation_asked(gid), "a revocation was asked for an account never issued")
        self.assertIsNone(self.account(sparkplug_id))

    def test_restoring_an_enrolled_gateway_leaves_the_account_disabled(self):
        gid, sparkplug_id = self.new_gateway("remote")
        password = self.setup_and_enrol(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.restore(gid)
        self.assertTrue(self.account(sparkplug_id)["disabled"], "restoring re-enabled the broker account")
        self.assert_refused(sparkplug_id, password)

    def test_after_a_restore_an_enrolled_gateway_s_record_agrees_with_the_account(self):
        gid, sparkplug_id = self.new_gateway("remote")
        self.setup_and_enrol(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.restore(gid)
        self.assert_agree(gid, sparkplug_id)

    def test_a_restored_gateway_enrols_again_and_the_account_comes_back(self):
        gid, sparkplug_id = self.new_gateway("remote")
        old = self.setup_and_enrol(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        self.restore(gid)
        new = self.setup_and_enrol(gid)
        self.wait_for_account(sparkplug_id, disabled=False)
        self.assert_accepted(sparkplug_id, new)
        self.assert_refused(sparkplug_id, old)
        self.assert_agree(gid, sparkplug_id)

    def test_deleting_an_enrolled_gateway_disables_the_account(self):
        gid, sparkplug_id = self.new_gateway("remote")
        password = self.setup_and_enrol(gid)
        delete_gateway_and_wait_for_revoke(gid, sparkplug_id)
        client = self.account(sparkplug_id)
        self.assertIsNotNone(client)
        self.assertTrue(client["disabled"])
        self.assert_refused(sparkplug_id, password)

    def test_deleting_an_archived_gateway_leaves_its_account_disabled(self):
        gid, sparkplug_id = self.new_gateway("remote")
        password = self.setup_and_enrol(gid)
        self.archive(gid)
        self.wait_for_account(sparkplug_id, disabled=True)
        delete_gateway_and_wait_for_revoke(gid, sparkplug_id)
        self.assertTrue(self.account(sparkplug_id)["disabled"])
        self.assert_refused(sparkplug_id, password)


if __name__ == "__main__":
    unittest.main(verbosity=2)
