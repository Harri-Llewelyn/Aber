"""
A stored capture reaches the historian, through the real worker, broker and daemon.

    python ingestion/test_playback_replay.py

WHAT THIS ASSERTS THAT NOTHING ELSE CAN. `test_capture_playback.py` proves `plan_playback()`
computes the right topics, payloads and delays, and `test_playback_credentials.py` proves the
worker resolves the passwords it holds. Both are properties of the source. Neither can prove the
claim the feature exists for:

    a capture published from the page arrives in the historian under the REPLAY LANE, and
    under nothing else -- through a real broker, a real daemon and a real credential delivery.

Two databases, the credential service, the broker, the replay worker and the ingestion daemon all
have to agree for that to hold, and every one of them can break while the others stay internally
consistent. Two already have: the credential nothing had issued, and the worker that read its
credentials once at startup. Both left a stack where every page said the right thing and no
telemetry moved, because a refused MQTT connection is invisible past CONNECT and Sparkplug
publishes at QoS 0.

THE SENTINEL METRIC IS WHAT MAKES THE IDENTITY ASSERTION POSSIBLE. The interesting question is not
"did rows appear" but "did they appear under the replay lane and under NOTHING else" -- and a
historian holding live traffic, earlier runs of this suite, and a fleet publishing throughout
cannot answer that about an ordinary metric name. A name generated per run can only have come from
this replay, so the set of assets carrying it IS the set the identity rewrite produced.

Needs the stack up AND `playback.enabled`, which `values-dev.yaml` sets. Without the worker the
job sits PENDING and setUpClass says so rather than timing out against the broker.
"""

import json
import os
import re
import secrets
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import psycopg2

REPO = Path(__file__).resolve().parent.parent

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
ADMIN_EMAIL = os.getenv("ACS_ADMIN_EMAIL", "admin@aber.local")
ADMIN_PASSWORD = os.getenv("ACS_ADMIN_PASSWORD", "aber123")

BUCKET = os.getenv("CAPTURE_BUCKET", "broker-captures")

# The historian, on 5433, as every other suite that reads it.
DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", os.getenv("DB_PORT", "5433"))
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

REQUIRE = os.getenv("REQUIRE_PLAYBACK_REPLAY") == "1"

# The Supabase database, as its OWNER. Used for one thing: clearing the audit rows this suite's
# fixtures generate. `digital_thread` is append-only to every application role, service_role
# included, so PostgREST cannot remove them. validate.py carries the same connection for the same
# reason.
SUPABASE_DB_HOST = os.getenv("SUPABASE_DB_HOST", "localhost")
SUPABASE_DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
SUPABASE_DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
SUPABASE_DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
SUPABASE_DB_PASS = os.getenv("POSTGRES_PASSWORD", "postgres")

# The machine this suite pretends to have recorded, and the gateway it hangs off.
#
# PINNED, so a run killed between setUpClass and tearDownClass leaves rows the next run reclaims
# rather than a new pair every time. They differ in the FIRST hex block on purpose: `sparkplug_id`
# is generated from the first 21 hex characters of the uuid, so two ids differing only in the last
# block generate the SAME wire identity and collide on the unique index.
#
# A FIXTURE RATHER THAN A SEEDED DEVICE, because a fresh stack has neither devices nor gateways:
# the demonstration floor was removed and `tutorial/README.md` builds one machine by hand. A suite
# that picked a real device would run on a developer's stack and skip on an empty one.
SOURCE_GATEWAY_ID = "3a000000-0000-4000-8000-000000000001"
SOURCE_DEVICE_ID = "3b000000-0000-4000-8000-000000000001"

