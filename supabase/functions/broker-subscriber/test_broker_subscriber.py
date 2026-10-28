"""
A read-only broker account, through the path the Access Control page takes, on a running stack.

WHAT THIS PROTECTS. New Read-Only Account hands a password to something outside Aber. The account
must read the plant and write nothing, and Delete must take it away from a client that is
connected. Every link fails quietly: a denied publish at QoS 0 exits 0, and a delete that left a
session open would look done on the page. So each claim is asserted by what arrives:

  * an Administrator creates one through broker-subscriber, and a Shopfloor Manager cannot;
  * connected with the password shown, it receives a Sparkplug message and a UNS message;
  * what it publishes reaches nobody, its own subscription included;
  * deleting it drops the live session and refuses the next CONNECT, and the inventory no longer
    lists it;
  * the creation and the deletion are each one Audit Trail row naming the Administrator.

Requires the stack up (scripts/dev-cluster.mjs test), the seeded accounts, kubectl to the broker's
pod, and the ingestion daemon's broker credential, which the stack lane reads from the Secret:

    SUPABASE_PUBLISHABLE_KEY=... MQTT_INGESTION_PASSWORD=... \\
        python supabase/functions/broker-subscriber/test_broker_subscriber.py
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "test-harness"))
import stack_exec  # noqa: E402  -- kubectl exec against the workload that holds the container

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
PASSWORD = os.getenv("ABER_DEMO_PASSWORD", "aber123")
INGESTION_USER = os.getenv("MQTT_INGESTION_USER", "aber_ingestion")
INGESTION_PASSWORD = os.getenv("MQTT_INGESTION_PASSWORD", "")
ADMIN = "admin@aber.local"
MANAGER = "manager@aber.local"

SUBSCRIBER = re.compile(r"^sub[0-9a-f]{21}$")
CAFILE = "/mosquitto/certs/ca.crt"
DEADLINE_S = 20


def sign_in(email):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST",
        data=json.dumps({"email": email, "password": PASSWORD}).encode(),
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        body = json.loads(response.read().decode())
        return body["access_token"], body["user"]["id"]


def request(path, bearer, method="GET", body=None):
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        return err.code, (json.loads(raw) if raw.strip() else None)


def subscriber(bearer, body):
    return request("/functions/v1/broker-subscriber", bearer, method="POST", body=body)


def entity_id(username):
    """The id 0218 files both of an account's rows under: its hex, padded with zeros."""
    return str(uuid.UUID(username[3:] + "0" * 11))


def mqtt_pub(username, password, topic, payload):
    """One QoS 0 publish over MQTTS from inside the broker's container, and the broker's verdict."""
    result = stack_exec.run(
        "broker", "timeout", "10", "mosquitto_pub", "--cafile", CAFILE, "-h", stack_exec.broker_host(),
        "-p", "8883", "-u", username, "-P", password, "-t", topic, "-m", payload,
    )
    return stack_exec.publish_verdict(result)


