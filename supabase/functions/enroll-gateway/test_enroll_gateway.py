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
import json
import os
import subprocess
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


def enroll(token, agent_version=None, key=None):
    """
    Call the function the way an APPLIANCE does: the anon key, and no user JWT.

    That is the auth contract under test -- Kong gates /functions/v1/ with key-auth, so the request
    needs an apikey, but nothing about it identifies a person.
    """
    key = ANON_KEY if key is None else key
    payload = {"token": token}
    if agent_version:
        payload["agent_version"] = agent_version

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
