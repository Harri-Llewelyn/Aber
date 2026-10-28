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
import re
import unittest
from pathlib import Path
from urllib.parse import unquote

INDEX_TS = Path(__file__).resolve().parent / "index.ts"
BASELINE = Path(__file__).resolve().parents[2] / "migrations" / "0001_baseline_schema.sql"

RESOLVED = "resolved"
FIRING = "firing"
SEVERITIES = {"critical", "warning", "info"}
ENTITY_TYPES = {"device", "gateway", "platform", "service_identity"}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


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

    fingerprint = (alert.get("fingerprint") or "").strip()
    alert_name = (labels.get("alertname") or "").strip()
    starts_at = alert.get("startsAt")
    if not fingerprint or not alert_name or not starts_at:
        return None

    entity_type = (labels.get("entity_type") or "device").strip().lower()
    if entity_type not in ENTITY_TYPES:
        return None

    identity = entity_type == "service_identity"
    principal_id = (labels.get("principal_id") or "").strip() if identity else ""
    if identity and not UUID.match(principal_id):
        return None
    sparkplug_id = None if identity else ((labels.get("sparkplug_id") or "").strip() or None)

    if entity_type != "platform" and not identity and not sparkplug_id:
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
        "entity_type": entity_type,
        "entity_id": principal_id.lower() if identity else None,
        "sparkplug_id": sparkplug_id,
        "alert_name": alert_name,
        "severity": severity if severity in SEVERITIES else "warning",
        "status": RESOLVED if resolved else FIRING,
        "summary": (annotations.get("summary") or annotations.get("description") or "").strip() or None,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "device_name": (labels.get("device") or "").strip() or None,
        "rule_uid": rule_uid_of(alert),
        "labels": labels,
        "values": values_of(alert),
    }


RULE_UID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
RULE_VIEW_PATH = re.compile(r"/alerting/grafana/([^/?#]+)/view(?:[/?#]|$)")


def rule_uid_of(alert):
    """Python mirror of ruleUidOf() in index.ts."""
    match = RULE_VIEW_PATH.search(alert.get("generatorURL") or "")
    from_url = unquote(match.group(1)) if match else None
    for candidate in (from_url, alert.get("ruleUID"), (alert.get("labels") or {}).get("__alert_rule_uid__")):
        uid = candidate.strip() if isinstance(candidate, str) else ""
        if RULE_UID.match(uid):
            return uid
    return None


def values_of(alert):
    """Python mirror of valuesOf() in index.ts."""
    values = alert.get("values")
    return values if isinstance(values, dict) else None


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
        into platform_alerts. A misconfiguration should be broken, never permissive.
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
        # platform_alerts.severity has a CHECK. One odd label must not reject the other five instances
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

    def test_a_platform_alert_needs_no_wire_identity(self):
        row = normalize_alert(alert(labels={"alertname": "Backup Stale", "entity_type": "platform"}))
        self.assertEqual((row["entity_type"], row["sparkplug_id"], row["entity_id"]), ("platform", None, None))

    def test_an_unknown_entity_type_is_refused(self):
        self.assertIsNone(normalize_alert(alert(labels={**alert()["labels"], "entity_type": "building"})))


PRINCIPAL = "5E000000-0204-4000-8000-0000000000A1"


def token_alert(**labels):
    """An instance of Service Token Expiring, labelled as the rule's query labels it."""
    base = {
        "alertname": "Service Token Expiring",
        "severity": "warning",
        "entity_type": "service_identity",
        "identity": "Line 4 report",
        "principal_id": PRINCIPAL,
        "jti": "0f3c9a",
        "renewal": "access_control",
    }
    base.update(labels)
    return alert(labels={k: v for k, v in base.items() if v is not None},
                 annotations={"summary": "The token 0f3c9a for the machine identity Line 4 report expires"})


class TestMachineIdentity(unittest.TestCase):
    """An alert about a machine identity's token: its subject is the principal id, not a wire id."""

    def test_the_principal_id_is_the_subject(self):
        row = normalize_alert(token_alert())
        self.assertEqual(row["entity_type"], "service_identity")
        self.assertEqual(row["entity_id"], PRINCIPAL.lower())
        self.assertIsNone(row["sparkplug_id"])

    def test_a_sparkplug_id_label_is_not_stored(self):
        # `platform_alerts_asset_has_wire_id` admits it without one, and the device surfaces index
        # by sparkplug_id: carrying one would let a token alert colour an asset.
        self.assertIsNone(normalize_alert(token_alert(sparkplug_id="dev220000000000400080000"))["sparkplug_id"])

    def test_a_principal_id_that_is_not_a_uuid_is_refused(self):
        # entity_id is a uuid column. Written as it came, one bad instance would fail the batch.
        for bad in (None, "", "Line 4 report", "5e000000-0204-4000-8000", f"{PRINCIPAL}0", f" {PRINCIPAL}x"):
            with self.subTest(principal_id=bad):
                self.assertIsNone(normalize_alert(token_alert(principal_id=bad)))

    def test_it_resolves_like_any_other_occurrence(self):
        resolved = normalize_alert({**token_alert(), "status": "resolved", "endsAt": "2026-10-25T09:00:00Z"})
        self.assertEqual((resolved["status"], resolved["entity_id"]), ("resolved", PRINCIPAL.lower()))


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

    def test_the_entity_types_match_the_table_and_this_mirror(self):
        # One set in three places: the webhook refuses what the CHECK would refuse, before the insert.
        ts = re.search(r"const ENTITY_TYPES = new Set\(\[([^\]]*)\]\)", self.src)
        self.assertIsNotNone(ts, "ENTITY_TYPES is no longer a Set literal in index.ts")
        ts_types = set(re.findall(r'"([a-z_]+)"', ts.group(1)))
        check = re.search(
            r"ADD CONSTRAINT platform_alerts_entity_type_valid CHECK \(\(entity_type = ANY \(ARRAY\[([^\]]*)\]\)\)\);",
            BASELINE.read_text(encoding="utf-8"))
        self.assertIsNotNone(check, "0001 no longer adds platform_alerts_entity_type_valid in this form")
        sql_types = set(re.findall(r"'([a-z_]+)'::text", check.group(1)))
        self.assertEqual(ts_types, sql_types)
        self.assertEqual(ENTITY_TYPES, ts_types)

    def test_it_checks_a_principal_id_as_this_mirror_does(self):
        self.assertIn(UUID.pattern, self.src)
        self.assertIn('entityType === "service_identity"', self.src)

    def test_it_never_hardcodes_a_threshold(self):
        # Thresholds live in the Grafana rules. A number here would be the browser-side alarm all
        # over again, one layer down.
        self.assertNotIn("80.0", self.src)
        self.assertNotIn("85.0", self.src)


