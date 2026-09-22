"""
Unit tests for the Directory's MQTT half (`ingestion/directory_publish.py`).

NO BROKER AND NO DATABASE. The module's only imports are the standard library and `logging_config`,
so this is a pure-logic test: a fake PostgREST query builder supplies rows and a fake MQTT client
records what was published. That is deliberate rather than convenient -- it means the assertions
below are about the PROJECTION, which is the part that can be wrong while everything connects.

WHAT IS ACTUALLY BEING GUARDED, in the order the module argues it:

  * THE SOURCE. The Directory is derived from the enrolment records. Issue #64 proposed building it
    from NBIRTH/DBIRTH instead, which would make a device that has never been enrolled resolvable
    by publishing one. Nothing in this module reads a birth, and `test_nothing_here_reads_a_birth`
    is the assertion that says so out loud rather than leaving it to the absence of code.

  * THE QUALIFICATION. `schemas.id` values are locally minted, not registered Factory+
    Schema_UUIDs. Over HTTP that note rides on the schema and service routes; on a topic there is
    no route and no status code, so EVERY document has to carry it -- including the device one,
    whose `schemas` array is made of exactly those identifiers. check-mirror-drift.mjs holds the
    wording in step with the TypeScript; these tests hold the PLACEMENT.

  * THE DEFAULT. Publishing the whole address space is an exposure decision. Off unless asked.
"""
import importlib
import json
import os
import sys
import unittest

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import directory_publish  # noqa: E402


DEVICE_ROWS = [
    {
        "id": "dddddddd-0000-4000-8000-000000000001",
        "name": "CNC_01",
        "sparkplug_id": "devdddddddd000040008000",
        "status": "ONLINE",
        "is_quarantined": False,
        "gateway_id": "gggggggg-0000-4000-8000-000000000001",
        "gateways": {"sparkplug_id": "gwygggggggg000040008000", "sparkplug_group": "Aber"},
    },
    {
        # Unbound AND quarantined: the two shapes the projection has an opinion about.
        "id": "dddddddd-0000-4000-8000-000000000002",
        "name": "Unknown_Publisher",
        "sparkplug_id": "devdddddddd000040008001",
        "status": "OFFLINE",
        "is_quarantined": True,
        "gateway_id": None,
        "gateways": None,
    },
]

SCHEMA_ROWS = [
    {"id": "ssssssss-0000-4000-8000-000000000002", "schema_name": "CNC_Mill_v2",
     "version": 2, "status": "active"},
]

SERVICE_ROWS = [
    {"id": "vvvvvvvv-0000-4000-8000-000000000001", "service_name": "Historian",
     "service_type": "database", "endpoint_url": "http://timescaledb:5432", "status": "ACTIVE"},
    {"id": "vvvvvvvv-0000-4000-8000-000000000002", "service_name": "Studio",
     "service_type": "console", "endpoint_url": "http://localhost:3001", "status": "UNKNOWN"},
]

SUBMODEL_ROWS = [
    {"device_id": "dddddddd-0000-4000-8000-000000000001",
     "schema_id": "ssssssss-0000-4000-8000-000000000002"},
]


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """
    The fluent subset of postgrest-py this module uses: select/eq/in_/execute.

    IT RECORDS THE FILTERS RATHER THAN IGNORING THEM. `is_archived = false` and `status = active`
    are claims about what the Directory publishes, not incidental query tidiness, so the tests below
    assert on the filters that were applied as well as on the rows that came back.
    """

    def __init__(self, table, rows):
        self.table = table
        self.rows = rows
        self.filters = []
        self.columns = None

    def select(self, columns):
        self.columns = columns
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, list(values)))
        return self

    def execute(self):
        return FakeResult(self.rows)


class FakeSupabase:
    def __init__(self, devices=None, schemas=None, services=None, submodels=None, fail=None):
        self.tables = {
            "devices": DEVICE_ROWS if devices is None else devices,
            "schemas": SCHEMA_ROWS if schemas is None else schemas,
            "directory_services": SERVICE_ROWS if services is None else services,
            "device_schemas": SUBMODEL_ROWS if submodels is None else submodels,
        }
        self.fail = fail
        self.queries = []

    def table(self, name):
        if self.fail == name:
            raise RuntimeError(f"{name} is unreachable")
        query = FakeQuery(name, self.tables[name])
        self.queries.append(query)
        return query

    def query_for(self, name):
        return next(q for q in self.queries if q.table == name)


