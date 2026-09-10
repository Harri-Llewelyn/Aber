"""
Integration tests for the enroll-gateway edge function.

WHAT THIS FUNCTION IS, AND WHY ITS TESTS LOOK UNLIKE THE OTHER FUNCTIONS'. Every other edge function
authenticates a PERSON and checks a role. This one authenticates an APPLIANCE by possession of a
single-use token -- there is no user, no session, and the anon key is all that gets the request past
Kong. So the suite asserts a different set of properties:

  * the token is genuinely single-use, and unknown/expired/consumed are INDISTINGUISHABLE (telling
    them apart would let an enumerator learn that a token value once existed);
  * a race produces exactly ONE winner -- because mosquitto.acl pins the topic's edge-node segment
    to the connecting username, two credentials for one gateway would silently contend for one
    Sparkplug identity rather than failing;
  * a failure in the credential service RELEASES the claim, so a transient broker outage costs a
    retry rather than a manual re-issue per appliance. This is the property with the most moving
    parts and the least chance of being noticed if it regresses: everything still "works", right up
    until a broker restart during a commissioning window burns every bundle in the building.

Requires the stack up, and the service-role key (to mint tokens the way the dashboard does):

    SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... python \
        supabase/functions/enroll-gateway/test_enroll_gateway.py
"""
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
import uuid

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
CREDENTIAL_CONTAINER = os.getenv("CREDENTIAL_CONTAINER", "acs-cymru_gateway_credential")

# A physical gateway created and torn down by this suite. Pinned so a crashed run leaves a row the
# next setUpClass reclaims rather than accumulating gateways. Distinct from the migration suite's
# 2f/2e block -- these run against the same database and must not fight over one row.
TEST_GW_ID = "2d000000-0000-4000-8000-000000000001"


ADMIN_EMAIL = os.getenv("ACS_ADMIN_EMAIL", "admin@acs-cymru.local")
ADMIN_PASSWORD = os.getenv("ACS_ADMIN_PASSWORD", "acscymru123")


def rest(path, method="GET", body=None, key=None, bearer=None, prefer=None):
    """
    A PostgREST or RPC call.

    `key` is the apikey Kong checks; `bearer` is the identity PostgREST resolves. They are the same
    value for service_role and DIFFERENT for a signed-in user (anon key + their access token), which
    is exactly the distinction issue_gateway_enrollment_token() turns on.
    """
    key = key or SERVICE_ROLE_KEY
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {bearer or key}",
            "Content-Type": "application/json",
            "X-ACS-Cymru-Actor": "service",
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
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode())["access_token"]


def enroll(token, agent_version=None, key=None, ssh_public_key=None):
    """
    Call the function the way an APPLIANCE does: the anon key, and no user JWT.

    That is the auth contract under test -- Kong gates /functions/v1/ with key-auth, so the request
    needs an apikey, but nothing about it identifies a person.
    """
    key = ANON_KEY if key is None else key
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
        return err.code, (json.loads(raw) if raw.strip() else None)


@unittest.skipIf(not SERVICE_ROLE_KEY or not ANON_KEY,
                 "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set")
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
                "name": "Test_Physical_Gateway_Enrol",
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
        # The broker account outlives the row (the password file knows nothing about gateways), so
        # it is removed explicitly or it accumulates across runs.
        subprocess.run(
            ["docker", "exec", "acs-cymru_mosquitto", "sh", "-c",
             f"grep -v '^{cls.sparkplug_id}:' /mosquitto/config/password_file > /tmp/pf.$$ "
             f"&& cat /tmp/pf.$$ > /mosquitto/config/password_file && rm -f /tmp/pf.$$"],
            capture_output=True, text=True,
        )

    def issue_token(self, ttl_minutes=30):
        """Mint a token exactly as the dashboard does: anon key, Administrator's access token."""
        _, rows = rest(
            "/rpc/issue_gateway_enrollment_token", method="POST",
            key=ANON_KEY, bearer=self.admin_token,
            body={"p_gateway_id": TEST_GW_ID, "p_ttl_minutes": ttl_minutes},
        )
        return rows[0]["token"]

    def gateway(self):
        _, rows = rest(f"/gateways?id=eq.{TEST_GW_ID}&select=status,enrolled_at,agent_version")
        return rows[0]

    def setUp(self):
        # Every test starts from PENDING_ENROLLMENT with no live token, so one test's leftovers
        # cannot make the next one pass.
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH",
             body={"status": "OFFLINE", "enrolled_at": None, "agent_version": None})


