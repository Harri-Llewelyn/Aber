"""
Integration tests for the enroll-gateway edge function.

WHAT THIS FUNCTION IS, AND WHY ITS TESTS LOOK UNLIKE THE OTHER FUNCTIONS'. Every other edge function
authenticates a PERSON and checks a role. This one authenticates an APPLIANCE by possession of a
single-use token -- there is no user, no session, and the anon key is all that gets the request past
the gateway. So the suite asserts a different set of properties:

  * the token is genuinely single-use, and unknown/expired/consumed are INDISTINGUISHABLE (telling
    them apart would let an enumerator learn that a token value once existed);
  * a race produces exactly ONE winner -- because the broker's roles pin the topic's edge-node segment
    to the connecting username, two credentials for one gateway would silently contend for one
    Sparkplug identity rather than failing;
  * a failure in the credential service RELEASES the claim, so a transient broker outage costs a
    retry rather than a manual re-issue per appliance. This is the property with the most moving
    parts and the least chance of being noticed if it regresses: everything still "works", right up
    until a broker restart during a commissioning window burns every bundle in the building.

Requires the stack up, and the service-role key (to mint tokens the way the dashboard does):

    SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_PUBLISHABLE_KEY=... python \
        supabase/functions/enroll-gateway/test_enroll_gateway.py
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "test-harness"))
import stack_exec  # noqa: E402  -- kubectl exec into the release's pods

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# THE FLAG THAT TURNS AN UNREACHABLE FORGE INTO A FAILURE, and why the forge suites need one.
#
# The forge is optional at both ends, so skipping where none is configured is right for a person
# running this by hand. Where the caller INSTALLED the forge it is wrong, and expensively so: the
# skip is taken in setUpClass, which removes the whole class, and a run that is nothing but skips
# reports `OK (skipped=N)` and exits 0. #222 is what that cost -- seven tests silently absent from
# every green Windows dev-loop run, hiding a stale assertion (#207) that was red on main for days.
#
# This is the same flag REQUIRE_SEEDED_ACCOUNTS, REQUIRE_LOG_PIPELINE and REQUIRE_PLAYBACK_REPLAY
# already are, on the suites those cover.
REQUIRE_FORGE = os.getenv("REQUIRE_FORGE") == "1"


def skip_or_fail(message):
    """Skip when a person runs this ad hoc; fail where the forge is guaranteed to be there."""
    if REQUIRE_FORGE:
        raise AssertionError(f"REQUIRE_FORGE=1, so this cannot be skipped: {message}")
    raise unittest.SkipTest(message)


def delete_broker_account(username):
    """
    Remove a broker account an enrolment created, through the credential service's own admin
    credential: the one place a delete is spoken, since the service itself never deletes. The
    forge suites share this, because their enrolments leave the same account behind.
    """
    stack_exec.run(
        "credential", "sh", "-c",
        'mosquitto_ctrl -h "${MQTT_HOST:-mosquitto}" -u "$MQTT_DYNSEC_ADMIN_USER" '
        f'-P "$MQTT_DYNSEC_ADMIN_PASSWORD" dynsec deleteClient {username}',
    )


# A Remote gateway created and torn down by this suite. Pinned so a crashed run leaves a row the
# next setUpClass reclaims rather than accumulating gateways. Distinct from the migration suite's
# 2f/2e block -- these run against the same database and must not fight over one row.
TEST_GW_ID = "2d000000-0000-4000-8000-000000000001"


ADMIN_EMAIL = os.getenv("ABER_ADMIN_EMAIL", "admin@aber.local")
ADMIN_PASSWORD = os.getenv("ABER_ADMIN_PASSWORD", "aber123")


def rest(path, method="GET", body=None, bearer=None, prefer=None):
    """
    A PostgREST or RPC call.

    The apikey is the publishable key the gateway checks; `bearer` is the identity PostgREST
    resolves: service_role by default, a signed-in user's access token otherwise, which is exactly
    the distinction issue_gateway_enrollment_token() turns on.
    """
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": PUBLISHABLE_KEY,
            "Authorization": f"Bearer {bearer or SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "X-Aber-Actor": "service",
            **({"Prefer": prefer} if prefer else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        raw = response.read().decode()
        return response.status, (json.loads(raw) if raw.strip() else None)


def sign_in(email=ADMIN_EMAIL, password=ADMIN_PASSWORD):
    """
    A real GoTrue session, because MINTING A TOKEN IS A USER'S ACT AND NOT service_role's.

    `issue_gateway_enrollment_token()` is SECURITY DEFINER and gated on
    `public.has_role(['Administrator','Shopfloor_Manager'])`, which resolves auth.uid() against
    public.user_roles. service_role has no uid and therefore no role, so calling the RPC with the
    service key fails -- correctly, and it is worth stating rather than working around: issuing a
    bundle is an operator's decision, and the one path that can make it is the one the dashboard
    uses. (service_role is additionally not granted EXECUTE on it at all.)
    """
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode())["access_token"]


def enroll(token, agent_version=None, ssh_public_key=None):
    """
    Call the function the way an APPLIANCE does: the publishable key, and no user JWT.

    That is the auth contract under test -- the gateway gates /functions/v1/, so the request needs
    an apikey, but nothing about it identifies a person.
    """
    key = PUBLISHABLE_KEY
    payload = {"token": token}
    if agent_version:
        payload["agent_version"] = agent_version
    if ssh_public_key is not None:
        # The PUBLIC half of a key the appliance generated. bootstrap.mjs sends this; the platform
        # registers it read-only against the gateway repository and never sees the private half.
        payload["ssh_public_key"] = ssh_public_key

    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/enroll-gateway",
        method="POST",
        data=json.dumps(payload).encode(),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        # A gateway timeout arrives as text, not JSON; kept whole so the assertion can show it.
        try:
            return err.code, (json.loads(raw) if raw.strip() else None)
        except json.JSONDecodeError:
            return err.code, {"raw": raw}


@unittest.skipIf(not SERVICE_ROLE_KEY or not PUBLISHABLE_KEY,
                 "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY must be set")
class EnrollGatewayBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no stack"
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")

        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={
                "id": TEST_GW_ID,
                "name": "Test_Remote_Gateway_Enrol",
                "status": "OFFLINE",
                # deployment 'remote' is the precondition: issue_gateway_enrollment_token() refuses
                # a host-run gateway, because a bundle for one would mint a broker credential that
                # nothing could ever present.
                "deployment": "remote",
            },
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        cls.sparkplug_id = rows[0]["sparkplug_id"]

        try:
            cls.admin_token = sign_in()
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(
                f"could not sign in as {ADMIN_EMAIL} -- apply supabase/seed.sql first ({err})"
            )

    @classmethod
    def tearDownClass(cls):
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        # The broker account outlives the row (the plugin knows nothing about gateways), so it is
        # removed explicitly or it accumulates across runs. Deleted through the service container's
        # own admin credential, the one place a delete is spoken; the service itself never does.
        delete_broker_account(cls.sparkplug_id)

    def issue_token(self, ttl_minutes=30):
        """Mint a token exactly as the dashboard does: anon key, Administrator's access token."""
        _, rows = rest(
            "/rpc/issue_gateway_enrollment_token", method="POST",
            bearer=self.admin_token,
            body={"p_gateway_id": TEST_GW_ID, "p_ttl_minutes": ttl_minutes},
        )
        return rows[0]["token"]

    def gateway(self):
        _, rows = rest(
            f"/gateways?id=eq.{TEST_GW_ID}"
            "&select=status,enrolled_at,agent_version,forge_repository_at"
        )
        return rows[0]

    def setUp(self):
        # Every test starts from PENDING_ENROLLMENT with no live token, so one test's leftovers
        # cannot make the next one pass. `forge_repository_at` is cleared with the rest: it is what
        # separates "enrolled" from "has a repository", so a leftover would prove nothing.
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH",
             body={"status": "OFFLINE", "enrolled_at": None, "agent_version": None,
                   "forge_repository_at": None})


