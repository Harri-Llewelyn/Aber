"""
Unit test suite for deploy-nodered Supabase Edge Function authorization logic.
Verifies fail-closed behavior for missing or non-privileged role claims, and that the
endpoint deploys only the flow committed to the repository.
"""
import re
import unittest
from pathlib import Path

INDEX_TS = Path(__file__).resolve().parent / "index.ts"

def evaluate_deploy_nodered_authorization(user: dict, auth_header: str = None) -> tuple[int, str]:
    """
    Python mirror of the authorization logic in supabase/functions/deploy-nodered/index.ts.
    """
    if not auth_header:
        return 401, "Missing Authorization header"

    if not user:
        return 401, "Invalid user token"

    app_metadata = user.get("app_metadata", {})
    user_role = app_metadata.get("role") or None
    allowed_roles = ["Administrator", "Shopfloor_Manager"]

    if not user_role or user_role not in allowed_roles:
        return 403, "Forbidden: Insufficient privileges"

    return 200, "Authorized"

class TestDeployNoderedAuth(unittest.TestCase):

    def test_missing_auth_header_returns_401(self):
        """Request without Authorization header must fail with 401."""
        status, message = evaluate_deploy_nodered_authorization(user={}, auth_header=None)
        self.assertEqual(status, 401)
        self.assertIn("Missing Authorization header", message)

    def test_invalid_user_token_returns_401(self):
        """Invalid user token must fail with 401."""
        status, message = evaluate_deploy_nodered_authorization(user=None, auth_header="Bearer invalid_token")
        self.assertEqual(status, 401)
        self.assertIn("Invalid user token", message)

    def test_missing_role_claim_returns_403(self):
        """User token with no role in app_metadata must fail closed with 403."""
        user = {
            "id": "usr-no-role-123",
            "app_metadata": {},
            "user_metadata": {}
        }
        status, message = evaluate_deploy_nodered_authorization(user, auth_header="Bearer valid_token")
        self.assertEqual(status, 403)
        self.assertIn("Forbidden", message)

    def test_privileged_role_in_user_metadata_only_returns_403(self):
        """User setting user_metadata.role = 'Administrator' must be rejected with 403."""
        user = {
            "id": "usr-attacker-000",
            "app_metadata": {},
            "user_metadata": {"role": "Administrator"}
        }
        status, message = evaluate_deploy_nodered_authorization(user, auth_header="Bearer valid_token")
        self.assertEqual(status, 403)
        self.assertIn("Forbidden", message)

    def test_operator_role_returns_403(self):
        """User token with role 'Operator' (non-privileged) must fail closed with 403."""
        user = {
            "id": "usr-op-456",
            "app_metadata": {"role": "Operator"},
            "user_metadata": {}
        }
        status, message = evaluate_deploy_nodered_authorization(user, auth_header="Bearer valid_token")
        self.assertEqual(status, 403)
        self.assertIn("Forbidden", message)

    def test_shopfloor_manager_role_returns_200(self):
        """User token with role 'Shopfloor_Manager' must succeed authorization."""
        user = {
            "id": "usr-mgr-789",
            "app_metadata": {"role": "Shopfloor_Manager"},
            "user_metadata": {}
        }
        status, message = evaluate_deploy_nodered_authorization(user, auth_header="Bearer valid_token")
        self.assertEqual(status, 200)

    def test_administrator_role_returns_200(self):
        """User token with role 'Administrator' must succeed authorization."""
        user = {
            "id": "usr-admin-000",
            "app_metadata": {"role": "Administrator"},
            "user_metadata": {}
        }
        status, message = evaluate_deploy_nodered_authorization(user, auth_header="Bearer valid_token")
        self.assertEqual(status, 200)

