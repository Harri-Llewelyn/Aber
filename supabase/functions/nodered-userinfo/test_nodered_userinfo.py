"""
Unit test suite for the nodered-userinfo Supabase Edge Function.

This endpoint is what stands between "can reach port 1880" and "can deploy a flow", so its
fail-closed behaviour is the whole of Node-RED's authorization. Two properties matter:

  * an unmapped, revoked or unreadable role must yield NO `permissions` key at all, because
    settings.js keys its refusal on the key's absence. Guessing 'read' would silently admit a
    user whose access was revoked;
  * the role must come from public.user_roles and never from the caller's own token claims.
    Deleting a user's user_roles row IS how a role is revoked, so an app_metadata fallback
    re-grants the privilege for as long as the token lives.

The behavioural half is a Python mirror of index.ts, as in test_deploy_nodered.py; the source
assertions guard the two properties above against a well-intentioned "make login work again"
edit, since there is no Deno runtime in this suite.
"""
import re
import unittest
from pathlib import Path

INDEX_TS = Path(__file__).resolve().parent / "index.ts"

# A COPY of the map in index.ts. TestSourceInvariants.test_permission_map_matches_this_suite parses
# the real one and compares -- without it, narrowing the endpoint and forgetting this dict leaves
# a suite that passes while asserting the deploy authority the endpoint used to hand out.
PERMISSION_MAP = {
    "Administrator": "*",
    "Shopfloor_Manager": "read",
    "Operator": "read",
    "Auditor": "read",
}


def evaluate_nodered_userinfo(
    user: dict | None,
    auth_header: str | None = None,
    user_roles_row: dict | None = None,
    role_lookup_failed: bool = False,
) -> tuple[int, dict]:
    """
    Python mirror of supabase/functions/nodered-userinfo/index.ts.

    `user_roles_row` models the public.user_roles join result: None means no row, which is what
    a revoked role looks like.
    """
    if not auth_header:
        return 401, {"error": "Missing Authorization header"}

    if not user:
        return 401, {"error": "Invalid user token"}

    db_role = None
    if not role_lookup_failed and user_roles_row:
        candidate = (user_roles_row.get("roles") or {}).get("name")
        if isinstance(candidate, str):
            db_role = candidate

    permissions = PERMISSION_MAP.get(db_role) if db_role else None

    body = {
        "sub": user["id"],
        "email": user.get("email"),
        "email_verified": bool(user.get("email_confirmed_at")),
        "name": user.get("email"),
        "preferred_username": user.get("email"),
        "supabase_role": db_role,
    }
    if permissions:
        body["permissions"] = permissions

    return 200, body


ADMIN = {"id": "usr-admin-000", "email": "admin@aber.local", "email_confirmed_at": "now"}


class TestNoderedUserinfoAuthentication(unittest.TestCase):

    def test_missing_auth_header_returns_401(self):
        status, body = evaluate_nodered_userinfo(user=ADMIN, auth_header=None)
        self.assertEqual(status, 401)
        self.assertIn("Missing Authorization header", body["error"])

    def test_invalid_user_token_returns_401(self):
        status, body = evaluate_nodered_userinfo(user=None, auth_header="Bearer nope")
        self.assertEqual(status, 401)
        self.assertIn("Invalid user token", body["error"])


class TestPermissionMapping(unittest.TestCase):

    def _permissions_for(self, role_name: str | None) -> dict:
        row = {"roles": {"name": role_name}} if role_name else None
        _, body = evaluate_nodered_userinfo(ADMIN, "Bearer valid", user_roles_row=row)
        return body

    def test_administrator_gets_full_permissions(self):
        self.assertEqual(self._permissions_for("Administrator")["permissions"], "*")

    def test_shopfloor_manager_is_read_only(self):
        """
        THIS TEST USED TO ASSERT '*', and the inversion is 0069 rather than a tightened default.

        `gitops:manage` is Administrator-only now, and the Node-RED editor is the SECOND door onto
        it: the Directory page's Sync button goes through deploy-nodered, the editor deploys
        directly. Narrowing one and not the other produces a manager who cannot press the button
        and can still deploy -- worse than before, because it reads as a control.

        'read' rather than absent: the editor still opens and the running flow is still
        inspectable, which is most of what the page is for when the shopfloor is misbehaving.
        """
        self.assertEqual(self._permissions_for("Shopfloor_Manager")["permissions"], "read")

    def test_operator_is_read_only(self):
        self.assertEqual(self._permissions_for("Operator")["permissions"], "read")

    def test_auditor_is_read_only(self):
        self.assertEqual(self._permissions_for("Auditor")["permissions"], "read")