class TestRuleUidLabelsAndValues(unittest.TestCase):
    """
    Each row keeps its rule's uid, its labels and its values. Grafana names the rule in the
    alert's generatorURL, `<root URL>/alerting/grafana/<uid>/view`, and also sends `ruleUID`; it
    strips the `__alert_rule_uid__` label before a contact point sees it.
    """

    UID = "aber-gateway-clock-skew"

    def sent(self, **over):
        return alert(generatorURL=f"http://grafana.localhost/alerting/grafana/{self.UID}/view?orgId=1",
                     values={"A": 74.5, "B": 74.5, "C": 1}, **over)

    def test_the_uid_comes_from_the_generator_url(self):
        self.assertEqual(normalize_alert(self.sent())["rule_uid"], self.UID)

    def test_the_host_and_root_path_are_whatever_grafana_serves_from(self):
        for url in (
            f"https://site.example/grafana/alerting/grafana/{self.UID}/view",
            f"http://grafana.localhost/alerting/grafana/{self.UID}/view/",
            f"/alerting/grafana/{self.UID}/view#history",
        ):
            with self.subTest(url=url):
                self.assertEqual(rule_uid_of({"generatorURL": url}), self.UID)

    def test_the_payload_s_rule_uid_and_then_the_label_stand_in(self):
        self.assertEqual(rule_uid_of({"ruleUID": self.UID}), self.UID)
        self.assertEqual(rule_uid_of({"labels": {"__alert_rule_uid__": self.UID}}), self.UID)
        # The URL wins: it is the one Grafana has always sent.
        self.assertEqual(rule_uid_of({"generatorURL": f"/alerting/grafana/{self.UID}/view", "ruleUID": "other"}), self.UID)

    def test_no_generator_url_is_no_uid_and_still_a_row(self):
        row = normalize_alert(alert())
        self.assertIsNotNone(row)
        self.assertIsNone(row["rule_uid"])
        self.assertIsNone(normalize_alert(alert(generatorURL=None))["rule_uid"])
        self.assertIsNone(normalize_alert(alert(generatorURL=""))["rule_uid"])

    def test_a_url_that_names_no_rule_is_no_uid(self):
        for url in (
            "http://grafana.localhost/",                                   # what Grafana sends when it knows no uid
            "http://grafana.localhost/alerting/list",
            "http://grafana.localhost/alerting/grafana//view",
            "http://grafana.localhost/alerting/grafana/a%2Fb/view",        # decodes to a slash
            "http://grafana.localhost/alerting/grafana/%E0%A4%A/view",     # not decodable
            f"http://grafana.localhost/alerting/grafana/{'x' * 41}/view",  # longer than Grafana allows
            "http://grafana.localhost/alerting/grafana/aber-x/edit",
        ):
            with self.subTest(url=url):
                self.assertIsNone(rule_uid_of({"generatorURL": url}))

    def test_labels_and_values_are_stored_as_sent(self):
        row = normalize_alert(self.sent())
        self.assertEqual(row["labels"], alert()["labels"])
        self.assertEqual(row["values"], {"A": 74.5, "B": 74.5, "C": 1})

    def test_values_that_are_not_an_object_are_none(self):
        for values in (None, [], [1, 2], "74.5", 74.5):
            with self.subTest(values=values):
                self.assertIsNone(normalize_alert(alert(values=values))["values"])

    def test_the_key_is_still_the_occurrence(self):
        # The uid, labels and values ride along; the upsert key is untouched, so no fingerprint moves.
        src = INDEX_TS.read_text(encoding="utf-8")
        self.assertIn('onConflict: "fingerprint,starts_at"', src)

    def test_the_typescript_reads_and_writes_them_as_this_mirror_does(self):
        src = INDEX_TS.read_text(encoding="utf-8")
        self.assertIn(f"const RULE_UID = /{RULE_UID.pattern}/;", src)
        ts_path = re.search(r"const RULE_VIEW_PATH = /(.+)/;", src)
        self.assertIsNotNone(ts_path, "RULE_VIEW_PATH is no longer a regex literal in index.ts")
        self.assertEqual(ts_path.group(1).replace("\\/", "/"), RULE_VIEW_PATH.pattern)
        self.assertIn("[fromUrl, alert.ruleUID, alert.labels?.__alert_rule_uid__]", src)
        for column in ("rule_uid: r.rule_uid", "labels: r.labels", "values: r.values"):
            self.assertIn(column, src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