# How long each stage may take.
#
# THE CREDENTIAL WINDOW IS SIZED BY THE KUBELET, NOT BY THE WORKER. The credential service patches
# the Secret as it answers, and the worker re-reads its file every three-second poll -- but the
# file is a projected Secret volume, and the kubelet refreshes those on its own sync period
# (a minute by default) plus its cache TTL. Measured on k3d: the Secret held the new password
# while the pod's copy was still empty, and the worker logged the gain about a minute after the
# mint. Anything under two minutes here would be timing the kubelet.
CREDENTIAL_TIMEOUT = 240

# A BOUND, NOT THE SIGNAL, since 0129. The status row now answers "has the worker picked up the
# CURRENT password": it reports which gateways it has taken a new password for, the database stamps
# those, and `playback_stale_credentials()` compares them with the last CREDENTIAL_ISSUED row. This
# suite waits on that rather than on the clock.
#
# The margin is kept as an upper bound on how long that should take -- a minute is the kubelet's
# default sync period for a projected Secret volume, ninety seconds is that plus slack -- so a run
# that never clears fails with something specific rather than hanging.
PROJECTION_MARGIN = 90
JOB_TIMEOUT = 120
HISTORIAN_TIMEOUT = 60

# The worker's heartbeat window, as the playback dialog reads it.
WORKER_STALE_SECONDS = 120

# How many historian rows the fixture should produce, and why it is not the message count.
#
# A DBIRTH IS AN ANNOUNCEMENT, NOT A READING. process_dbirth() records the declared metric set and
# brings the device ONLINE; it writes no telemetry, so only the two DDATA messages leave rows.
# Measured, and worth pinning: a fixture author counting messages would expect three and read the
# shortfall as a dropped publish, which is the failure this suite is meant to detect.
EXPECTED_READINGS = 2
EXPECTED_VALUES = [2.0, 3.0]


def capture_version():
    """
    The capture format version, read out of capture.py as TEXT rather than imported.

    `capture` imports the GENERATED protobuf module, which is gitignored and built by `protoc`
    inside the ingestion image -- so importing it here would make this suite unrunnable on the
    host, which is exactly where the stack lane runs it. validate.py is in-cluster for the same
    reason.
    """
    source = (REPO / "ingestion" / "capture.py").read_text(encoding="utf-8")
    match = re.search(r"^CAPTURE_VERSION\s*=\s*(\d+)", source, re.M)
    if not match:
        raise AssertionError("capture.py declares no CAPTURE_VERSION")
    return int(match.group(1))


def skip_or_fail(message):
    if REQUIRE:
        raise AssertionError(f"REQUIRE_PLAYBACK_REPLAY=1, so this cannot be skipped: {message}")
    raise unittest.SkipTest(message)


def _request(url, method="GET", body=None, headers=None, timeout=30):
    req = urllib.request.Request(
        url, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers or {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"raw": raw[:400]}


def sign_in():
    """A real session. Every gate this suite calls resolves auth.uid() against user_roles, which
    service_role does not have -- minting a credential and starting a playback are operators' acts."""
    status, data = _request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST",
        body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
    )
    if status != 200 or not data.get("access_token"):
        raise AssertionError(
            f"could not sign in as {ADMIN_EMAIL} ({status}). The stack lane expects the seeded "
            f"Administrator; override with ACS_ADMIN_EMAIL / ACS_ADMIN_PASSWORD."
        )
    return data["access_token"]


class Session:
    """PostgREST, RPC and Storage as one signed-in person."""

    def __init__(self, token):
        self.token = token

    def _headers(self, extra=None):
        return {
            "apikey": PUBLISHABLE_KEY,
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            **(extra or {}),
        }

    def rest(self, path, method="GET", body=None, prefer=None):
        return _request(f"{SUPABASE_URL}/rest/v1{path}", method, body,
                        self._headers({"Prefer": prefer} if prefer else None))

    def upsert(self, table, row):
        """Insert or reclaim a pinned fixture row, and hand back what the database made of it --
        `sparkplug_id` is generated, so the row that comes back is the only place it exists."""
        status, body = self.rest(
            f"/{table}?on_conflict=id", "POST", row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        if status not in (200, 201) or not body:
            raise AssertionError(f"could not create the fixture {table} row: {status} {body}")
        return body[0]

    def rpc(self, name, args):
        return _request(f"{SUPABASE_URL}/rest/v1/rpc/{name}", "POST", args, self._headers())

    def upload(self, path, document):
        """The object goes up before the row, matching the browser: a row naming an object that
        does not exist would be a capture that fails at its first read, inside a playback."""
        return _request(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}",
            method="POST",
            body=document,
            headers=self._headers({"x-upsert": "true"}),
        )

    def remove(self, path):
        return _request(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}",
            method="DELETE", headers=self._headers(),
        )


