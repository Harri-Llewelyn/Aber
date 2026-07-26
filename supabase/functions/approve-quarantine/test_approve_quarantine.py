"""
Unit test suite for approve-quarantine Supabase Edge Function authorization logic.
Verifies fail-closed behavior for missing or non-privileged role claims.
"""
import unittest

def evaluate_approve_quarantine_authorization(user: dict) -> tuple[int, str]:
    """
    Python mirror of the authorization logic in supabase/functions/approve-quarantine/index.ts.
    """
    if not user:
        return 401, "Invalid user token"

    app_metadata = user.get("app_metadata", {})
    user_role = app_metadata.get("role") or None
    allowed_roles = ["Administrator", "Shopfloor_Manager"]

    if not user_role or user_role not in allowed_roles:
        return 403, "Forbidden: Insufficient privileges"

    return 200, "Authorized"

class TestApproveQuarantineAuth(unittest.TestCase):

    def test_missing_role_claim_returns_403(self):
        """User token with no role in app_metadata must fail closed with 403."""
        user = {
            "id": "usr-no-role-123",
            "app_metadata": {},
            "user_metadata": {}
        }
        status, message = evaluate_approve_quarantine_authorization(user)
        self.assertEqual(status, 403)
        self.assertIn("Forbidden", message)

    def test_privileged_role_in_user_metadata_only_returns_403(self):
        """User setting user_metadata.role = 'Administrator' must be rejected with 403."""
        user = {
            "id": "usr-attacker-000",
            "app_metadata": {},
            "user_metadata": {"role": "Administrator"}
        }
        status, message = evaluate_approve_quarantine_authorization(user)
        self.assertEqual(status, 403)
        self.assertIn("Forbidden", message)

    def test_operator_role_returns_403(self):
        """User token with role 'Operator' (non-privileged) must fail closed with 403."""
        user = {
            "id": "usr-op-456",
            "app_metadata": {"role": "Operator"},
            "user_metadata": {}
        }
        status, message = evaluate_approve_quarantine_authorization(user)
        self.assertEqual(status, 403)
        self.assertIn("Forbidden", message)

    def test_shopfloor_manager_role_returns_200(self):
        """User token with role 'Shopfloor_Manager' must succeed authorization."""
        user = {
            "id": "usr-mgr-789",
            "app_metadata": {"role": "Shopfloor_Manager"},
            "user_metadata": {}
        }
        status, message = evaluate_approve_quarantine_authorization(user)
        self.assertEqual(status, 200)

    def test_administrator_role_returns_200(self):
        """User token with role 'Administrator' must succeed authorization."""
        user = {
            "id": "usr-admin-000",
            "app_metadata": {"role": "Administrator"},
            "user_metadata": {}
        }
        status, message = evaluate_approve_quarantine_authorization(user)
        self.assertEqual(status, 200)

if __name__ == "__main__":
    unittest.main()