class TestSuccessfulEnrolment(EnrollGatewayBase):
    def test_returns_the_complete_connection_payload(self):
        token = self.issue_token()
        status, payload = enroll(token, agent_version="1.4.2")

        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["status"], "ENROLLED")

        # IDENTITY. The username IS the sparkplug_id and cannot be anything else: mosquitto.acl
        # pins the topic's edge-node segment to %u, and verify_gateway_binding() compares the same
        # segment against the gateway row.
        self.assertEqual(payload["sparkplug_id"], self.sparkplug_id)
        self.assertEqual(payload["mqtt_username"], self.sparkplug_id)
        # The other half of the address resolve_gateway() looks up FIRST. An appliance told only the
        # node id falls through to the group-agnostic arm, which works until a second group exists.
        self.assertEqual(payload["sparkplug_group"], "ACS-Cymru")

        # ENDPOINT. Must be an address an appliance can actually resolve -- never the in-network
        # name, which the function refuses to emit.
        self.assertTrue(payload["mqtt_host"])
        self.assertNotIn(payload["mqtt_host"], ("mosquitto", "localhost", "127.0.0.1"))
        self.assertEqual(payload["mqtt_tls_port"], 8883)

        # CREDENTIAL. base64url, the alphabet the credential service enforces as an injection
        # boundary; returned exactly once and unrecoverable thereafter.
        self.assertRegex(payload["mqtt_password"], r"^[A-Za-z0-9_-]{16,128}$")

        # TRUST. Physical gateways connect over MQTTS only, so a PEM root is not optional.
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

    def test_the_issued_credential_works_against_the_broker(self):
        """
        The assertion that makes the rest meaningful. Everything above could pass against a function
        that returned a well-formed payload describing an account that does not exist.
        """
        token = self.issue_token()
        _, payload = enroll(token)

        publish = subprocess.run(
            ["docker", "exec", "acs-cymru_mosquitto", "mosquitto_pub",
             "--cafile", "/mosquitto/certs/ca.crt", "-h", "localhost", "-p", "8883",
             "-u", payload["mqtt_username"], "-P", payload["mqtt_password"],
             "-t", f"spBv1.0/{payload['sparkplug_group']}/DBIRTH/{payload['sparkplug_id']}/probe",
             "-m", "x"],
            capture_output=True, text=True,
        )
        self.assertEqual(publish.returncode, 0,
                         f"the enrolled credential was refused: {publish.stderr.strip()}")

    def test_the_ca_returned_verifies_the_broker_certificate(self):
        """The CA must be the one the broker is actually serving, not merely a valid PEM."""
        token = self.issue_token()
        _, payload = enroll(token)

        verify = subprocess.run(
            ["docker", "exec", "-i", CREDENTIAL_CONTAINER, "sh", "-c",
             "cat > /tmp/ca.pem && openssl verify -CAfile /tmp/ca.pem /mosquitto/certs/tls.crt"],
            input=payload["ca_cert"], capture_output=True, text=True,
        )
        # openssl is not in this image; fall back to comparing against the CA on disk, which is the
        # same assertion by a weaker route.
        if verify.returncode != 0 and "not found" in (verify.stderr or ""):
            on_disk = subprocess.run(
                ["docker", "exec", CREDENTIAL_CONTAINER, "cat", "/mosquitto/certs/ca.crt"],
                capture_output=True, text=True,
            ).stdout
            self.assertEqual(payload["ca_cert"].strip(), on_disk.strip())
        else:
            self.assertEqual(verify.returncode, 0, verify.stderr)


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
        Two appliances, one token. Because mosquitto.acl pins the topic to the username, two winners
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
            subprocess.run(["docker", "start", CREDENTIAL_CONTAINER],
                           capture_output=True, text=True)
            # Wait for it to answer again so the next test is not racing the restart.
            for _ in range(30):
                probe = subprocess.run(
                    ["docker", "exec", CREDENTIAL_CONTAINER, "wget", "-qO-",
                     "http://127.0.0.1:9010/healthz"],
                    capture_output=True, text=True,
                )
                if probe.returncode == 0:
                    break

    def test_returns_503_and_releases_the_claim(self):
        token = self.issue_token()

        subprocess.run(["docker", "stop", CREDENTIAL_CONTAINER], capture_output=True, text=True)
        self.stopped = True

        status, payload = enroll(token)
        self.assertEqual(status, 503, payload)
        self.assertTrue(payload["retryable"], payload)

        # The gateway must NOT have moved: it was never enrolled.
        self.assertEqual(self.gateway()["status"], "PENDING_ENROLLMENT")

        # THE CLAIM WAS RELEASED -- asserted by the token working once the service is back, which is
        # the behaviour that matters rather than the row's internal state.
        subprocess.run(["docker", "start", CREDENTIAL_CONTAINER], capture_output=True, text=True)
        for _ in range(30):
            probe = subprocess.run(
                ["docker", "exec", CREDENTIAL_CONTAINER, "wget", "-qO-",
                 "http://127.0.0.1:9010/healthz"],
                capture_output=True, text=True,
            )
            if probe.returncode == 0:
                break
        self.stopped = False

        retried, retry_payload = enroll(token)
        self.assertEqual(
            retried, 200,
            f"the SAME bundle could not be retried after a transient failure: {retry_payload}",
        )
        self.assertEqual(self.gateway()["status"], "AWAITING_BIRTH")


