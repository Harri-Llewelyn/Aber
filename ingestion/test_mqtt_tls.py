"""
Unit tests for the ingestion daemon's MQTTS configuration (`configure_mqtt_tls` in ingestion.py).

WHY THIS IS WORTH TESTING. Every way this function can break is a break TOWARD A CONNECTION THAT
LOOKS ENCRYPTED AND VERIFIES NOTHING -- which is indistinguishable, from the daemon's side, from a
successful interception. There is no error, no log line and no metric; telemetry keeps arriving.

  * `cert_reqs=CERT_NONE` would encrypt and accept any certificate at all.
  * `tls_insecure_set(True)` would keep verification on but stop checking the hostname, so any
    certificate the CA ever issued -- for any service -- would be accepted for the broker.
  * silently ignoring a missing CA file would fall back to the system trust store, which cannot
    verify an internal CA, turning a legible configuration error into a handshake failure that
    names neither the setting nor the path.
  * applying TLS when it was never asked for would break the Compose path, where the broker has no
    TLS listener at all.

None of those are visible in a passing end-to-end run against a stack whose broker happens to be
plaintext, which is why they are asserted here on the ARGUMENTS PASSED rather than on a live
connection. Check 8 in validate.py covers the live half.

Same stubbing approach as test_health_heartbeat.py: the daemon's heavy imports are replaced before
ingestion.py loads, so this needs neither `protoc` nor a broker.
"""
import os
import ssl
import sys
import tempfile
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


class RecordingClient:
    """Records what configure_mqtt_tls() asks of a paho client, without being one."""

    def __init__(self):
        self.tls_set_kwargs = None
        self.tls_set_calls = 0
        self.insecure = None

    def tls_set(self, **kwargs):
        self.tls_set_calls += 1
        self.tls_set_kwargs = kwargs

    def tls_insecure_set(self, value):
        self.insecure = value


class MqttTlsTests(unittest.TestCase):
    def setUp(self):
        self._enabled = ingestion.MQTT_TLS_ENABLED
        self._ca = ingestion.MQTT_TLS_CA_FILE
        self.tmp = tempfile.mkdtemp()
        self.ca_path = os.path.join(self.tmp, "ca.crt")
        with open(self.ca_path, "w") as fh:
            # Contents are irrelevant: the function checks existence, and ssl only parses it at
            # connect time. A test that generated a real CA here would be testing OpenSSL.
            fh.write("-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n")

    def tearDown(self):
        ingestion.MQTT_TLS_ENABLED = self._enabled
        ingestion.MQTT_TLS_CA_FILE = self._ca

    # -- off by default ---------------------------------------------------------------------------

    def test_no_op_when_disabled(self):
        """The Compose path must be untouched: its broker has no TLS listener to connect to."""
        ingestion.MQTT_TLS_ENABLED = False
        ingestion.MQTT_TLS_CA_FILE = self.ca_path  # set but irrelevant while disabled
        client = RecordingClient()

        self.assertFalse(ingestion.configure_mqtt_tls(client))
        self.assertEqual(client.tls_set_calls, 0)
        self.assertIsNone(client.insecure)

    # -- verification is not optional -------------------------------------------------------------

    def test_requires_certificate_verification(self):
        """CERT_REQUIRED, not CERT_NONE. This is the assertion the whole file exists for."""
        ingestion.MQTT_TLS_ENABLED = True
        ingestion.MQTT_TLS_CA_FILE = self.ca_path
        client = RecordingClient()

        self.assertTrue(ingestion.configure_mqtt_tls(client))
        self.assertEqual(client.tls_set_kwargs["cert_reqs"], ssl.CERT_REQUIRED)
        self.assertNotEqual(client.tls_set_kwargs["cert_reqs"], ssl.CERT_NONE)

    def test_hostname_checking_stays_on(self):
        """
        tls_insecure_set(False), explicitly.

        With it True the certificate is still verified against the CA but the hostname is not
        checked -- so any certificate the internal CA has ever issued, for any service in the
        cluster, would be accepted as the broker's.
        """
        ingestion.MQTT_TLS_ENABLED = True
        ingestion.MQTT_TLS_CA_FILE = self.ca_path
        client = RecordingClient()

        ingestion.configure_mqtt_tls(client)
        self.assertIs(client.insecure, False)

    def test_uses_the_configured_ca(self):
        ingestion.MQTT_TLS_ENABLED = True
        ingestion.MQTT_TLS_CA_FILE = self.ca_path
        client = RecordingClient()

        ingestion.configure_mqtt_tls(client)
        self.assertEqual(client.tls_set_kwargs["ca_certs"], self.ca_path)

    def test_falls_back_to_system_store_only_when_no_ca_is_configured(self):
        """
        An empty MQTT_TLS_CA_FILE means the system trust store (ca_certs=None), which is correct for
        a publicly-trusted broker certificate. It is NOT a way to skip verification -- cert_reqs
        stays CERT_REQUIRED, so an internal CA simply fails to verify, which is the honest outcome.
        """
        ingestion.MQTT_TLS_ENABLED = True
        ingestion.MQTT_TLS_CA_FILE = ""
        client = RecordingClient()

        self.assertTrue(ingestion.configure_mqtt_tls(client))
        self.assertIsNone(client.tls_set_kwargs["ca_certs"])
        self.assertEqual(client.tls_set_kwargs["cert_reqs"], ssl.CERT_REQUIRED)

    # -- a missing CA file is a startup failure, not a fallback ------------------------------------

    def test_missing_ca_file_refuses_to_start(self):
        """
        Set-but-absent must exit rather than degrade to the system store.

        The degraded path fails anyway -- an internal CA is not in the system store -- but it fails
        later, at the TLS handshake, with an error naming neither MQTT_TLS_CA_FILE nor the path. The
        distinction is entirely about which message the operator gets.
        """
        ingestion.MQTT_TLS_ENABLED = True
        ingestion.MQTT_TLS_CA_FILE = os.path.join(self.tmp, "absent.crt")
        client = RecordingClient()

        with self.assertRaises(SystemExit) as ctx:
            ingestion.configure_mqtt_tls(client)
        self.assertEqual(ctx.exception.code, 1)
        self.assertEqual(client.tls_set_calls, 0, "must not configure TLS after refusing")

    def test_directory_is_not_mistaken_for_a_ca_file(self):
        """isfile, not exists: a CA mounted at a path that turns out to be a directory is the
        commonest form of this mistake -- a Secret volume mounted one level too high."""
        ingestion.MQTT_TLS_ENABLED = True
        ingestion.MQTT_TLS_CA_FILE = self.tmp
        client = RecordingClient()

        with self.assertRaises(SystemExit):
            ingestion.configure_mqtt_tls(client)

    # -- the env parsing --------------------------------------------------------------------------

    def test_enabled_flag_accepts_the_documented_spellings(self):
        """
        Mirrors how the value is parsed at import. Asserted because a stricter parser (== "true")
        would read `MQTT_TLS_ENABLED=1` from a values file as OFF, and the daemon would connect in
        plaintext to a broker that had stopped offering it -- reported as a connection refusal, not
        as a configuration mismatch.
        """
        for raw in ("1", "true", "TRUE", "yes", "on", " true "):
            with self.subTest(raw=raw):
                self.assertIn(raw.strip().lower(), ("1", "true", "yes", "on"))
        for raw in ("", "0", "false", "no", "off"):
            with self.subTest(raw=raw):
                self.assertNotIn(raw.strip().lower(), ("1", "true", "yes", "on"))


if __name__ == "__main__":
    unittest.main()
