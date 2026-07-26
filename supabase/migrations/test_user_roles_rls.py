"""
Unit test suite for user_roles Row-Level Security (RLS) policy logic.
Verifies that users can only select their own user_roles row unless they have
privileged roles ('Administrator' or 'Shopfloor_Manager').
"""
import unittest

def evaluate_user_roles_select_policy(auth_uid: str, jwt_app_metadata: dict, record_user_id: str) -> bool:
    """
    Python mirror of the USING clause in 20260101000004_fix_user_roles_rls.sql:
    (user_id = auth.uid()::text OR (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'))
    """
    if auth_uid and record_user_id == auth_uid:
        return True

    user_role = jwt_app_metadata.get("role") if jwt_app_metadata else None
    if user_role in ("Administrator", "Shopfloor_Manager"):
        return True

    return False

class TestUserRolesRLS(unittest.TestCase):

    def test_operator_can_read_own_user_roles(self):
        """Operator reading their own user_id record must succeed (True)."""
        operator_uid = "usr-operator-123"
        jwt_metadata = {"role": "Operator"}
        allowed = evaluate_user_roles_select_policy(operator_uid, jwt_metadata, operator_uid)
        self.assertTrue(allowed)

    def test_operator_cannot_read_other_user_roles(self):
        """Operator attempting to read another user's user_roles record must be denied (False)."""
        operator_uid = "usr-operator-123"
        other_user_id = "usr-target-456"
        jwt_metadata = {"role": "Operator"}
        allowed = evaluate_user_roles_select_policy(operator_uid, jwt_metadata, other_user_id)
        self.assertFalse(allowed)

    def test_auditor_cannot_read_other_user_roles(self):
        """Auditor attempting to read another user's user_roles record must be denied (False)."""
        auditor_uid = "usr-auditor-789"
        other_user_id = "usr-target-456"
        jwt_metadata = {"role": "Auditor"}
        allowed = evaluate_user_roles_select_policy(auditor_uid, jwt_metadata, other_user_id)
        self.assertFalse(allowed)

    def test_administrator_can_read_other_user_roles(self):
        """Administrator reading any user's user_roles record must succeed (True)."""
        admin_uid = "usr-admin-000"
        other_user_id = "usr-target-456"
        jwt_metadata = {"role": "Administrator"}
        allowed = evaluate_user_roles_select_policy(admin_uid, jwt_metadata, other_user_id)
        self.assertTrue(allowed)

    def test_shopfloor_manager_can_read_other_user_roles(self):
        """Shopfloor_Manager reading any user's user_roles record must succeed (True)."""
        manager_uid = "usr-manager-111"
        other_user_id = "usr-target-456"
        jwt_metadata = {"role": "Shopfloor_Manager"}
        allowed = evaluate_user_roles_select_policy(manager_uid, jwt_metadata, other_user_id)
        self.assertTrue(allowed)

if __name__ == "__main__":
    unittest.main()