class TestAuthContract(EnrollGatewayBase):
    def test_the_anon_key_is_sufficient(self):
        """No user JWT anywhere in this flow -- an appliance has no session to present."""
        token = self.issue_token()
        status, _ = enroll(token, key=ANON_KEY)
        self.assertEqual(status, 200)

    def test_kong_refuses_a_request_with_no_apikey(self):
        """key-auth is the gateway's layer; the enrolment token is the function's."""
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
            method="GET", headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=15)
        self.assertEqual(caught.exception.code, 405)



class TestForgeProvisioning(EnrollGatewayBase):
    """
    Roadmap 7's third credential plane: the gateway's own repository, and the READ-ONLY deploy key
    it reads that repository with.

    WHAT MAKES THIS WORTH TESTING RATHER THAN EYEBALLING. Three of its properties fail silently:

      * a deploy key registered WRITABLE lets an appliance author the flow it will later be asked to
        deploy, which empties the review step of its meaning -- and nothing about a working clone
        would reveal it;
      * a repository created PUBLIC exposes the plant's edge topology, and reads identically to a
        private one from the appliance's side;
      * a forge failure that is treated as fatal would refuse an enrolment whose token is already
        spent and whose broker credential already exists, turning a forge outage into a manual
        re-issue per appliance.

    SKIPPED, NOT FAILED, where no forge is configured. The integration is optional at both ends by
    design -- an install predating roadmap 7 enrols exactly as it did before.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.forge_url = os.getenv("GITEA_TEST_URL", "http://127.0.0.1:3003")
        cls.machine_user = os.getenv("GITEA_MACHINE_USER", "acs_platform")
        cls.machine_password = os.getenv(
            "GITEA_MACHINE_PASSWORD", "acs-platform-machine-account"
        )
        # Every gateway repository lives in this organisation (forge.ts); the machine account owns
        # it, which is exactly the authority to create a repository in it and no more.
        cls.organisation = os.getenv("GITEA_ORGANISATION", "gateways")
        try:
            cls.forge("/api/v1/version")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no forge"
            raise unittest.SkipTest(f"no forge reachable at {cls.forge_url}: {err}")

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
        self.key_dir = tempfile.mkdtemp(prefix="acs-deploy-key-")
        self.key_path = os.path.join(self.key_dir, "id_ed25519")
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test", "-f", self.key_path],
            check=True, capture_output=True,
        )
        with open(f"{self.key_path}.pub", encoding="utf-8") as handle:
            self.public_key = handle.read().strip()

    def tearDown(self):
        shutil.rmtree(self.key_dir, ignore_errors=True)

    def test_enrolment_creates_a_private_repository_and_a_read_only_key(self):
        token = self.issue_token()
        status, payload = enroll(token, ssh_public_key=self.public_key)

        self.assertEqual(status, 200, payload)
        self.assertIsNotNone(
            payload.get("repository"),
            "enrolment returned no repository -- the appliance has nothing to converge to",
        )
        self.assertTrue(payload["repository"]["ssh_url"].endswith(f"{self.repo_name()}.git"))
        self.assertEqual(payload["repository"]["branch"], "main")

        repo = self.forge(f"/api/v1/repos/{self.organisation}/{self.repo_name()}")
        self.assertTrue(
            repo["private"],
            "the gateway repository is PUBLIC -- a flows.json names the plant's brokers and devices",
        )

        keys = self.forge(f"/api/v1/repos/{self.organisation}/{self.repo_name()}/keys")
        self.assertEqual(len(keys), 1, keys)
        self.assertTrue(
            keys[0]["read_only"],
            "the deploy key is WRITABLE -- an appliance could author the flow it is later asked "
            "to deploy, and an approved commit would stop being evidence that anyone approved it",
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
        self.assertEqual(self.gateway()["status"], "AWAITING_BIRTH")

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
            "gitea-init.sh publishes it on boot; a forge that has not restarted since roadmap 7's "
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
        told to skip verification, which roadmap 7 and 11 both refuse. This response is the
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
        match = re.match(r"^ssh://(?:[^@/]+@)?([^/:]+)(?::(\d+))?", ssh_url)
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