class TestSuccessfulEnrolment(EnrollGatewayBase):
    def test_returns_the_complete_connection_payload(self):
        token = self.issue_token()
        status, payload = enroll(token, agent_version="1.4.2")

        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["status"], "ENROLLED")

        # IDENTITY. The username IS the sparkplug_id and cannot be anything else: the gateway's
        # broker role confines it to its own edge-node segment, and verify_gateway_binding()
        # compares the same segment against the gateway row.
        self.assertEqual(payload["sparkplug_id"], self.sparkplug_id)
        self.assertEqual(payload["mqtt_username"], self.sparkplug_id)
        # The other half of the address resolve_gateway() looks up FIRST. An appliance told only the
        # node id falls through to the group-agnostic arm, which works until a second group exists.
        self.assertEqual(payload["sparkplug_group"], "Aber")

        # ENDPOINT. Must be an address an appliance can actually resolve -- never the in-network
        # name, which the function refuses to emit.
        self.assertTrue(payload["mqtt_host"])
        self.assertNotIn(payload["mqtt_host"], ("mosquitto", "localhost", "127.0.0.1"))
        self.assertEqual(payload["mqtt_tls_port"], 8883)

        # CREDENTIAL. base64url, the alphabet the credential service enforces as an injection
        # boundary; returned exactly once and unrecoverable thereafter.
        self.assertRegex(payload["mqtt_password"], r"^[A-Za-z0-9_-]{16,128}$")

        # TRUST. Remote gateways connect over MQTTS only, so a PEM root is not optional.
        self.assertIn("BEGIN CERTIFICATE", payload["ca_cert"])
        self.assertIn("END CERTIFICATE", payload["ca_cert"])

    def test_transitions_the_gateway_to_awaiting_birth(self):
        token = self.issue_token()
        self.assertEqual(self.gateway()["status"], "PENDING_ENROLLMENT")

        status, _ = enroll(token, agent_version="1.4.2")
        self.assertEqual(status, 200)

        row = self.gateway()
        self.assertEqual(row["status"], "AWAITING_BIRTH")
        self.assertIsNotNone(row["enrolled_at"])
        self.assertEqual(row["agent_version"], "1.4.2")
        # `enrolled_at` is step 3 and is set on every path through the function, including the ones
        # that reach no forge. This enrolment sent no key, so step 4 did nothing and the column that
        # records it stays null -- which is the whole reason it is a separate column (#237).
        self.assertIsNone(row["forge_repository_at"])

    def test_the_issued_credential_works_against_the_broker(self):
        """
        The assertion that makes the rest meaningful. Everything above could pass against a function
        that returned a well-formed payload describing an account that does not exist.
        """
        token = self.issue_token()
        _, payload = enroll(token)

        publish = stack_exec.run(
            "broker", "mosquitto_pub",
            "--cafile", "/mosquitto/certs/ca.crt", "-h", stack_exec.broker_host(), "-p", "8883",
            "-u", payload["mqtt_username"], "-P", payload["mqtt_password"],
            "-t", f"spBv1.0/{payload['sparkplug_group']}/DBIRTH/{payload['sparkplug_id']}/probe",
            "-m", "x",
        )
        self.assertEqual(publish.returncode, 0,
                         f"the enrolled credential was refused: {publish.stderr.strip()}")


    def test_the_ca_returned_verifies_the_broker_certificate(self):
        """The CA must be the one the broker is actually serving, not merely a valid PEM."""
        token = self.issue_token()
        _, payload = enroll(token)

        verify = stack_exec.run(
            "credential", "sh", "-c",
            "cat > /tmp/ca.pem && openssl verify -CAfile /tmp/ca.pem /mosquitto/certs/tls.crt",
            input=payload["ca_cert"],
        )
        # openssl is not in this image; fall back to comparing against the CA on disk, which is the
        # same assertion by a weaker route.
        if verify.returncode != 0 and "not found" in (verify.stderr or ""):
            on_disk = stack_exec.run("credential", "cat", "/mosquitto/certs/ca.crt").stdout
            self.assertEqual(payload["ca_cert"].strip(), on_disk.strip())
        else:
            self.assertEqual(verify.returncode, 0, verify.stderr)