class Session:
    """
    A live mosquitto_sub inside the broker's container, as a consumer would hold one, its lines
    collected as they arrive. `exited` is set once the process ends: the broker dropped it.
    """

    def __init__(self, username, password, topics):
        target = stack_exec.TARGETS["broker"]
        args = ["mosquitto_sub", "--cafile", CAFILE, "-h", stack_exec.broker_host(), "-p", "8883",
                "-u", username, "-P", password, "-v", "-W", "120"]
        for topic in topics:
            args += ["-t", topic]
        self.process = subprocess.Popen(
            ["kubectl", "-n", stack_exec.NAMESPACE, "exec", target["workload"], "-c", target["container"], "--", *args],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        self.lines = []
        self.exited = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            self.lines.append(line.rstrip("\n"))
        self.process.wait()
        self.exited.set()

    def saw(self, text):
        return any(text in line for line in self.lines)

    def close(self):
        if self.process.poll() is None:
            self.process.kill()


def until(condition, seconds=DEADLINE_S, every=None):
    """Poll `condition` until it holds or `seconds` pass; `every` runs before each look."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if every:
            every()
        if condition():
            return True
        time.sleep(1)
    return condition()


@unittest.skipIf(not PUBLISHABLE_KEY, "SUPABASE_PUBLISHABLE_KEY must be set")
class ReadOnlyBrokerAccount(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.admin, cls.admin_id = sign_in(ADMIN)
            cls.manager, _ = sign_in(MANAGER)
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"could not sign in the seeded accounts at {SUPABASE_URL}: {err}")
        status, inventory = request("/functions/v1/broker-inventory", cls.admin)
        if status != 200:
            raise unittest.SkipTest(f"broker-inventory answered {status}: {inventory}")
        role = next((r for r in inventory["roles"] if r["rolename"] == "subscriber"), None)
        if role is None:
            raise AssertionError("the broker holds no subscriber role; the boot reconcile did not apply the policy")
        cls.topics = sorted({a["topic"] for a in role["acls"] if a["allow"] and a["acltype"] == "subscribePattern"})
        cls.uns_root = next(t[:-2] for t in cls.topics if t != "spBv1.0/#" and t.endswith("/#"))

    def setUp(self):
        self.username = None
        self.session = None

    def tearDown(self):
        if self.session:
            self.session.close()
        if self.username:
            subscriber(self.admin, {"action": "delete", "username": self.username})

    def inventory_entry(self, username):
        _, inventory = request("/functions/v1/broker-inventory", self.admin)
        return next((c for c in inventory["clients"] if c["username"] == username), None)

    def audit_rows(self, username):
        status, rows = request(
            "/rest/v1/audit_trail?entity_type=eq.broker_accounts"
            f"&entity_id=eq.{entity_id(username)}&select=action,changed_by,old_data,new_data&order=id",
            self.admin,
        )
        self.assertEqual(status, 200, rows)
        return rows

    def test_a_shopfloor_manager_can_neither_create_nor_delete_one(self):
        status, body = subscriber(self.manager, {"action": "create", "name": "Not allowed", "description": "Refused."})
        self.assertEqual(status, 403, body)
        status, body = subscriber(self.manager, {"action": "delete", "username": "sub" + "0" * 21})
        self.assertEqual(status, 403, body)

    def test_a_gateway_or_a_platform_account_cannot_be_deleted_here(self):
        for username in ("aber_ingestion", "dynsec-admin", "gwy110000000000400080000"):
            with self.subTest(username=username):
                status, body = subscriber(self.admin, {"action": "delete", "username": username})
                self.assertEqual(status, 400, body)
        for username in ("aber_ingestion", "dynsec-admin"):
            self.assertIsNotNone(self.inventory_entry(username), f"{username} is gone from the broker")

    @unittest.skipIf(not INGESTION_PASSWORD, "MQTT_INGESTION_PASSWORD is not set, so nothing can publish for it to read")
    def test_it_reads_the_plant_writes_nothing_and_is_gone_once_deleted(self):
        marker = uuid.uuid4().hex[:12]
        status, made = subscriber(self.admin, {
            "action": "create", "name": f"Stack check {marker}", "description": "Made and deleted by test_broker_subscriber.py.",
        })
        self.assertEqual(status, 200, made)
        self.username = made["mqtt_username"]
        password = made["password"]
        self.assertRegex(self.username, SUBSCRIBER)
        self.assertEqual(made["role"], "subscriber")
        self.assertTrue(made["audit_recorded"])

        entry = self.inventory_entry(self.username)
        self.assertEqual(entry["roles"], ["subscriber"])
        self.assertEqual((entry["textname"], entry["textdescription"]),
                         (f"Stack check {marker}", "Made and deleted by test_broker_subscriber.py."))
        self.assertEqual([r["action"] for r in self.audit_rows(self.username)], ["INSERT"])

        # Connected with the password the dialog shows, to what the dialog says it may read.
        self.session = Session(self.username, password, self.topics)
        sparkplug = f"spBv1.0/AberCheck/NCMD/sub-check-{marker}"
        uns = f"{self.uns_root}/AberCheck/sub-check/{marker}"

        def publish_both():
            mqtt_pub(INGESTION_USER, INGESTION_PASSWORD, sparkplug, f"sp-{marker}")
            mqtt_pub(INGESTION_USER, INGESTION_PASSWORD, uns, f"uns-{marker}")

        self.assertTrue(until(lambda: self.session.saw(f"sp-{marker}") and self.session.saw(f"uns-{marker}"),
                              every=publish_both),
                        f"the account did not receive both: {self.session.lines[-5:]}")

        # Its own publishes are accepted at CONNECT and dropped: its own subscription would see them.
        for topic in (sparkplug, uns, f"spBv1.0/AberCheck/DDATA/{self.username}/probe"):
            self.assertEqual(mqtt_pub(self.username, password, topic, f"own-{marker}"), stack_exec.ACCEPTED)
        time.sleep(4)
        self.assertFalse(self.session.saw(f"own-{marker}"), "A READ-ONLY ACCOUNT'S PUBLISH WAS DELIVERED")

        # Deleted while connected: the session goes, the password is refused, the inventory forgets it.
        status, body = subscriber(self.admin, {"action": "delete", "username": self.username})
        self.assertEqual(status, 200, body)
        self.assertTrue(body["audit_recorded"])
        self.assertTrue(self.session.exited.wait(DEADLINE_S), "the live session survived the delete")
        self.assertEqual(stack_exec.publish(self.username, password, sparkplug)[0], stack_exec.REFUSED)
        self.assertIsNone(self.inventory_entry(self.username))

        rows = self.audit_rows(self.username)
        self.assertEqual([r["action"] for r in rows], ["INSERT", "DELETE"])
        self.assertEqual({r["changed_by"] for r in rows}, {self.admin_id})
        self.assertEqual(rows[1]["old_data"]["mqtt_username"], self.username)
        self.assertNotIn(password, json.dumps(rows))

        # Deleted twice is nothing to delete.
        status, _ = subscriber(self.admin, {"action": "delete", "username": self.username})
        self.assertEqual(status, 404)
        self.username = None


if __name__ == "__main__":
    unittest.main(verbosity=2)