class TestOnlyTheCanonicalFlowIsDeployable(unittest.TestCase):
    """
    Guards the GitOps contract at the source level.

    A Node-RED `function` node runs arbitrary JavaScript inside the Node-RED container, which
    holds the MQTT credential and can reach Mosquitto, Supabase and TimescaleDB. The endpoint
    therefore must never deploy a flow supplied by the caller -- doing so hands remote code
    execution on the edge host to every role allowed through the authorization ladder above.

    Asserted against the source because there is no Deno runtime in this suite, the same
    approach test_aas_export.py uses to guard the Sparkplug -> XSD mapper against drift.
    """

    @classmethod
    def setUpClass(cls):
        cls.source = INDEX_TS.read_text(encoding="utf-8")

    def test_an_inline_flow_array_is_rejected_not_deployed(self):
        """A request body that is a flow array must be refused, never assigned to `flow`."""
        self.assertNotRegex(
            self.source,
            r"flow\s*=\s*body\b",
            "deploy-nodered assigns the request body to the deployed flow -- this is the "
            "arbitrary-code-execution path that was removed; it must not come back.",
        )
        self.assertIn(
            "Inline flow deployment is not supported",
            self.source,
            "deploy-nodered must explicitly refuse an inline flow array.",
        )

    def test_the_deployed_flow_comes_only_from_the_canonical_loader(self):
        """`flow` must be populated from loadCanonicalFlow() and from nothing else."""
        assignments = re.findall(r"^\s*flow\s*=\s*(.+?);", self.source, re.MULTILINE)
        self.assertTrue(assignments, "no assignment to `flow` found -- has the file moved?")
        for assigned in assignments:
            self.assertEqual(
                assigned.strip(),
                "loadCanonicalFlow()",
                f"`flow` is assigned from '{assigned.strip()}'; the only permitted source is "
                "loadCanonicalFlow().",
            )


class TestTheDeployRequestIsAlwaysAuthenticated(unittest.TestCase):
    """
    Guards the fix for "Node-RED admin API and editor are unauthenticated on port 1880".

    The old code attached a bearer token to the outbound POST /flows only when
    NODERED_ADMIN_TOKEN was set, and sent the flow bare otherwise. That was correct while
    Node-RED ran without adminAuth -- and it is exactly what made the hole survivable, because
    a deploy kept working against an unsecured Node-RED and nothing ever failed to signal it.

    Now the header is unconditional: the break-glass token when one is configured, otherwise the
    caller's own Supabase access token, which Node-RED's adminAuth.tokens() re-validates against
    public.user_roles. A regression to a conditional header would silently restore the tolerance
    for an unauthenticated Node-RED, so it is asserted at the source level -- the same approach
    TestOnlyTheCanonicalFlowIsDeployable and test_aas_export.py use.
    """

    @classmethod
    def setUpClass(cls):
        cls.source = INDEX_TS.read_text(encoding="utf-8")

    def test_authorization_is_set_unconditionally_not_inside_an_if(self):
        """The header must be a plain property of nodeRedHeaders, not a conditional assignment."""
        self.assertNotRegex(
            self.source,
            r"if\s*\(\s*nodeRedAdminToken\s*\)\s*\{\s*\n\s*nodeRedHeaders\.Authorization",
            "deploy-nodered attaches Authorization only when NODERED_ADMIN_TOKEN is set. That "
            "makes a deploy succeed against an unauthenticated Node-RED, which is the "
            "regression this test exists to catch.",
        )
        self.assertRegex(
            self.source,
            r"Authorization:\s*nodeRedAdminToken\s*\?\s*`Bearer \$\{nodeRedAdminToken\}`\s*:\s*authHeader",
            "the outbound request must carry the break-glass token when configured and the "
            "caller's own Authorization header otherwise.",
        )

    def test_the_caller_token_is_the_default_path(self):
        """authHeader -- the caller's token -- must reach the Node-RED request."""
        headers_block = re.search(
            r"const nodeRedHeaders[^;]+?;", self.source, re.DOTALL
        )
        self.assertIsNotNone(headers_block, "nodeRedHeaders declaration not found -- has it moved?")
        self.assertIn(
            "authHeader",
            headers_block.group(0),
            "the default (no break-glass token) path must forward the caller's access token; "
            "without it the default stack falls back to an unauthenticated deploy.",
        )


if __name__ == "__main__":
    unittest.main()