class TestDecommissioning(EnrollGatewayBase):
    def test_archiving_a_gateway_stops_its_broker_credential(self):
        """
        The whole path, from the row to the broker. The archive trigger asks through pg_net, which
        reports a call that never arrives to no one, so only the broker's answer proves it.
        """
        _, payload = enroll(self.issue_token())

        def publish():
            return stack_exec.run(
                "broker", "mosquitto_pub",
                "--cafile", "/mosquitto/certs/ca.crt", "-h", stack_exec.broker_host(), "-p", "8883",
                "-u", payload["mqtt_username"], "-P", payload["mqtt_password"],
                "-t", f"spBv1.0/{payload['sparkplug_group']}/NDATA/{payload['sparkplug_id']}", "-m", "x",
            )

        before = publish()
        self.assertEqual(before.returncode, 0, f"the credential was refused before the archive: {before.stderr.strip()}")
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": True})
        deadline, after = time.monotonic() + 60, before
        while after.returncode == 0 and time.monotonic() < deadline:
            time.sleep(2)
            after = publish()
        self.assertNotEqual(after.returncode, 0, "an archived gateway's broker credential still publishes after 60s")

class TestTokenRejection(EnrollGatewayBase):
    def test_unknown_token_is_rejected(self):
        status, payload = enroll("f" * 64)
        self.assertEqual(status, 401)
        self.assertIn("not valid", payload["error"])

    def test_malformed_token_is_rejected(self):
        for bad in ("", "not-a-token", "ABC" * 21 + "D", "0" * 63):
            with self.subTest(token=bad[:12]):
                status, _ = enroll(bad)
                self.assertEqual(status, 401)

    def test_already_consumed_token_is_rejected(self):
        token = self.issue_token()
        first, _ = enroll(token)
        self.assertEqual(first, 200)

        second, payload = enroll(token)
        self.assertEqual(second, 401, payload)

    def test_expired_token_is_rejected(self):
        token = self.issue_token(ttl_minutes=1)
        # Aged in place. BOTH timestamps move: the CHECK constraint asserts expires_at > created_at,
        # so backdating the expiry alone is rejected by the constraint rather than producing an
        # expired token.
        rest(f"/gateway_enrollment_tokens?gateway_id=eq.{TEST_GW_ID}&consumed_at=is.null",
             method="PATCH",
             body={"created_at": "2020-01-01T00:00:00Z", "expires_at": "2020-01-01T01:00:00Z"})

        status, _ = enroll(token)
        self.assertEqual(status, 401)
        # And the gateway was NOT moved: a refused enrolment must change nothing.
        self.assertEqual(self.gateway()["status"], "PENDING_ENROLLMENT")

    def test_the_three_rejections_are_indistinguishable(self):
        """
        Unknown, expired and consumed must produce the SAME response. Distinguishing them would let
        an enumerator learn which token values ever existed, and the appliance can do nothing
        different in any of the three cases.
        """
        consumed = self.issue_token()
        enroll(consumed)

        expiring = self.issue_token(ttl_minutes=1)
        rest(f"/gateway_enrollment_tokens?gateway_id=eq.{TEST_GW_ID}&consumed_at=is.null",
             method="PATCH",
             body={"created_at": "2020-01-01T00:00:00Z", "expires_at": "2020-01-01T01:00:00Z"})

        responses = [enroll("a" * 64), enroll(consumed), enroll(expiring)]
        statuses = {status for status, _ in responses}
        bodies = {json.dumps(body, sort_keys=True) for _, body in responses}
        self.assertEqual(statuses, {401})
        self.assertEqual(len(bodies), 1, f"the three rejections differ: {bodies}")

    def test_a_race_produces_exactly_one_winner(self):
        """
        Two appliances, one token. Because the broker's roles pin the topic to the username, two winners
        would not fail -- they would silently contend for one Sparkplug identity.
        """
        from concurrent.futures import ThreadPoolExecutor

        token = self.issue_token()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: enroll(token), range(2)))

        statuses = sorted(status for status, _ in results)
        self.assertEqual(statuses, [200, 401], f"expected one winner, got {statuses}")


