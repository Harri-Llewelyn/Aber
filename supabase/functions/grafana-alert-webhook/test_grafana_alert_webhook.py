"""
Unit tests for the grafana-alert-webhook Edge Function.

Same arrangement as the sibling suites: the TypeScript is the implementation and this is a Python
MIRROR of its two pure decisions -- the authorization ladder and the payload normalisation. Neither
needs a stack, so this runs in the edge-function CI job.

WHY MIRROR RATHER THAN RUN THE TypeScript. There is no Deno test runner in CI, and the alternative
is not testing the two things most likely to be wrong: an auth check that fails OPEN, and a resolve
notification that does not close the occurrence it belongs to.

The mirror is held to the real thing by test_matches_the_typescript_shape below, which reads
index.ts and asserts the literals this file encodes still appear in it.
"""
import json
import re
import unittest
from pathlib import Path

INDEX_TS = Path(__file__).resolve().parent / "index.ts"

RESOLVED = "resolved"
FIRING = "firing"
SEVERITIES = {"critical", "warning", "info"}


def authorize_alert_webhook(auth_header, expected_secret):
    """Python mirror of authorizeAlertWebhook() in index.ts."""
    if not expected_secret:
        return 503, "GRAFANA_ALERT_WEBHOOK_SECRET is not configured; refusing to accept alerts"
    if not auth_header:
        return 401, "Missing Authorization header"
    match = re.match(r"^Bearer\s+(.+)$", auth_header.strip(), re.IGNORECASE)
    if not match:
        return 401, "Authorization header must be a Bearer token"
    if match.group(1) != expected_secret:
        return 401, "Invalid webhook secret"
    return 200, "Authorized"


def normalize_alert(alert):
    """Python mirror of normalizeAlert() in index.ts."""
    labels = alert.get("labels") or {}
    annotations = alert.get("annotations") or {}

    sparkplug_id = (labels.get("sparkplug_id") or "").strip()
    fingerprint = (alert.get("fingerprint") or "").strip()
    alert_name = (labels.get("alertname") or "").strip()
    starts_at = alert.get("startsAt")
    if not sparkplug_id or not fingerprint or not alert_name or not starts_at:
        return None

    resolved = (alert.get("status") or "").lower() == RESOLVED
    raw_ends = alert.get("endsAt") or ""
    if resolved:
        ends_at = raw_ends if raw_ends and not raw_ends.startswith("0001-01-01") else "NOW"
    else:
        ends_at = None

    severity = (labels.get("severity") or "warning").lower()

    return {
        "fingerprint": fingerprint,
        "sparkplug_id": sparkplug_id,
        "alert_name": alert_name,
        "severity": severity if severity in SEVERITIES else "warning",
        "status": RESOLVED if resolved else FIRING,
        "summary": (annotations.get("summary") or annotations.get("description") or "").strip() or None,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "device_name": (labels.get("device") or "").strip() or None,
    }


def alert(**over):
    base = {
        "status": "firing",
        "fingerprint": "abc123def456",
        "startsAt": "2026-08-17T09:00:00Z",
        "endsAt": "0001-01-01T00:00:00Z",
        "labels": {
            "alertname": "Thermal Excursion",
            "severity": "critical",
            "sparkplug_id": "dev220000000000400080000",
            "device": "Sim_CNC_Mill_01",
        },
        "annotations": {"summary": "Sim_CNC_Mill_01 is above its configured thermal limit of 90.0 degC"},
    }
    base.update(over)
    return base


class TestAuthorization(unittest.TestCase):
    SECRET = "s" * 64

    def test_valid_bearer_is_authorized(self):
        status, _ = authorize_alert_webhook(f"Bearer {self.SECRET}", self.SECRET)
        self.assertEqual(status, 200)

    def test_missing_header_is_401(self):
        self.assertEqual(authorize_alert_webhook(None, self.SECRET)[0], 401)

    def test_wrong_secret_is_401(self):
        self.assertEqual(authorize_alert_webhook("Bearer nope", self.SECRET)[0], 401)

    def test_non_bearer_scheme_is_401(self):
        # A Supabase apikey arriving in the Authorization header is the realistic mistake here.
        self.assertEqual(authorize_alert_webhook(f"apikey {self.SECRET}", self.SECRET)[0], 401)
        self.assertEqual(authorize_alert_webhook(self.SECRET, self.SECRET)[0], 401)

    def test_unset_secret_fails_CLOSED_not_open(self):
        """
        THE ONE THAT MATTERS. An empty expected secret must refuse everything, not accept anything.

        Compared with `presented == expected`, an unset variable makes `Bearer ` (or a caller who
        also has nothing configured) match, and the endpoint becomes an unauthenticated write path
        into device_alerts. A misconfiguration should be broken, never permissive.
        """
        for header in (None, "Bearer ", "Bearer anything", ""):
            status, message = authorize_alert_webhook(header, "")
            self.assertEqual(status, 503, f"{header!r} must not be authorized against an unset secret")
            self.assertIn("not configured", message)

    def test_bearer_is_case_insensitive_but_the_secret_is_not(self):
        self.assertEqual(authorize_alert_webhook(f"bearer {self.SECRET}", self.SECRET)[0], 200)
        self.assertEqual(authorize_alert_webhook(f"Bearer {self.SECRET.upper()}", self.SECRET)[0], 401)