class TestFailClosed(unittest.TestCase):
    """The `permissions` key must be ABSENT, not defaulted, whenever the role is not known."""

    def test_no_user_roles_row_omits_permissions(self):
        """A revoked role -- the row deleted -- must not yield read-only access."""
        _, body = evaluate_nodered_userinfo(ADMIN, "Bearer valid", user_roles_row=None)
        self.assertNotIn("permissions", body)
        self.assertIsNone(body["supabase_role"])

    def test_unmapped_role_omits_permissions(self):
        """A role that exists but has no Node-RED equivalent is a provisioning error."""
        _, body = evaluate_nodered_userinfo(
            ADMIN, "Bearer valid", user_roles_row={"roles": {"name": "Contractor"}}
        )
        self.assertNotIn("permissions", body)

    def test_failed_role_lookup_omits_permissions(self):
        """A failed query is not evidence of a role."""
        _, body = evaluate_nodered_userinfo(
            ADMIN,
            "Bearer valid",
            user_roles_row={"roles": {"name": "Administrator"}},
            role_lookup_failed=True,
        )
        self.assertNotIn("permissions", body)


class TestSourceInvariants(unittest.TestCase):
    """
    Asserted against index.ts because there is no Deno runtime here -- the same approach
    test_deploy_nodered.py and test_aas_export.py take.
    """

    @classmethod
    def setUpClass(cls):
        cls.source = INDEX_TS.read_text(encoding="utf-8")
        # Comments are stripped for the negative assertions below. The header comment explains at
        # length why app_metadata is NOT read, so a naive substring test on the raw file fails on
        # the very prose that documents the invariant -- and the obvious "fix" is to delete the
        # explanation. Assert against the code; keep the reasoning.
        without_blocks = re.sub(r"/\*.*?\*/", "", cls.source, flags=re.DOTALL)
        cls.code = "\n".join(
            line for line in without_blocks.splitlines() if not line.strip().startswith("//")
        )

    def test_the_role_is_never_read_from_token_claims(self):
        """app_metadata must not appear in the code: it is the revocation-defeating fallback."""
        self.assertNotIn(
            "app_metadata",
            self.code,
            "nodered-userinfo reads app_metadata. Deleting a user's public.user_roles row is "
            "how a role is revoked, so a claim fallback re-grants the old privilege for the "
            "life of the token. public.user_roles is the only source.",
        )

    def test_permissions_is_conditionally_assigned_never_defaulted(self):
        """`permissions` must be added only when a mapping was found."""
        self.assertRegex(
            self.code,
            r"if\s*\(permissions\)\s*body\.permissions\s*=\s*permissions",
            "the permissions key must be omitted when the role is unmapped -- settings.js keys "
            "its refusal on the key's absence.",
        )
        self.assertNotRegex(
            self.code,
            r"permissions[^\n]*\?\?\s*[\"']read[\"']",
            "an unmapped role must not fall back to read-only; that silently admits a user "
            "whose role was revoked.",
        )

    def test_permission_map_matches_this_suite(self):
        """The mapping asserted above must be the one the function actually ships."""
        block = re.search(
            r"const PERMISSION_MAP: Record<string, string> = \{(.+?)\};", self.source, re.DOTALL
        )
        self.assertIsNotNone(block, "PERMISSION_MAP not found -- has it moved?")
        found = dict(re.findall(r"(\w+):\s*\"([^\"]+)\"", block.group(1)))
        self.assertEqual(found, PERMISSION_MAP)


if __name__ == "__main__":
    unittest.main()