class TestCredentialServiceFailure(EnrollGatewayBase):
    """
    The rollback path. THE PROPERTY WITH THE LEAST CHANCE OF BEING NOTICED IF IT REGRESSES:
    everything looks fine until a broker restart during a commissioning window burns every bundle in
    the building, and the only recovery is an operator re-issuing one at a time.
    """

    def setUp(self):
        super().setUp()
        self.stopped = False

    def tearDown(self):
        if self.stopped:
            stack_exec.start("credential")
            # Wait for it to answer again so the next test is not racing the restart.
            stack_exec.wait_until("credential", "wget", "-qO-", "http://127.0.0.1:9010/healthz")

    def test_returns_503_and_releases_the_claim(self):
        token = self.issue_token()

        stack_exec.stop("credential")
        self.stopped = True

        status, payload = enroll(token)
        self.assertEqual(status, 503, payload)
        self.assertTrue(payload["retryable"], payload)

        # The gateway must NOT have moved: it was never enrolled.
        self.assertEqual(self.gateway()["status"], "PENDING_ENROLLMENT")

        # THE CLAIM WAS RELEASED -- asserted by the token working once the service is back, which is
        # the behaviour that matters rather than the row's internal state.
        stack_exec.start("credential")
        stack_exec.wait_until("credential", "wget", "-qO-", "http://127.0.0.1:9010/healthz")
        self.stopped = False

        # The Service lists the pod a moment before every node routes to it, so the first call can
        # still meet a refused connection. The appliance is told to retry with the same bundle, and
        # does; an unreleased claim would answer 401, never another retryable 503.
        deadline = time.monotonic() + 30
        while True:
            retried, retry_payload = enroll(token)
            if retried != 503 or not (retry_payload or {}).get("retryable") or time.monotonic() > deadline:
                break
            time.sleep(2)
        self.assertEqual(
            retried, 200,
            f"the SAME bundle could not be retried after a transient failure: {retry_payload}",
        )
        self.assertEqual(self.gateway()["status"], "AWAITING_BIRTH")