class FakeClient:
    def __init__(self, connected=True):
        self.connected = connected
        self.published = []

    def is_connected(self):
        return self.connected

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append({"topic": topic, "payload": payload, "qos": qos, "retain": retain})


def documents(**kwargs):
    return directory_publish.directory_documents(FakeSupabase(**kwargs))


class TheSourceIsTheEnrolmentRecord(unittest.TestCase):
    """The trust decision, which is the whole reason this file was written the way it was."""

    def test_nothing_here_reads_a_birth(self):
        """
        Asserted against the SOURCE, because the property is an absence and an absence cannot be
        observed by calling something. Issue #64's first implementation step was to accumulate the
        Directory from NBIRTH/DBIRTH; that would make a self-declared address into a platform
        assertion, which is the one thing verify_gateway_binding() exists to refuse. If a later
        change starts consuming births here, this fails and the reviewer has to say why.
        """
        with open(os.path.join(INGESTION_DIR, "directory_publish.py"), encoding="utf-8") as fh:
            source = fh.read()
        # The docstring discusses births at length; the CODE must not touch one. Everything below
        # the module docstring is what is checked.
        body = source.split('"""', 2)[2]
        for forbidden in ("NBIRTH", "DBIRTH", "register_birth_aliases", "on_message"):
            self.assertNotIn(forbidden, body,
                             f"{forbidden} appears in the publisher's code -- the Directory would "
                             "then be accumulating what devices claim rather than deriving what "
                             "was enrolled")

    def test_archived_devices_are_excluded(self):
        supabase = FakeSupabase()
        directory_publish.directory_documents(supabase)
        self.assertIn(("eq", "is_archived", False), supabase.query_for("devices").filters)

    def test_only_active_schemas_are_listed(self):
        supabase = FakeSupabase()
        directory_publish.directory_documents(supabase)
        self.assertIn(("eq", "status", "active"), supabase.query_for("schemas").filters)


class TheQualificationTravels(unittest.TestCase):
    """A subscriber has the payload and nothing else -- no route, no status code, no page."""

    def test_every_document_that_carries_a_local_uuid_says_so(self):
        docs = documents()
        for name in ("device", "schema"):
            self.assertEqual(docs[name]["namespace"], "local", f"{name} document")
            self.assertEqual(docs[name]["note"], directory_publish.LOCAL_SCHEMA_NOTE, f"{name} document")
        self.assertEqual(docs["service"]["namespace"], "local")
        self.assertEqual(docs["service"]["note"], directory_publish.LOCAL_SERVICE_NOTE)

    def test_the_device_document_carries_it_even_though_http_does_not(self):
        """
        The asymmetry worth stating. `/v1/device/{uuid}` returns `schemas` unqualified because a
        caller reached it through a documented route; a topic offers no such context, so the
        qualification has to be in the bytes.
        """
        docs = documents()
        self.assertIn("note", docs["device"])
        self.assertTrue(docs["device"]["devices"][0]["schemas"])


class TheProjection(unittest.TestCase):
    """Field for field with `deviceEntry()` in the edge function, including its two oddities."""

    def test_a_bound_device_reports_its_full_address(self):
        entry = documents()["device"]["devices"][0]
        self.assertEqual(entry["address"], {
            "group_id": "Aber",
            "node_id": "gwygggggggg000040008000",
            "device_id": "devdddddddd000040008000",
        })
        self.assertTrue(entry["online"])
        self.assertEqual(entry["schemas"], ["ssssssss-0000-4000-8000-000000000002"])

    def test_an_unbound_device_reports_empty_strings_rather_than_a_missing_key(self):
        """So a subscriber destructuring the object never has to special-case the shape."""
        entry = documents()["device"]["devices"][1]
        self.assertEqual(entry["address"]["group_id"], "")
        self.assertEqual(entry["address"]["node_id"], "")

    def test_a_quarantined_device_is_present_and_flagged(self):
        """
        It exists on the wire, so a consumer meeting its traffic must be able to look it up. The
        flag is what says why its telemetry is not being stored -- omitting the device would leave
        that consumer with an address the platform appears never to have heard of.
        """
        entry = documents()["device"]["devices"][1]
        self.assertTrue(entry["quarantined"])

    def test_a_device_with_no_schema_reports_an_empty_list(self):
        self.assertEqual(documents()["device"]["devices"][1]["schemas"], [])

    def test_schemas_are_attached_from_the_view_in_one_query(self):
        """
        `device_schemas`, not `device_submodels`. The view unions the join table with the legacy
        1:1 `devices.schema_id`, and reading the join table alone reports "no schema" for exactly
        the devices an unfinished migration leaves behind.
        """
        supabase = FakeSupabase()
        directory_publish.directory_documents(supabase)
        view = supabase.query_for("device_schemas")
        self.assertEqual(len([q for q in supabase.queries if q.table == "device_schemas"]), 1)
        self.assertEqual(view.filters[0][0], "in")

    def test_service_status_is_passed_through_rather_than_flattened(self):
        """
        UNKNOWN means nothing observes that service, which is true of nine of the fifteen. A
        consumer deciding whether to route should be able to tell "up" from "nobody is looking".
        """
        services = documents()["service"]["services"]
        self.assertTrue(services[0]["online"])
        self.assertFalse(services[1]["online"])


