"""
Unit test suite for the approve-quarantine Supabase Edge Function.

Covers the fail-closed authorization logic (missing or non-privileged role claims) and the
location patch composition added with migration 0036 -- specifically that an unanswered cell is
omitted rather than defaulted, which is what keeps devices.cell_id's NULL-means-inherit intact.
"""
import os
import re
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


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def evaluate_location_patch(body: dict) -> tuple[int, dict]:
    """
    Python mirror of the cell_id / location_scope handling in index.ts.

    Returns (status, patch_fragment). The distinction that matters is between a key that is
    ABSENT (the operator did not answer, so the column is not written and devices.cell_id stays
    NULL-means-inherit) and one that is present but empty (the picker's explicit "Inherit"
    option, written as NULL). Defaulting the absent case would turn inheritance off for every
    device approved through this function.
    """
    patch: dict = {}

    if "cell_id" in body:
        cell_id = body["cell_id"]
        trimmed = cell_id.strip() if isinstance(cell_id, str) else cell_id
        if trimmed and not UUID_RE.match(str(trimmed)):
            return 400, {}
        patch["cell_id"] = trimmed or None

    if "location_scope" in body:
        scope = body["location_scope"]
        if scope not in ("cell", "site_wide"):
            return 400, {}
        patch["location_scope"] = scope
        if scope == "site_wide":
            patch["cell_id"] = None

    return 200, patch


class TestApproveQuarantineLocation(unittest.TestCase):

    def test_absent_location_is_not_written(self):
        """The load-bearing case: no answer means no write, so the device inherits."""
        status, patch = evaluate_location_patch({"device_id": "d", "gateway_id": "g"})
        self.assertEqual(status, 200)
        self.assertNotIn("cell_id", patch)
        self.assertNotIn("location_scope", patch)

    def test_empty_cell_id_is_written_as_null(self):
        """The picker's explicit Inherit option, which is different from not answering."""
        status, patch = evaluate_location_patch({"cell_id": ""})
        self.assertEqual(status, 200)
        self.assertIsNone(patch["cell_id"])

    def test_explicit_cell_is_written(self):
        cell = "aaaaaaaa-0000-4000-8000-000000000000"
        status, patch = evaluate_location_patch({"cell_id": cell})
        self.assertEqual(status, 200)
        self.assertEqual(patch["cell_id"], cell)

    def test_non_uuid_cell_is_rejected(self):
        status, _ = evaluate_location_patch({"cell_id": "Assembly Cell"})
        self.assertEqual(status, 400)

    def test_site_wide_clears_the_cell(self):
        """
        Mirrors devices_site_wide_has_no_cell. Without this the CHECK rejects the write and the
        operator gets a constraint violation instead of an approval.
        """
        status, patch = evaluate_location_patch({
            "cell_id": "aaaaaaaa-0000-4000-8000-000000000000",
            "location_scope": "site_wide"
        })
        self.assertEqual(status, 200)
        self.assertIsNone(patch["cell_id"])
        self.assertEqual(patch["location_scope"], "site_wide")

    def test_unknown_scope_is_rejected(self):
        status, _ = evaluate_location_patch({"location_scope": "building"})
        self.assertEqual(status, 400)


class TestApproveQuarantineMirrorsSource(unittest.TestCase):
    """
    Guards the mirror above against drift, the way test_aas_export.py guards its duplicated
    datatype mapper: a hand-written copy of logic in another language is only useful while it
    still matches.
    """

    def setUp(self):
        source_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.ts")
        with open(source_path, "r", encoding="utf-8") as handle:
            self.source = handle.read()

    def test_source_still_omits_location_when_not_supplied(self):
        self.assertIn("cell_id !== undefined", self.source)
        self.assertIn("location_scope !== undefined", self.source)

    def test_source_still_clears_the_cell_for_site_wide(self):
        self.assertIn('if (location_scope === "site_wide") patch.cell_id = null;', self.source)

    def test_source_still_constrains_the_scope_to_the_check_constraint_values(self):
        self.assertIn('location_scope !== "cell" && location_scope !== "site_wide"', self.source)


if __name__ == "__main__":
    unittest.main()