# Every database connection here is bounded.
#
# psycopg2 HAS NO DEFAULT TIMEOUT, and this suite polls: with `postgresTls` on, a port-forward dies
# on a TLS disconnect, so the next connect reaches a socket nothing is answering and blocks
# forever. A poll loop that hangs is worse than one that fails -- the run never ends and reports
# nothing, which is how the first live run of this suite ended.
CONNECT_TIMEOUT = 10


def historian():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, database=DB_NAME, user=DB_USER, password=DB_PASSWORD,
        connect_timeout=CONNECT_TIMEOUT,
    )


def build_capture(recorded_gateway, recorded_device, metric, epoch_ms):
    """
    A three-message capture: the device's birth, then two readings.

    THE BIRTH IS NOT OPTIONAL. `process_dbirth()` is what sets a device ONLINE and records its
    declared metrics; a capture of DDATA alone replays into the historian but leaves the lane
    OFFLINE, which is the difference `birth_captured` exists to make visible.

    Every metric carries its OWN timestamp as well as the payload's, because process_ddata()
    judges the metric's and only falls back to the payload's -- so a capture that rebased one and
    not the other is the failure this fixture would otherwise not notice.
    """
    def payload(offset_ms, value, with_asset_id):
        stamp = epoch_ms + offset_ms
        metrics = []
        if with_asset_id:
            # Rewritten onto the lane by rewrite_identity(). Present here precisely so the rewrite
            # is exercised: a birth still claiming the recorded id would quarantine the lane.
            metrics.append({"name": "Asset_ID", "datatype": 12,
                            "string_value": recorded_device, "timestamp": stamp})
        metrics.append({"name": metric, "datatype": 10,
                        "double_value": value, "timestamp": stamp})
        return {"timestamp": stamp, "metrics": metrics}

    messages = [
        {"offset_ms": 0, "encoding": "json",
         "topic": f"spBv1.0/Aber/DBIRTH/{recorded_gateway}/{recorded_device}",
         "payload": payload(0, 1.0, True)},
        {"offset_ms": 200, "encoding": "json",
         "topic": f"spBv1.0/Aber/DDATA/{recorded_gateway}/{recorded_device}",
         "payload": payload(200, 2.0, False)},
        {"offset_ms": 400, "encoding": "json",
         "topic": f"spBv1.0/Aber/DDATA/{recorded_gateway}/{recorded_device}",
         "payload": payload(400, 3.0, False)},
    ]
    return {
        "acs_capture_version": capture_version(),
        "recorded_at": "2026-09-14T00:00:00+00:00",
        "recorded_from": {"broker": "fixture", "topic": "spBv1.0/#"},
        "capture_epoch_ms": epoch_ms,
        "duration_ms": 400,
        "identities": {"edge_nodes": [recorded_gateway], "devices": [recorded_device]},
        "messages": messages,
    }


def setUpModule():
    """Skip only when there is no stack. Once there is one, every failure is a failure."""
    if not PUBLISHABLE_KEY:
        skip_or_fail("SUPABASE_PUBLISHABLE_KEY is not set; the stack lane reads it from the "
                     "release Secret (npm run dev:test).")
    try:
        urllib.request.urlopen(f"{SUPABASE_URL}/auth/v1/health", timeout=5).read()
    except Exception as exc:
        skip_or_fail(f"Supabase is not reachable at {SUPABASE_URL} ({exc}). This suite needs the "
                     f"stack up: npm run dev:up")


