# suite:
#   lanes: stack
#   why: gateway-bundle answers 400 for an archived gateway, names the reason, and mints no setup
#     token, so its row stays as archiving left it. SKIPS without a stack.

"""
An archived gateway is refused a bundle and an install command.

`issue_gateway_enrollment_token()` refuses an archived gateway (0309), and `gateway-bundle` says so
itself before it asks for a token, so a client reads "That gateway is archived" rather than "Could
not issue an enrolment token". The dashboard never offers Set Up Gateway for an archived gateway, so
only an API client reaches this, as a Shopfloor Manager here.

Requires the stack up and SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY:

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
        python supabase/functions/gateway-bundle/test_an_archived_gateway_is_refused_a_bundle.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_gateway_bundle import PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, download, rest, sign_in  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "test-harness"))
import stack_sign_in  # noqa: E402

# Differs from test_gateway_bundle's fixtures in its first characters, since a gateway's Sparkplug id
# is taken from the start of its id.
ARCHIVED_GW = "2c5a0000-0000-4000-8000-000000000001"


@unittest.skipIf(not PUBLISHABLE_KEY or not SERVICE_ROLE_KEY,
                 "SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
class AnArchivedGatewayIsRefusedABundle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")
        # Signed in before the row is deleted or made: a class that skips changes nothing.
        try:
            cls.manager = sign_in("manager@aber.local")
        except stack_sign_in.RateLimited:
            raise
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"could not sign in as manager@aber.local: {err}")
        cls.addClassCleanup(rest, f"/gateways?id=eq.{ARCHIVED_GW}", method="DELETE")
        rest(f"/gateways?id=eq.{ARCHIVED_GW}", method="DELETE")
        rest("/gateways", method="POST", body=[{
            "id": ARCHIVED_GW, "name": "Test Archived Bundle Gateway", "status": "OFFLINE", "deployment": "remote",
        }])
        rest(f"/gateways?id=eq.{ARCHIVED_GW}", method="PATCH", body={"is_archived": True})

    def tokens(self):
        _, rows = rest(f"/gateway_enrollment_tokens?gateway_id=eq.{ARCHIVED_GW}&select=id")
        return rows or []

    def test_the_bundle_is_refused_with_the_reason(self):
        status, body, _ = download(ARCHIVED_GW, self.manager)
        self.assertEqual(status, 400, body)
        self.assertEqual(body.get("error"), "That gateway is archived", body)

    def test_no_token_is_minted_and_the_row_is_left_as_archiving_left_it(self):
        download(ARCHIVED_GW, self.manager)
        self.assertEqual(self.tokens(), [], "a setup token was written for an archived gateway")
        _, rows = rest(f"/gateways?id=eq.{ARCHIVED_GW}&select=status,is_archived")
        self.assertEqual(rows, [{"status": "OFFLINE", "is_archived": True}])


if __name__ == "__main__":
    unittest.main(verbosity=2)