class TestAuthContract(EnrollGatewayBase):
    def test_the_anon_key_is_sufficient(self):
        """No user JWT anywhere in this flow -- an appliance has no session to present."""
        token = self.issue_token()
        status, _ = enroll(token)
        self.assertEqual(status, 200)

    def test_gateway_refuses_a_request_with_no_apikey(self):
        """The key check is the gateway's layer; the enrolment token is the function's."""
        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/enroll-gateway",
            method="POST", data=json.dumps({"token": "f" * 64}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=15)
        self.assertEqual(caught.exception.code, 401)

    def test_rejects_a_non_post(self):
        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/enroll-gateway",
            method="GET", headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=15)
        self.assertEqual(caught.exception.code, 405)



class TestForgeProvisioning(EnrollGatewayBase):
    """
    The third credential plane: the gateway's own repository, and the WRITABLE deploy key it reads
    that repository with and reports to.

    WHAT MAKES THIS WORTH TESTING RATHER THAN EYEBALLING. Three of its properties fail silently:

      * an appliance able to author the flow it will later be asked to deploy empties the review
        step of its meaning -- and nothing about a working clone would reveal it. `0104` made the
        key writable so the appliance can report what it is running on `appliance`, so the boundary
        is no longer the key's mode: it is the three branch rules that confine it;
      * a repository created PUBLIC exposes the plant's edge topology, and reads identically to a
        private one from the appliance's side;
      * a forge failure that is treated as fatal would refuse an enrolment whose token is already
        spent and whose broker credential already exists, turning a forge outage into a manual
        re-issue per appliance.

    SKIPPED, NOT FAILED, where no forge is configured. The integration is optional at both ends by
    design -- an install predating the forge enrols exactly as it did before. `REQUIRE_FORGE=1`
    reverses that where the caller installed the forge itself, because there the skip is the fault.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.forge_url = os.getenv("GITEA_TEST_URL", "http://127.0.0.1:3003")
        cls.machine_user = os.getenv("GITEA_MACHINE_USER", "aber_platform")
        cls.machine_password = os.getenv(
            "GITEA_MACHINE_PASSWORD", "aber-platform-machine-account"
        )
        # Every gateway repository lives in this organisation (forge.ts); the machine account owns
        # it, which is exactly the authority to create a repository in it and no more.
        cls.organisation = os.getenv("GITEA_ORGANISATION", "gateways")
        try:
            cls.forge("/api/v1/version")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no forge"
            skip_or_fail(f"no forge reachable at {cls.forge_url}: {err}")

    @classmethod
    def forge(cls, path, method="GET", body=None):
        """The forge's API, as the machine account -- the same credential enroll-gateway holds."""
        credentials = base64.b64encode(
            f"{cls.machine_user}:{cls.machine_password}".encode()
        ).decode()
        headers = {"Authorization": f"Basic {credentials}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            f"{cls.forge_url}{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw.strip() else None

    @classmethod
    def repo_name(cls):
        return f"gateway-{cls.sparkplug_id}"

    @classmethod
    def delete_repo(cls):
        # Both namespaces: the organisation, and the machine account's own, where the transfer test
        # plants a legacy repository and where every repository lived before the organisation.
        for owner in (cls.organisation, cls.machine_user):
            try:
                cls.forge(f"/api/v1/repos/{owner}/{cls.repo_name()}", method="DELETE")
            except urllib.error.HTTPError:
                pass  # Never created, which is the ordinary state before the first test.

    @classmethod
    def tearDownClass(cls):
        cls.delete_repo()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        self.delete_repo()
        # A throwaway keypair per test, so one test's key cannot satisfy another's assertion.
        self.key_dir = tempfile.mkdtemp(prefix="aber-deploy-key-")
        self.key_path = os.path.join(self.key_dir, "id_ed25519")
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test", "-f", self.key_path],
            check=True, capture_output=True,
        )
        with open(f"{self.key_path}.pub", encoding="utf-8") as handle:
            self.public_key = handle.read().strip()

    def tearDown(self):
        shutil.rmtree(self.key_dir, ignore_errors=True)

    def rule(self, name):
        """One branch protection rule by name. `**` is a rule name, not a glob, in this path."""
        quoted = urllib.parse.quote(name, safe="")
        return self.forge(
            f"/api/v1/repos/{self.organisation}/{self.repo_name()}/branch_protections/{quoted}"
        )

    def test_enrolment_creates_a_private_repository_and_confines_a_writable_key(self):
        """
        THE KEY IS WRITABLE AND THE BRANCH RULES ARE WHAT CONTAIN IT. `0104` made it so
        deliberately: the appliance pushes what it is actually running to `appliance`, which is
        the only report that cannot be forged by the thing being reported on. The property that
        matters is unchanged -- an appliance must not be able to author the flow it is later asked
        to deploy -- so it is asserted where it now lives, across all three rules at once. Any one
        of them alone is a key that can write somewhere it should not, and a clone looks identical
        either way.
        """
        token = self.issue_token()
        status, payload = enroll(token, ssh_public_key=self.public_key)

        self.assertEqual(status, 200, payload)
        self.assertIsNotNone(
            payload.get("repository"),
            "enrolment returned no repository -- the appliance has nothing to converge to",
        )
        self.assertTrue(payload["repository"]["ssh_url"].endswith(f"{self.repo_name()}.git"))
        self.assertEqual(payload["repository"]["branch"], "main")

        # THE ROW RECORDS STEP 4, not just step 3. Step 4 is non-fatal, so its own write failing
        # would leave the dashboard withholding links to a repository that exists -- which is the
        # safe direction, and the direction nothing else would report. Asserted here so the write
        # cannot quietly stop happening.
        self.assertIsNotNone(
            self.gateway()["forge_repository_at"],
            "the repository was created and the gateway row does not say so, so the dashboard will "
            "offer no links to it",
        )

        repo = self.forge(f"/api/v1/repos/{self.organisation}/{self.repo_name()}")
        self.assertTrue(
            repo["private"],
            "the gateway repository is PUBLIC -- a flows.json names the plant's brokers and devices",
        )

        keys = self.forge(f"/api/v1/repos/{self.organisation}/{self.repo_name()}/keys")
        self.assertEqual(len(keys), 1, keys)
        self.assertFalse(
            keys[0]["read_only"],
            "the deploy key is READ-ONLY -- the appliance cannot report what it is running, and "
            "the `appliance` branch would stay empty while everything else looked healthy",
        )

        self.assertFalse(
            self.rule("main")["push_whitelist_deploy_keys"],
            "`main` admits deploy keys -- the appliance could author the flow it is later asked "
            "to deploy, and an approved commit would stop being evidence that anyone approved it",
        )

        appliance = self.rule("appliance")
        self.assertTrue(
            appliance["push_whitelist_deploy_keys"],
            "the `appliance` rule refuses deploy keys -- the appliance cannot report at all",
        )
        self.assertFalse(
            appliance["enable_force_push"],
            "the `appliance` branch admits a force-push -- an appliance could rewrite what it "
            "previously reported, and the branch stops being a record",
        )

        self.assertFalse(
            self.rule("**")["push_whitelist_deploy_keys"],
            "the catch-all rule admits deploy keys -- a writable key would reach every branch "
            "except the two that are named, which is wider than anything it was granted for",
        )

    def test_the_wiki_is_seeded_with_the_gateway_and_never_overwritten(self):
        """
        THE WIKI IS THE UNREVIEWED HALF, seeded so the first person to open it finds the gateway
        named rather than an empty "create the first page" prompt, and told what does not belong
        there. Seeded ONCE: a re-enrolment (a re-flashed appliance) must leave what people wrote.
        """
        status, payload = enroll(self.issue_token(), ssh_public_key=self.public_key)
        self.assertEqual(status, 200, payload)
        home = f"/api/v1/repos/{self.organisation}/{self.repo_name()}/wiki/page/Home"
        text = base64.b64decode(self.forge(home)["content_base64"]).decode()
        self.assertIn(self.sparkplug_id, text)
        self.assertIn("not reviewed", text, "the page does not say the wiki is unreviewed")

        edited = base64.b64encode(b"# Edited by a person\n").decode()
        self.forge(home, method="PATCH", body={"title": "Home", "content_base64": edited})
        status, payload = enroll(self.issue_token(), ssh_public_key=self.public_key)
        self.assertEqual(status, 200, payload)
        self.assertEqual(
            self.forge(home)["content_base64"], edited,
            "re-enrolment overwrote a wiki page a person had edited",
        )

    def test_the_repository_carries_an_incident_template_and_its_label(self):
        """
        ISSUES ARE THE GATEWAY'S INCIDENT LOG, and the template is what makes that true rather than
        aspirational. Committed to `main` before the branch is protected -- the one moment the
        machine account may -- so it must be there on the first enrolment or never.
        """
        status, payload = enroll(self.issue_token(), ssh_public_key=self.public_key)
        self.assertEqual(status, 200, payload)
        repo = f"/api/v1/repos/{self.organisation}/{self.repo_name()}"
        templates = {t["file_name"] for t in self.forge(f"{repo}/issue_templates")}
        self.assertIn(".gitea/ISSUE_TEMPLATE/incident.md", templates, templates)
        labels = {label["name"] for label in self.forge(f"{repo}/labels")}
        self.assertIn("incident", labels, labels)
        # And `main` is protected afterwards, not instead: the seed did not cost the review gate.
        self.assertFalse(self.forge(f"{repo}/branch_protections/main")["enable_push"])

    def test_main_is_protected_and_a_merge_needs_an_administrator(self):
        """
        THE REVIEW GATE, in the forge's own terms. The appliance converges to `main`, so a branch
        anyone with write could push to is a branch anyone with write could deploy from; and a
        review whose approval can come from the same team that opened the request is a formality.
        Both are branch protection, applied at enrolment, and both would fail silently: a repository
        without them looks identical from a clone.
        """
        token = self.issue_token()
        status, payload = enroll(token, ssh_public_key=self.public_key)
        self.assertEqual(status, 200, payload)

        protection = self.forge(
            f"/api/v1/repos/{self.organisation}/{self.repo_name()}/branch_protections/main"
        )
        self.assertFalse(
            protection["enable_push"],
            "main accepts direct pushes -- anyone with write could deploy an unreviewed flow",
        )
        self.assertTrue(protection["enable_approvals_whitelist"])
        self.assertEqual(
            protection["approvals_whitelist_teams"], ["administrators"],
            "approval is not confined to administrators -- a manager could approve a manager",
        )
        self.assertGreaterEqual(protection["required_approvals"], 1)

    def test_both_teams_may_create_repositories_in_the_organisation(self):
        """
        An administrator opened "New repository", and the organisation was not offered as an owner:
        the teams were made with `can_create_org_repo` off. The design has repositories that exist
        before a gateway does, and people make those. Asserted on the teams enrolment finds or
        makes -- and a team made BEFORE this decision is patched rather than left, which is what the
        first half of this test forces by switching the flag off again.
        """
        token = self.issue_token()
        status, payload = enroll(token, ssh_public_key=self.public_key)
        self.assertEqual(status, 200, payload)

        teams = {t["name"]: t for t in self.forge(f"/api/v1/orgs/{self.organisation}/teams?limit=50")}
        for name in ("administrators", "managers"):
            self.assertTrue(teams[name]["can_create_org_repo"], f"'{name}' cannot create repositories")

        # A forge from before the decision: the flag is off, and the next enrolment must fix it.
        self.forge(f"/api/v1/teams/{teams['managers']['id']}", method="PATCH", body={"can_create_org_repo": False})
        self.delete_repo()
        status, payload = enroll(self.issue_token(), ssh_public_key=self.public_key)
        self.assertEqual(status, 200, payload)
        teams = {t["name"]: t for t in self.forge(f"/api/v1/orgs/{self.organisation}/teams?limit=50")}
        self.assertTrue(teams["managers"]["can_create_org_repo"], "an older team was not reconciled")

    def test_a_repository_from_before_the_organisation_is_transferred_in(self):
        """
        Repositories created before the organisation existed live under the machine account, where
        no login can see them. Re-enrolling such a gateway must MOVE that repository -- history,
        keys and all -- rather than create an empty twin beside it, which would be a gateway whose
        flow history quietly became unreachable on the day the forge got a door.
        """
        legacy = self.forge(
            "/api/v1/user/repos", method="POST",
            body={"name": self.repo_name(), "private": True, "auto_init": True, "default_branch": "main"},
        )
        self.assertEqual(legacy["owner"]["login"], self.machine_user)

        token = self.issue_token()
        status, payload = enroll(token, ssh_public_key=self.public_key)
        self.assertEqual(status, 200, payload)
        self.assertIsNotNone(payload.get("repository"), payload)

        moved = self.forge(f"/api/v1/repos/{self.organisation}/{self.repo_name()}")
        self.assertEqual(moved["owner"]["login"], self.organisation)
        self.assertEqual(moved["id"], legacy["id"], "the legacy repository was copied, not moved")
        # THE OLD PATH STILL ANSWERS, AND THAT IS GITEA'S DOING RATHER THAN A COPY LEFT BEHIND: a
        # transfer leaves a redirect from the old owner, so an appliance holding the old clone URL
        # keeps working. What matters is that it answers with the MOVED repository, not a twin.
        redirected = self.forge(f"/api/v1/repos/{self.machine_user}/{self.repo_name()}")
        self.assertEqual(redirected["id"], legacy["id"])
        self.assertEqual(redirected["owner"]["login"], self.organisation)

    def test_a_gateway_without_a_key_still_enrols(self):
        """
        An appliance whose bundle predates the forge, or whose ssh-keygen failed.

        THE GATEWAY IS THE POINT, NOT THE REPOSITORY. Telemetry needs nothing from the forge, so a
        missing key must cost the repository and nothing else.
        """
        token = self.issue_token()
        status, payload = enroll(token)

        self.assertEqual(status, 200, payload)
        self.assertIsNone(payload.get("repository"))
        self.assertTrue(payload.get("mqtt_password"), "the broker credential was not issued")
        row = self.gateway()
        self.assertEqual(row["status"], "AWAITING_BIRTH")
        # Enrolled, and no repository. The dashboard reads this column rather than `enrolled_at`,
        # so that it withholds links which would answer 404 instead of offering them.
        self.assertIsNone(row["forge_repository_at"])

    def test_a_malformed_key_is_refused_without_failing_the_enrolment(self):
        """
        Shape-checking happens before the forge is called, and its failure mode is a gateway with no
        repository -- never a rejected enrolment, and never an arbitrary string written into another
        system's authorised-keys list.
        """
        token = self.issue_token()
        status, payload = enroll(token, ssh_public_key="not-a-key; rm -rf /")

        self.assertEqual(status, 200, payload)
        self.assertIsNone(payload.get("repository"))
        self.assertTrue(payload.get("mqtt_password"))

    def published_host_key(self):
        """
        The forge's host key as it serves it, WITHOUT credentials.

        THAT IT NEEDS NO CREDENTIALS IS PART OF THE ASSERTION. `REQUIRE_SIGNIN_VIEW` is on, and if
        it ever covered `/assets/` this would answer a login page -- which `validPublicKey` would
        reject, leaving every appliance with no host key and no ability to converge. The failure
        would be silent at the forge and visible only on the gateways.
        """
        with urllib.request.urlopen(
            f"{self.forge_url}/assets/ssh_host_key.pub", timeout=15
        ) as response:
            return response.read().decode().strip()

    def test_the_forge_publishes_its_host_key_without_a_login(self):
        published = self.published_host_key()
        self.assertTrue(
            published.startswith("ssh-ed25519 "),
            f"/assets/ssh_host_key.pub did not serve a public key: {published[:120]!r}. "
            "gitea-init.sh publishes it on boot; a forge that has not restarted since "
            "host-key distribution landed will not have one.",
        )
        self.assertNotIn(
            "PRIVATE KEY", published,
            "the forge is serving a PRIVATE key over unauthenticated HTTP",
        )

    def test_enrolment_carries_a_known_hosts_line_for_the_forge(self):
        """
        THE ONE THING THAT MAKES THE PULL VERIFIABLE, and it has to ride on THIS response.

        An appliance with no known_hosts entry can only trust whatever key answers on its first
        connection -- trust on first use, decided at the moment an attacker would choose -- or be
        told to skip verification, which this platform refuses everywhere. This response is the
        alternative: TLS, a single-use token bound to one row, and the forge's identity learned
        before the first clone.

        THE HOST SPEC MUST MATCH THE CLONE URL or OpenSSH never consults the line. A non-default
        port is written `[host]:port` and matched on exactly that string, so a bare hostname beside
        a `:2222` clone URL is a file that names the forge and verifies nothing.
        """
        token = self.issue_token()
        status, payload = enroll(token, ssh_public_key=self.public_key)

        self.assertEqual(status, 200, payload)
        repository = payload.get("repository")
        self.assertIsNotNone(repository, "enrolment returned no repository")

        known_hosts = repository.get("known_hosts")
        self.assertTrue(
            known_hosts,
            "the enrolment carried no known_hosts line, so this appliance cannot verify the forge "
            "and flow-sync.mjs will refuse to converge",
        )

        host, algorithm, material = known_hosts.split()
        published_algorithm, published_material = self.published_host_key().split()[:2]
        self.assertEqual(algorithm, published_algorithm)
        self.assertEqual(
            material, published_material,
            "the known_hosts line does not carry the key the forge actually publishes",
        )

        ssh_url = repository["ssh_url"]
        # `ssh://git@host:2222/owner/repo.git` where the forge publishes SSH on a non-default port
        # (a non-default port), `git@host:owner/repo.git` where it is on 22 (the chart's LoadBalancer).
        match = (re.match(r"^ssh://(?:[^@/]+@)?([^/:]+)(?::(\d+))?", ssh_url)
                 or re.match(r"^(?:[^@/:]+@)?([^/:]+):(\d*)", ssh_url))
        self.assertIsNotNone(match, f"unexpected clone URL shape: {ssh_url}")
        expected = (
            f"[{match.group(1)}]:{match.group(2)}"
            if match.group(2) and match.group(2) != "22"
            else match.group(1)
        )
        self.assertEqual(
            host, expected,
            f"known_hosts names '{host}' but the clone URL is '{ssh_url}'. OpenSSH matches the "
            "host specification literally, so these two disagreeing means verification never "
            "consults the line at all.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