class PlaybackReachesTheHistorian(unittest.TestCase):
    """
    One replay, walked end to end in setUpClass; each test asserts one step of the path.

    The path is a pipeline, so it is performed once rather than per test: the steps are not
    independent and repeating a credential mint per assertion would replace the broker account
    three times.
    """

    @classmethod
    def setUpClass(cls):
        cls.session = Session(sign_in())
        cls.metric = "PLAYBACK/REPLAY_" + secrets.token_hex(8).upper()
        # Set before the first step that can fail: unittest skips tearDownClass when setUpClass
        # raises, and the pinned ids are what the next run reclaims, but a partially-built class
        # must still be safe to read.
        cls.capture_id = None
        cls.storage_path = None
        cls.source = None
        cls.lane_map = None

        cls.playback_gateway = cls._playback_gateway()
        cls.source = cls._source_device()

        cls.delivery = cls._mint_credential()
        cls.reported_after = cls._await_worker_credential()

        cls._store_capture()
        cls.lane_map = cls._prepare_lanes()
        cls.job = cls._run_playback()
        cls.rows = cls._await_historian()

    @classmethod
    def tearDownClass(cls):
        """
        Everything this suite made, in the order the foreign keys want.

        THE LANE GOES FIRST. `devices_shadow_of_fkey` is ON DELETE SET NULL, so deleting the
        origin while its lane survives leaves a replay lane standing in for nothing -- legal, and
        exactly the provenance-less row the replay-lane gate exists to stop anyone creating.

        THE SOURCE DEVICE IS DELETED EXPLICITLY, because `devices_gateway_id_fkey` is SET NULL
        rather than CASCADE: deleting a gateway leaves its devices UNASSIGNED, which is right for a
        plant (asset history outlives the connector that carried it) and wrong for a fixture. Left
        to the gateway, the device survived the first run of this suite as an unassigned row.

        The CREDENTIAL_ISSUED audit row is deliberately kept: a broker credential really was
        issued and the Playback gateway really does hold it afterwards. The fixture entities'
        audit rows are cleared, because they describe machines that no longer exist.
        """
        lane = (cls.lane_map or {}).get(cls.source["sparkplug_id"]) if cls.source else None
        if lane:
            cls.session.rest(f"/devices?sparkplug_id=eq.{lane}", method="DELETE")
        if cls.capture_id:
            cls.session.rest(f"/captures?id=eq.{cls.capture_id}", method="DELETE")
        if cls.storage_path:
            cls.session.remove(cls.storage_path)
        cls.session.rest(f"/devices?id=eq.{SOURCE_DEVICE_ID}", method="DELETE")
        cls.session.rest(f"/gateways?id=eq.{SOURCE_GATEWAY_ID}", method="DELETE")

        try:
            conn = historian()
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("DELETE FROM telemetry WHERE metric_name = %s", (cls.metric,))
            conn.close()
        except Exception as err:  # noqa: BLE001 -- cleanup must not mask a real failure
            print(f"historian cleanup warning: {err}")

        # The audit rows, which need the owner: digital_thread takes no DELETE from any
        # application role, so PostgREST cannot clear what the fixtures wrote.
        try:
            conn = psycopg2.connect(
                host=SUPABASE_DB_HOST, port=SUPABASE_DB_PORT, database=SUPABASE_DB_NAME,
                user=SUPABASE_DB_USER, password=SUPABASE_DB_PASS,
                connect_timeout=CONNECT_TIMEOUT,
            )
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM public.digital_thread WHERE entity_id = ANY(%s::uuid[])",
                    ([SOURCE_GATEWAY_ID, SOURCE_DEVICE_ID],),
                )
            conn.close()
        except Exception as err:  # noqa: BLE001
            print(f"audit cleanup warning: {err}; fixture rows left in digital_thread")

    # ------------------------------------------------------------------------------------------
    # The path
    # ------------------------------------------------------------------------------------------
    @classmethod
    def _playback_gateway(cls):
        status, rows = cls.session.rest(
            "/gateways?select=id,name,sparkplug_id,sparkplug_group"
            "&is_shadow=eq.true&is_archived=eq.false&limit=1"
        )
        if status != 200 or not rows:
            raise AssertionError(
                f"no live playback gateway ({status}). One is seeded; a stack without it cannot "
                f"replay anything, and start_playback_job() refuses every other target."
            )
        return rows[0]

    @classmethod
    def _source_device(cls):
        """
        The machine this capture is supposed to have come from, created here.

        `conformance_policy` is left at its default of `audit`, and that is load bearing rather
        than incidental: the lane copies the origin's policy, and under `enforce` the sentinel
        metric would be outside the attached schema and DROPPED on ingest -- a replay that reports
        success and writes nothing, which is the exact failure shape this suite exists to catch
        and would instead be manufacturing. No schema is attached for the same reason.
        """
        gateway = cls.session.upsert("gateways", {
            "id": SOURCE_GATEWAY_ID,
            "name": "PLAYBACK_REPLAY_Source_Gateway",
            "description": "Fixture for ingestion/test_playback_replay.py. Safe to delete.",
        })
        device = cls.session.upsert("devices", {
            "id": SOURCE_DEVICE_ID,
            "name": "PLAYBACK_REPLAY_Source_Device",
            "gateway_id": gateway["id"],
            "description": "Fixture for ingestion/test_playback_replay.py. Safe to delete.",
        })
        if device["conformance_policy"] != "audit":
            raise AssertionError(
                f"the fixture device is {device['conformance_policy']}, not audit; the sentinel "
                f"metric would be dropped on ingest and the replay would look broken"
            )
        device["gateways"] = gateway
        return device

    @classmethod
    def _mint_credential(cls):
        """
        Issue the Playback gateway's broker credential, which DELIVERS it.

        This is the half that has broken twice, and it is why the suite mints rather than reading
        whatever the stack happens to hold: `gateway_is_playback_delivery_target()` answers
        is_simulated, the edge function passes it as `deliver_to_playback`, and the credential
        service writes the password where the worker reads. Nothing else exercises that chain.
        """
        status, body = _request(
            f"{SUPABASE_URL}/functions/v1/gateway-credential",
            method="POST",
            body={"gateway_id": cls.playback_gateway["id"]},
            headers={"apikey": PUBLISHABLE_KEY,
                     "Authorization": f"Bearer {cls.session.token}",
                     "Content-Type": "application/json"},
        )
        if status != 200:
            raise AssertionError(f"could not mint the playback credential: {status} {body}")
        cls.minted_at = time.monotonic()
        return body

    @classmethod
    def _credential_is_stale(cls, sparkplug_id):
        """Has this gateway's credential been re-issued since the worker last picked one up?

        `playback_stale_credentials()` (0129) is what the playback dialog and
        `start_playback_job()` both consult. A read that fails answers True: this is a wait, and
        proceeding on a failed read is how the suite would race the delivery it exists to wait for.
        """
        status, rows = cls.session.rest("/rpc/playback_stale_credentials", method="POST", body={})
        if status != 200:
            return True
        return any(r.get("sparkplug_id") == sparkplug_id for r in (rows or []))

    @classmethod
    def _await_worker_credential(cls):
        """
        Wait for the worker to SAY it holds the target.

        The database knows the platform issued a credential; only the worker knows it received
        one, which is what `playback_worker_status` carries. Waiting on it here also proves the
        worker re-resolves its credentials while running -- it used to read them once in main(),
        so a freshly delivered password reached it only after a container restart.
        """
        wanted = cls.playback_gateway["sparkplug_id"]
        deadline = time.monotonic() + CREDENTIAL_TIMEOUT
        last = None
        while time.monotonic() < deadline:
            status, rows = cls.session.rest(
                "/playback_worker_status?select=held_edge_nodes,reported_at&limit=1")
            if status == 200 and rows:
                last = rows[0]
                held = wanted in (last.get("held_edge_nodes") or [])
                # HELD IS NOT ENOUGH, and that is the whole of #217: on a re-issue the id was
                # already reported from the PREVIOUS file, so the id alone would let the replay
                # start against a password the broker has already replaced. 0129 made the
                # difference reportable, and this asks for it rather than timing the kubelet.
                if held and not cls._credential_is_stale(wanted):
                    return last
            time.sleep(3)
        raise AssertionError(
            f"the playback worker never reported holding {wanted} within {CREDENTIAL_TIMEOUT}s "
            f"(last report: {last}). Either the worker is not running -- `playback.enabled`, which "
            f"values-dev.yaml sets -- or the credential was issued and not delivered."
        )

    @classmethod
    def _store_capture(cls):
        """Upload the fixture and register it, the two steps the browser performs in that order."""
        epoch_ms = int(time.time() * 1000)
        document = build_capture(
            cls.source["gateways"]["sparkplug_id"], cls.source["sparkplug_id"],
            cls.metric, epoch_ms,
        )
        cls.document = document
        cls.storage_path = f"{cls.source['sparkplug_id']}/capture.json"

        status, body = cls.session.upload(cls.storage_path, document)
        if status not in (200, 201):
            raise AssertionError(f"could not upload the fixture capture: {status} {body}")

        status, capture_id = cls.session.rpc("register_uploaded_capture", {
            "p_subject_kind": "device",
            "p_subject_id": cls.source["id"],
            "p_storage_path": cls.storage_path,
            "p_size_bytes": len(json.dumps(document)),
            "p_message_count": len(document["messages"]),
            # device_ids is what ensure_shadow_devices() reads to decide which lanes to mint.
            "p_manifest": {"device_ids": [cls.source["sparkplug_id"]],
                           "edge_node_ids": [cls.source["gateways"]["sparkplug_id"]],
                           "metric_names": [cls.metric],
                           "birth_captured": True, "uses_aliases": False},
            "p_note": "playback replay conformance fixture",
            "p_replace": True,
        })
        if status not in (200, 201) or not capture_id:
            raise AssertionError(f"could not register the fixture capture: {status} {capture_id}")
        cls.capture_id = capture_id

    @classmethod
    def _prepare_lanes(cls):
        status, mapping = cls.session.rpc(
            "ensure_shadow_devices", {"p_capture_id": cls.capture_id})
        if status != 200 or not mapping:
            raise AssertionError(f"could not mint the replay lanes: {status} {mapping}")
        return mapping

    @classmethod
    def _run_playback(cls):
        status, job_id = cls.session.rpc("start_playback_job", {
            "p_capture_id": cls.capture_id,
            "p_target_gateway_id": cls.playback_gateway["id"],
            "p_device_map": cls.lane_map,
            "p_speed": 1.0,
        })
        if status not in (200, 201) or not job_id:
            raise AssertionError(f"start_playback_job refused the fixture: {status} {job_id}")

        deadline = time.monotonic() + JOB_TIMEOUT
        job = None
        while time.monotonic() < deadline:
            got, rows = cls.session.rest(
                f"/playback_jobs?select=*&id=eq.{job_id}&limit=1")
            if got == 200 and rows:
                job = rows[0]
                if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
                    return job
            time.sleep(2)
        raise AssertionError(
            f"the playback did not finish within {JOB_TIMEOUT}s (last seen: {job}). A job left "
            f"PENDING means no worker claimed it."
        )

    @classmethod
    def _await_historian(cls):
        """
        Which assets carry the sentinel metric, and what they were given.

        Polled rather than read once: the daemon batches telemetry through the writer thread, so
        the rows appear a moment after the last publish rather than with it.
        """
        deadline = time.monotonic() + HISTORIAN_TIMEOUT
        rows = []
        while time.monotonic() < deadline:
            try:
                conn = historian()
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT asset_id, val_double FROM telemetry WHERE metric_name = %s "
                            "ORDER BY time", (cls.metric,))
                        rows = cur.fetchall()
                finally:
                    conn.close()
            except psycopg2.Error as err:
                # A dev-loop port-forward dies on a TLS disconnect and the next one reconnects, so
                # one refused poll is not a verdict on the replay.
                print(f"historian poll retrying: {err}")
            if len(rows) >= EXPECTED_READINGS:
                return rows
            time.sleep(3)
        return rows

    # ------------------------------------------------------------------------------------------
    # The assertions, one per step
    # ------------------------------------------------------------------------------------------
    def test_the_credential_was_delivered_and_not_merely_issued(self):
        """
        `playback_delivered` is the server's own answer: true written where the worker reads,
        false a playback target whose delivery failed, null not a playback target. Null here would
        mean the delivery predicate stopped recognising the one gateway playback exists for.
        """
        self.assertIsNotNone(
            self.delivery.get("playback_delivered"),
            "the Playback gateway was not treated as a delivery target; "
            "gateway_is_playback_delivery_target() and start_playback_job() have diverged",
        )
        self.assertTrue(
            self.delivery["playback_delivered"],
            "the credential was issued but not delivered, so the worker holds the previous "
            "password and every job fails at CONNACK with rc=5",
        )

    def test_the_worker_reports_a_recent_heartbeat(self):
        """A stale report and an empty one are different problems; the dialog tells them apart by
        this timestamp, so it has to move."""
        reported = self.reported_after["reported_at"]
        age = time.time() - _epoch_seconds(reported)
        self.assertLess(
            age, WORKER_STALE_SECONDS,
            f"the worker's last report is {age:.0f}s old, past the {WORKER_STALE_SECONDS}s window "
            f"the playback dialog treats as running",
        )

    def test_the_job_completed_having_published_every_message(self):
        self.assertEqual(
            self.job["status"], "COMPLETED",
            f"the playback did not complete: {self.job['status']} -- {self.job.get('error')}",
        )
        self.assertEqual(
            self.job["messages_sent"], len(self.document["messages"]),
            "the worker reported a different number of messages than the capture holds",
        )

    def test_the_replayed_frames_reached_the_historian(self):
        """
        The claim the feature makes. A QoS 0 publish the broker refuses is dropped with no PUBACK,
        so a job that reports success having moved nothing is the failure mode -- and only the
        historian can tell the two apart.
        """
        self.assertGreaterEqual(
            len(self.rows), EXPECTED_READINGS,
            f"the historian holds {len(self.rows)} row(s) for {self.metric}; the capture's two "
            f"DDATA messages should each leave one. The job reported "
            f"{self.job.get('messages_sent')} message(s) published, so either the broker refused "
            f"them or the daemon dropped them on ingest.",
        )
        self.assertEqual(
            [float(r[1]) for r in self.rows[:EXPECTED_READINGS]], EXPECTED_VALUES,
            "the replayed values arrived out of order or altered",
        )

    def test_it_arrived_under_the_replay_lane_and_nothing_else(self):
        """
        THE ASSERTION THIS SUITE EXISTS FOR. The identity rewrite is what keeps a replay out of a
        real machine's history, and it fails silently in both directions: rewrite nothing and the
        broker drops every publish, rewrite the topic alone and the lane is quarantined. The
        sentinel metric can only have come from this replay, so the set of assets carrying it is
        exactly the set the rewrite produced.
        """
        lane = self.lane_map[self.source["sparkplug_id"]]
        carriers = {r[0] for r in self.rows}
        self.assertEqual(
            carriers, {lane},
            f"{self.metric} was written under {sorted(carriers)}; the only asset that may carry a "
            f"replayed reading is the lane {lane}. The recorded device "
            f"{self.source['sparkplug_id']} appearing here means the edge-node or device segment "
            f"was not rewritten, and a replay has been written into a real machine's history.",
        )

    def test_the_replayed_birth_announced_the_lane(self):
        """
        The DBIRTH leaves no telemetry, so this is the only evidence it was processed at all -- and
        a capture whose birth is not replayed is the alias trap `birth_captured` exists to warn
        about, arriving as a device that never comes online.

        `last_birth_metrics` rather than `status`: the declared set is a durable record, while
        ONLINE is withdrawn by the device watchdog a few minutes after the replay ends, which would
        make this assertion a race against a timer. Asset_ID is deliberately absent from the set --
        an identity metric is not a declared reading.
        """
        lane = self.lane_map[self.source["sparkplug_id"]]
        status, rows = self.session.rest(
            f"/devices?select=last_birth_metrics&sparkplug_id=eq.{lane}&limit=1")
        self.assertEqual(status, 200)
        self.assertTrue(rows, f"the lane {lane} does not exist")
        declared = rows[0].get("last_birth_metrics") or []
        self.assertIn(
            self.metric, declared,
            f"the lane's declared metric set is {declared}; the replayed DBIRTH carried "
            f"{self.metric}, so the birth did not reach the daemon",
        )
        self.assertNotIn("Asset_ID", declared,
                         "an identity metric leaked into the declared set")

    def test_the_lane_carries_its_provenance_and_the_origins_contract(self):
        """
        A lane stands in for a machine, and `shadow_of` is what says which. It also carries the
        origin's schema: a replay judged against no schema is unjudged, and the metric contract is
        what makes a replayed chart comparable with the machine's own.
        """
        lane = self.lane_map[self.source["sparkplug_id"]]
        status, rows = self.session.rest(
            f"/devices?select=id,shadow_of,schema_id,conformance_policy,gateway_id"
            f"&sparkplug_id=eq.{lane}&limit=1")
        self.assertEqual(status, 200)
        self.assertTrue(rows, f"the lane {lane} the map named does not exist")
        self.assertEqual(rows[0]["shadow_of"], self.source["id"],
                         "the lane does not record which machine it stands in for")
        self.assertEqual(rows[0]["gateway_id"], self.playback_gateway["id"],
                         "the lane is not bound to the playback gateway")
        self.assertEqual(rows[0]["conformance_policy"], self.source["conformance_policy"],
                         "the lane did not inherit the origin's conformance policy")

    def test_the_capture_is_filed_under_the_subject_recorded(self):
        """Not under the gateway it plays back as. The bucket's prefix rule admits a `dev...`
        folder for exactly this reason, and the gate derives the path rather than taking one."""
        status, rows = self.session.rest(
            f"/captures?select=storage_path,subject_sparkplug_id,source"
            f"&id=eq.{self.capture_id}&limit=1")
        self.assertEqual(status, 200)
        self.assertTrue(rows)
        self.assertEqual(rows[0]["storage_path"],
                         f"{self.source['sparkplug_id']}/capture.json")
        self.assertEqual(rows[0]["source"], "uploaded")


def _epoch_seconds(stamp):
    """A PostgREST timestamptz as epoch seconds. `fromisoformat` reads the offset but not the `Z`
    spelling before Python 3.11, and this suite runs on whatever the host has."""
    from datetime import datetime
    text = stamp.replace("Z", "+00:00")
    # Postgres emits microseconds of variable width; fromisoformat wants 3 or 6 digits.
    text = re.sub(r"\.(\d{1,6})(?=[+-])", lambda m: "." + m.group(1).ljust(6, "0"), text)
    return datetime.fromisoformat(text).timestamp()


if __name__ == "__main__":
    unittest.main(verbosity=2)