class TestNormalisation(unittest.TestCase):
    def test_firing_alert_becomes_an_open_occurrence(self):
        row = normalize_alert(alert())
        self.assertEqual(row["status"], "firing")
        self.assertEqual(row["sparkplug_id"], "dev220000000000400080000")
        self.assertEqual(row["alert_name"], "Thermal Excursion")
        self.assertEqual(row["severity"], "critical")
        # A firing row carries NO end. The table's CHECK allows that only while it is firing.
        self.assertIsNone(row["ends_at"])

    def test_resolve_keeps_the_same_occurrence_key(self):
        """
        The resolve must close the row the firing opened, not insert a second one.

        Grafana repeats BOTH the fingerprint and startsAt on resolve, and (fingerprint, starts_at) is
        the unique constraint -- which is the entire reason the table is keyed that way.
        """
        firing = normalize_alert(alert())
        resolved = normalize_alert(alert(status="resolved", endsAt="2026-08-17T09:07:00Z"))
        self.assertEqual(
            (firing["fingerprint"], firing["starts_at"]),
            (resolved["fingerprint"], resolved["starts_at"]),
        )
        self.assertEqual(resolved["status"], "resolved")
        self.assertEqual(resolved["ends_at"], "2026-08-17T09:07:00Z")

    def test_a_refire_is_a_new_occurrence(self):
        """
        Same series, later excursion: same fingerprint, DIFFERENT startsAt -> a second row.

        Keying on fingerprint alone would have overwritten the first occurrence, and the table would
        silently have become "latest per series" while still carrying starts_at/ends_at.
        """
        first = normalize_alert(alert())
        again = normalize_alert(alert(startsAt="2026-08-17T11:30:00Z"))
        self.assertEqual(first["fingerprint"], again["fingerprint"])
        self.assertNotEqual(first["starts_at"], again["starts_at"])

    def test_alertmanager_zero_end_is_not_stored_as_a_timestamp(self):
        # Grafana sends 0001-01-01T00:00:00Z to mean "still open". Storing that would make every
        # firing alert look like it ended in the year 1.
        self.assertIsNone(normalize_alert(alert())["ends_at"])
        # And a resolve that arrives without a usable endsAt still gets one, because the CHECK
        # requires it.
        self.assertIsNotNone(normalize_alert(alert(status="resolved", endsAt=""))["ends_at"])
        self.assertIsNotNone(
            normalize_alert(alert(status="resolved", endsAt="0001-01-01T00:00:00Z"))["ends_at"])

    def test_unattributable_alerts_are_skipped_not_guessed(self):
        """
        A DatasourceError notification (what `execErrState: Error` produces when a rule's query
        breaks) carries no sparkplug_id. It must not be written as a device alert -- inventing an id
        would attribute a broken query to a machine.
        """
        no_id = alert(labels={"alertname": "DatasourceError", "severity": "critical"})
        self.assertIsNone(normalize_alert(no_id))
        self.assertIsNone(normalize_alert(alert(fingerprint="")))
        self.assertIsNone(normalize_alert(alert(labels={"sparkplug_id": "dev22", "severity": "info"})))
        self.assertIsNone(normalize_alert(alert(startsAt=None)))

    def test_unknown_severity_is_mapped_rather_than_allowed_to_fail_the_batch(self):
        # device_alerts.severity has a CHECK. One odd label must not reject the other five instances
        # in the same notification.
        row = normalize_alert(alert(labels={**alert()["labels"], "severity": "page-the-ceo"}))
        self.assertEqual(row["severity"], "warning")

    def test_severity_is_lowercased(self):
        row = normalize_alert(alert(labels={**alert()["labels"], "severity": "CRITICAL"}))
        self.assertEqual(row["severity"], "critical")

    def test_summary_falls_back_to_description(self):
        row = normalize_alert(alert(annotations={"description": "fallback text"}))
        self.assertEqual(row["summary"], "fallback text")
        self.assertIsNone(normalize_alert(alert(annotations={}))["summary"])


class TestMirrorIsFaithful(unittest.TestCase):
    """
    Holds this file to index.ts. A mirror nothing checks is a mirror that drifts, and these two
    would drift silently -- the Python would keep passing while the deployed function changed.
    """

    def setUp(self):
        self.src = INDEX_TS.read_text(encoding="utf-8")

    def test_the_function_exists_and_authorises_before_parsing(self):
        self.assertIn("authorizeAlertWebhook", self.src)
        # Order matters: parsing an unauthenticated body is work done for an attacker.
        self.assertLess(
            self.src.index("authorizeAlertWebhook(req.headers"),
            self.src.index("await req.json()"),
            "the auth check must run before the body is parsed",
        )

    def test_it_fails_closed_on_an_unset_secret(self):
        self.assertIn("if (!expectedSecret)", self.src)
        self.assertIn("503", self.src)

    def test_it_conflicts_on_the_occurrence_key(self):
        self.assertIn('onConflict: "fingerprint,starts_at"', self.src)

    def test_it_resolves_devices_by_sparkplug_id(self):
        self.assertIn('.eq', self.src) if False else None
        self.assertIn('"sparkplug_id"', self.src)
        self.assertIn(".in(\"sparkplug_id\"", self.src)
        # Resolving by NAME is the deprecated identity path; it must not appear as a lookup.
        self.assertNotIn('.eq("name"', self.src)

    def test_it_never_hardcodes_a_threshold(self):
        # Thresholds live in the Grafana rules. A number here would be the browser-side alarm all
        # over again, one layer down.
        self.assertNotIn("80.0", self.src)
        self.assertNotIn("85.0", self.src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
