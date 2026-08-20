"""
Unit tests for the ingestion daemon's liveness heartbeat (`start_health_heartbeat` in ingestion.py).

WHY THIS IS WORTH TESTING. The Kubernetes liveness probe reads nothing but this file's age, so the
heartbeat's behaviour IS the health signal. Every property below, if it broke, would break in the
same direction -- toward a daemon that looks healthy while it is not, or one that gets restarted
while it is fine:

  * writing when DISCONNECTED would make a wedged broker connection look alive, which is the exact
    failure the probe exists to catch;
  * writing when the feature is OFF would put litter on the Compose path, which declares no
    healthcheck and reads no file;
  * crashing on a write error would turn a full disk into a crash-looping daemon that was otherwise
    ingesting fine.

Same stubbing approach as test_declared_metrics.py: the daemon's heavy imports (protobuf, MQTT,
psycopg2) are replaced before ingestion.py is loaded, so this stays a pure-logic test that does not
need `protoc` or a running broker.
"""
import logging
import os
import sys
import tempfile
import threading
import time
import types
import unittest

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)


def _stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)
    if "." in name:
        parent, _, leaf = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], leaf, sys.modules[name])
    return module


_stub("psycopg2", connect=lambda *a, **k: None)
_stub("psycopg2.extras", execute_values=lambda *a, **k: None)
_stub("sparkplug_b_pb2", Payload=object)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=object)

import ingestion  # noqa: E402  (must follow the stubs above)


class FakeClient:
    """The only method the heartbeat calls is is_connected()."""

    def __init__(self, connected=True):
        self.connected = connected

    def is_connected(self):
        return self.connected


class HeartbeatTests(unittest.TestCase):
    """
    NOTE ON THREAD LEAKAGE. The heartbeat loop is `while True` with no stop signal -- correct for a
    daemon that should beat until the process exits, and it means a thread started by one test keeps
    running through the rest of the suite. Two consequences, both handled here rather than by adding
    a test-only shutdown hook to production code:

      * the thread re-reads the module-level INGESTION_HEALTH_FILE each beat, so once tearDown
        restores it a leaked thread logs a benign write warning. The logger is quietened for the
        duration of the suite so that noise cannot be mistaken for the failure of the test being run.
      * threads must be diffed by OBJECT IDENTITY, not by name -- they all share the name
        "health-heartbeat", so a name-based diff finds nothing new after the first test.
    """

    @classmethod
    def setUpClass(cls):
        cls._log_level = ingestion.logger.level
        ingestion.logger.setLevel(logging.CRITICAL)

    @classmethod
    def tearDownClass(cls):
        ingestion.logger.setLevel(cls._log_level)

    def setUp(self):
        self._file = ingestion.INGESTION_HEALTH_FILE
        self._interval = ingestion.INGESTION_HEALTH_INTERVAL
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "health")
        # Short interval so a test can observe a beat without sleeping for the 15s default.
        ingestion.INGESTION_HEALTH_INTERVAL = 0.05

    def tearDown(self):
        ingestion.INGESTION_HEALTH_FILE = self._file
        ingestion.INGESTION_HEALTH_INTERVAL = self._interval

    def start(self, client):
        """Start a heartbeat and return the threads it actually created, by identity."""
        before = set(threading.enumerate())
        ingestion.start_health_heartbeat(client)
        return [t for t in threading.enumerate() if t not in before]

    def _wait_for(self, predicate, timeout=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def test_no_op_when_unconfigured(self):
        """Unset means OFF -- the Compose default. No thread is started and nothing is written."""
        ingestion.INGESTION_HEALTH_FILE = ""
        started = self.start(FakeClient(connected=True))
        self.assertEqual(started, [], "a heartbeat thread was started with no file configured")
        time.sleep(0.2)
        self.assertFalse(os.path.exists(self.path))

    def test_writes_while_connected(self):
        ingestion.INGESTION_HEALTH_FILE = self.path
        self.start(FakeClient(connected=True))
        self.assertTrue(
            self._wait_for(lambda: os.path.exists(self.path)),
            "heartbeat file was never written while the client reported connected",
        )

    def test_does_not_write_while_disconnected(self):
        """
        THE LOAD-BEARING CASE. A daemon whose MQTT loop has died stays alive and stops ingesting;
        the file going stale is the only signal of that, so a heartbeat that wrote regardless of
        connection state would report a dead daemon as healthy forever.
        """
        ingestion.INGESTION_HEALTH_FILE = self.path
        self.start(FakeClient(connected=False))
        time.sleep(0.3)  # several intervals
        self.assertFalse(
            os.path.exists(self.path),
            "heartbeat wrote while disconnected -- a wedged daemon would look healthy",
        )

    def test_goes_stale_when_the_connection_drops(self):
        """The transition, not just the steady states: writes stop and the file stops advancing."""
        ingestion.INGESTION_HEALTH_FILE = self.path
        client = FakeClient(connected=True)
        self.start(client)
        self.assertTrue(self._wait_for(lambda: os.path.exists(self.path)))

        client.connected = False
        time.sleep(0.15)
        frozen = os.path.getmtime(self.path)
        time.sleep(0.3)
        self.assertEqual(
            frozen,
            os.path.getmtime(self.path),
            "heartbeat kept advancing after the connection dropped",
        )

    def test_survives_an_unwritable_path(self):
        """
        A write failure must stop the heartbeat, not the daemon. The probe then restarts the pod,
        which is the correct outcome -- but crashing here would take down a daemon that is still
        ingesting fine, turning a full disk into an outage.
        """
        ingestion.INGESTION_HEALTH_FILE = os.path.join(self.tmp, "no-such-dir", "health")
        self.start(FakeClient(connected=True))
        time.sleep(0.2)
        # The thread is a daemon and swallowed the error; reaching here without an exception
        # propagating out of start_health_heartbeat is the assertion.
        self.assertFalse(os.path.exists(ingestion.INGESTION_HEALTH_FILE))

    def test_thread_is_a_daemon(self):
        """Otherwise the process would refuse to exit -- the loop never terminates by design."""
        ingestion.INGESTION_HEALTH_FILE = self.path
        started = self.start(FakeClient(connected=True))
        self.assertEqual(len(started), 1, "expected exactly one heartbeat thread")
        self.assertTrue(started[0].daemon, "heartbeat thread is not a daemon thread")
        self.assertEqual(started[0].name, "health-heartbeat")


if __name__ == "__main__":
    unittest.main(verbosity=2)