class ThePublish(unittest.TestCase):

    def test_four_retained_documents_on_the_configured_prefix(self):
        client = FakeClient()
        count = directory_publish.publish_once(client, FakeSupabase(), prefix="T/Dir/v1")
        self.assertEqual(count, 4)
        self.assertEqual(
            sorted(m["topic"] for m in client.published),
            ["T/Dir/v1/device", "T/Dir/v1/ping", "T/Dir/v1/schema", "T/Dir/v1/service"],
        )

    def test_documents_are_retained_at_qos_zero(self):
        """
        Retained so a subscriber connecting between passes gets the current answer immediately;
        QoS 0 because the next pass is the retry -- a snapshot that is lost is superseded, not
        missing.
        """
        client = FakeClient()
        directory_publish.publish_once(client, FakeSupabase())
        for message in client.published:
            self.assertTrue(message["retain"])
            self.assertEqual(message["qos"], 0)

    def test_payloads_are_json(self):
        client = FakeClient()
        directory_publish.publish_once(client, FakeSupabase())
        for message in client.published:
            self.assertIsInstance(json.loads(message["payload"]), dict)

    def test_a_failed_pass_publishes_nothing_at_all(self):
        """
        Three fresh documents beside one retained from the last pass is a Directory that disagrees
        with itself, with nothing in the payloads to say which is which. The whole pass fails, and
        every retained document stays from the same moment.
        """
        client = FakeClient()
        with self.assertRaises(RuntimeError):
            directory_publish.publish_once(client, FakeSupabase(fail="schemas"))
        self.assertEqual(client.published, [])

    def test_the_ping_document_names_the_service_the_http_half_reports(self):
        docs = documents()
        self.assertEqual(docs["ping"]["service"], "fplus-directory")
        self.assertEqual(docs["ping"]["factoryplus_payload_uuid"],
                         "11ad7b32-1d32-4c4a-b0c9-fa049208939a")


class TheDefault(unittest.TestCase):
    """
    Off unless asked. Publishing the whole address space to a topic is an exposure decision, and
    the broker ACL is the only thing standing in front of it once it is on.
    """

    def _reload_with(self, value):
        previous = os.environ.get("DIRECTORY_MQTT_ENABLED")
        if value is None:
            os.environ.pop("DIRECTORY_MQTT_ENABLED", None)
        else:
            os.environ["DIRECTORY_MQTT_ENABLED"] = value
        try:
            return importlib.reload(directory_publish)
        finally:
            if previous is None:
                os.environ.pop("DIRECTORY_MQTT_ENABLED", None)
            else:
                os.environ["DIRECTORY_MQTT_ENABLED"] = previous

    def tearDown(self):
        importlib.reload(directory_publish)

    def test_unset_means_off(self):
        module = self._reload_with(None)
        self.assertFalse(module.start(FakeClient(), FakeSupabase()))

    def test_it_starts_when_asked(self):
        module = self._reload_with("true")
        self.assertTrue(module.start(FakeClient(), FakeSupabase()))

    def test_it_refuses_to_start_with_nothing_to_derive_from(self):
        """
        Enabled with no Supabase client is a misconfiguration, not a quiet no-op: the thread would
        run forever logging one failure per pass about a dependency that is never going to arrive.
        """
        module = self._reload_with("true")
        self.assertFalse(module.start(FakeClient(), None))

    def test_the_topic_root_is_outside_sparkplug(self):
        """
        A Directory document is not a Sparkplug message and must not arrive looking like one -- and
        a separate root means mosquitto's default-deny covers it until a rule says otherwise,
        rather than a per-gateway `spBv1.0/+/+/<id>/#` role reaching it by accident.
        """
        self.assertFalse(directory_publish.DIRECTORY_MQTT_TOPIC_PREFIX.startswith("spBv1.0"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
