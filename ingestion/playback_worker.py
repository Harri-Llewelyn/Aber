"""
Publishing a stored capture back into the stack, as a simulated gateway.

=================================================================================================
A SEPARATE PROCESS, AND A SEPARATE PRINCIPAL, AND NOT THE INGESTION DAEMON
=================================================================================================

`mosquitto.acl` grants the ingestion principal `read spBv1.0/#` and `write spBv1.0/+/NCMD/+` --
rebirth requests and nothing else. Teaching it to publish asset data would widen the one account the
whole ACL is built around, and `verify_gateway_binding()` cannot tell a forged message under a
correctly bound device from a real one.

THE SEQ OBJECTION THAT KEPT CAPTURE INSIDE THE DAEMON DOES NOT APPLY HERE. That objection was about
a second SUBSCRIBER: `_last_seq` is keyed `(group, edge_node)`, so two consumers split the stream and
gap detection fires permanently. This process only PUBLISHES. It holds no subscription.

=================================================================================================
TWO IDENTITIES, WHICH IS THE ARRANGEMENT WORTH UNDERSTANDING BEFORE READING ANYTHING ELSE
=================================================================================================

  SUPABASE     `Service_Playback` (0056). Reads the queue, reads the capture, writes status.
               Fixed, and the same for every job.
  MQTT         THE TARGET GATEWAY'S OWN ACCOUNT -- username equals its `sparkplug_id`. Per job,
               and supplied as a secret the way `MQTT_VALIDATOR_USER` is.

One says what this may do in the database; the other says what the broker will carry. That split is
what lets `pattern readwrite spBv1.0/+/+/%u/#` confine a playback with NO ACL CHANGE AT ALL: a
worker connected as `gwyAAA...` cannot publish under `gwyBBB...`, because the broker drops it at the
network protocol layer before any subscriber sees it. Even a job carrying a wrong mapping cannot
reach another gateway's topics.

=================================================================================================
WHAT THIS PROCESS DOES NOT DECIDE
=================================================================================================

Nothing about WHETHER a playback is allowed. `start_playback_job()` has already refused a target
that is not `is_simulated`, one holding no broker credential, and a device map naming devices of
another gateway. This process refuses one further thing -- a target it holds no MQTT password for --
and otherwise carries out what it is given.

The publishing itself is `capture.py`'s, unchanged: `plan_playback()` decides every topic, payload
and delay with no broker and no clock, so this file is a loop that cannot make a new decision.

Related: supabase/migrations/0056_playback_orchestration.sql (every gate called here),
         capture.py (the plan, the identity rewrite, the rebasing), README.md item 17 section 5.
"""

import json
import os
import time

import paho.mqtt.client as mqtt

import capture
from logging_config import get_logger

# `get_logger`, not `logging.getLogger(__name__)`: this stack configures NAMED loggers with
# `propagate = False`, so a module logger made the standard-library way has no handler and its INFO
# lines are discarded. capture_worker.py records what that cost when it happened there.
logger = get_logger("playback")

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_PLAYBACK_KEY = os.getenv("SUPABASE_PLAYBACK_KEY", "")

BUCKET = os.getenv("CAPTURE_BUCKET", "broker-captures")
POLL_INTERVAL_SECONDS = float(os.getenv("PLAYBACK_POLL_INTERVAL_SECONDS", "3"))
PROGRESS_INTERVAL_SECONDS = float(os.getenv("PLAYBACK_PROGRESS_INTERVAL_SECONDS", "1"))

# How long to wait for the broker's CONNACK before failing the job.
#
# GENEROUS ON PURPOSE. This is a local broker on the same compose network, where the answer arrives
# in milliseconds, and the cost of waiting is paid once per job rather than per message. Five
# seconds is long enough that a loaded host does not produce a spurious failure, and short enough
# that an operator watching a job does not read the pause as the playback having started.
CONNACK_TIMEOUT_SECONDS = float(os.getenv("PLAYBACK_CONNACK_TIMEOUT_SECONDS", "5"))

# How often this worker restates which gateways it can publish as.
#
# IT IS A HEARTBEAT, NOT A CHANGE FEED, and that is why it repeats rather than reporting once. The
# page has to tell "the worker holds no credentials" from "the worker is not running", and an empty
# list reported once at startup looks identical to both. 30s against the page's own staleness
# window means a worker that dies is visible as down well before anyone finishes reading a dialog.
CREDENTIAL_REPORT_INTERVAL_SECONDS = float(
    os.getenv("PLAYBACK_CREDENTIAL_REPORT_INTERVAL_SECONDS", "30")
)

MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))


def _credentials():
    """
    The broker passwords this worker holds, keyed by gateway `sparkplug_id`.

    TIER TWO OF THREE, AND THE ONLY ONE THAT LIVES OUTSIDE THE DATABASE. The job gate refuses a
    target that is not `is_simulated`; the broker ACL confines whatever connects to its own edge
    node; and this is the middle one -- the worker simply cannot authenticate as a gateway whose
    password it was not given, so a compromised queue cannot make it publish as a real machine.

    A JSON MAP RATHER THAN A PAIR OF VARIABLES, because playback has as many identities as it has
    targets. The single pair is still read as a fallback: it is what `.env` already carries for
    `capture.py play`, and a deployment with one playback gateway should not have to learn a new
    format to keep working.

    NOT LOGGED, EVER. The keys are gateway ids and are safe; the values are broker passwords.
    """
    raw = os.getenv("MQTT_PLAYBACK_CREDENTIALS", "").strip()
    credentials = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                credentials = {str(k): str(v) for k, v in parsed.items()}
            else:
                logger.error(
                    "MQTT_PLAYBACK_CREDENTIALS is not a JSON object, so no playback target has a "
                    "credential. Expected {\"gwy...\": \"password\"}."
                )
        except ValueError as err:
            logger.error(
                "MQTT_PLAYBACK_CREDENTIALS is not valid JSON (%s), so no playback target has a "
                "credential.", err,
            )

    user = os.getenv("MQTT_PLAYBACK_USER", "").strip()
    password = os.getenv("MQTT_PLAYBACK_PASSWORD", "")
    if user and password and user not in credentials:
        credentials[user] = password
    return credentials


def _supabase():
    from supabase import create_client
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    # `.auth()` on the PostgREST sub-client, which is the ONLY thing this pattern authenticates --
    # ingestion.py records at length that setting the session header instead silently sends the
    # anon key. The storage client is built separately below for exactly that reason.
    client.postgrest.auth(SUPABASE_PLAYBACK_KEY)
    client.postgrest.session.headers["X-ACS-Cymru-Actor"] = "playback"
    return client


def _storage():
    """
    A storage client authenticating as the worker, not as `anon`.

    THE SHARED CLIENT WOULD READ AS `anon` AND SAY NOTHING ABOUT IT. `client.storage` keeps the key
    it was constructed with; only the PostgREST sub-client is re-authenticated. capture_worker.py
    hit this and the symptom was a refusal naming RLS that was really about identity.
    """
    from storage3 import create_client as create_storage_client
    return create_storage_client(
        # TRAILING SLASH: storage3 warns and corrects it otherwise, and a UserWarning on every boot
        # is noise that trains a reader to skip the startup lines.
        SUPABASE_URL.rstrip("/") + "/storage/v1/",
        {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + (SUPABASE_PLAYBACK_KEY or SUPABASE_ANON_KEY),
        },
        is_async=False,
    )


def _connect(edge_node_id, password):
    """
    Connect AS the target gateway. Its `sparkplug_id` is the username, and that is the point.

    THE CONNACK IS CAPTURED, WHICH IT WAS NOT, AND THE GAP WAS A SILENT SUCCESS.
    `client.connect()` completes the TCP handshake and returns; the CONNACK arrives later on the
    network loop. So a WRONG password -- as opposed to a missing one -- got past the credential
    check above, connected at the socket level, was refused with rc=5, and every QoS 0 publish
    after that was dropped locally with no error anywhere. The job ran to completion, reported the
    full message count, and moved nothing.

    That is precisely the outcome the credential check's own comment predicts and calls the reason
    it exists -- it just cannot see this case, because a stale password is not a missing one. It
    happens whenever a credential is re-minted and the worker is not restarted, which is the
    ordinary way of rotating one.

    `rc` is recorded rather than raised from the callback: it arrives on paho's thread, where an
    exception would be swallowed and logged by the library rather than reaching the caller.
    """
    client = mqtt.Client(client_id="acs-playback-%s" % edge_node_id)
    client.username_pw_set(edge_node_id, password)
    # A list because the callback closes over it; `rc` stays None until the broker answers, which
    # is itself the third outcome -- no answer at all.
    client.acs_connack = []
    client.on_connect = lambda _c, _u, _f, rc, *args: client.acs_connack.append(rc)
    if os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on"):
        import ssl
        ca = os.getenv("MQTT_TLS_CA_FILE", "").strip()
        client.tls_set(ca_certs=ca or None, cert_reqs=ssl.CERT_REQUIRED,
                       tls_version=ssl.PROTOCOL_TLS_CLIENT)
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    return client


def _run_job(supabase, storage, credentials, job):
    """Publish one capture. Returns (messages_sent, error or None)."""
    job_id = job["id"]
    edge_node = job["target_edge_node_id"]
    password = credentials.get(edge_node)

    if not password:
        # REFUSED HERE RATHER THAN ATTEMPTED. Without a password the connect fails with a broker
        # error that names neither the gateway nor the missing secret, and at QoS 0 a publish that
        # the ACL refuses is dropped with no PUBACK -- so a wrong-credential playback would
        # otherwise report success and move nothing.
        return 0, (
            "this worker holds no broker credential for %s, so it cannot authenticate as that "
            "gateway. Add it to MQTT_PLAYBACK_CREDENTIALS." % edge_node
        )

    # ------------------------------------------------------------------------------------------
    # The capture
    # ------------------------------------------------------------------------------------------
    try:
        body = storage.from_(BUCKET).download(job["capture_storage_path"])
    except Exception as err:
        # 42501 here is the read gate: `Service_Playback` holds Operator, and the bucket's SELECT
        # policy admits it only for the object of a RUNNING job. If this fails on a job that IS
        # running, the policy arm is missing rather than the file.
        return 0, "could not read %s: %s" % (job["capture_storage_path"], err)

    try:
        document = json.loads(body.decode("utf-8") if isinstance(body, bytes) else body)
    except ValueError as err:
        return 0, "%s is not valid JSON: %s" % (job["capture_storage_path"], err)

    # ------------------------------------------------------------------------------------------
    # The plan
    # ------------------------------------------------------------------------------------------
    # EVERYTHING THAT CAN BE WRONG IS DECIDED HERE, with no broker and no clock -- an unmapped
    # device, a rebasing that lands outside the daemon's sanity window, a malformed topic. The
    # publishing loop below cannot make a new decision, which is what makes a dry run and a real
    # run the same computation.
    play_epoch_ms = int(time.time() * 1000)
    speed = float(job.get("speed") or 1.0)
    device_map = job.get("device_map") or {}
    try:
        plan = capture.plan_playback(
            document, edge_node, device_map, play_epoch_ms, speed=speed,
            group=job.get("sparkplug_group"),
        )
    except capture.CaptureError as err:
        return 0, str(err)

    # REPORTED BEFORE PUBLISHING, not discovered after. The daemon's answer to an out-of-window
    # metric is a counter, not an error -- so without this a playback reports success and writes
    # nothing to the historian. Warned rather than refused: a capture carrying one stale device
    # clock is still worth replaying, and the operator is the one who can tell.
    unsane = capture.unsane_timestamps(plan, play_epoch_ms)
    if unsane:
        logger.warning(
            "Playback %s: %d of %d message(s) carry timestamps the daemon will drop as outside its "
            "sanity window. They will be published and silently discarded on ingest.",
            job_id, len(unsane), len(plan),
        )

    # ------------------------------------------------------------------------------------------
    # Publishing
    # ------------------------------------------------------------------------------------------
    try:
        client = _connect(edge_node, password)
    except Exception as err:
        return 0, "could not connect to the broker as %s: %s" % (edge_node, err)

    client.loop_start()

    # ------------------------------------------------------------------------------------------
    # THE BROKER HAS TO ACCEPT US BEFORE A SINGLE MESSAGE IS COUNTED AS SENT.
    #
    # Without this the worker published an entire capture into a closed socket and reported
    # success: `connect()` returns after the TCP handshake, the CONNACK arrives later on this loop,
    # and a QoS 0 publish to a refused connection is dropped locally with no error to catch. The
    # job finished, `messages_sent` matched the plan, and no telemetry existed.
    #
    # THE CREDENTIAL CHECK ABOVE CANNOT SEE THIS. It refuses a MISSING password; this is a WRONG
    # one, which is what a re-minted credential leaves behind until the worker is restarted -- the
    # ordinary way of rotating one, and how this was found.
    #
    # rc 4 and 5 are the two that mean the password: 4 is bad username/password, 5 is not
    # authorised. They are named rather than lumped in, because they are the ones an operator fixes
    # by rotating MQTT_PLAYBACK_CREDENTIALS and restarting rather than by looking at the broker.
    deadline = time.monotonic() + CONNACK_TIMEOUT_SECONDS
    while not client.acs_connack and time.monotonic() < deadline:
        time.sleep(0.05)

    if not client.acs_connack:
        client.loop_stop()
        return 0, (
            "the broker never answered the connection as %s within %ss. It is reachable at %s:%s "
            "or this would have failed above, so it accepted the socket and said nothing."
            % (edge_node, CONNACK_TIMEOUT_SECONDS, MQTT_HOST, MQTT_PORT)
        )

    rc = client.acs_connack[0]
    if rc != 0:
        client.loop_stop()
        detail = {
            4: "the broker rejected the username or password",
            5: "the broker refused this connection as not authorised",
        }.get(rc, "the broker refused the connection")
        return 0, (
            "%s for %s (CONNACK rc=%s). If this gateway's credential was re-minted, the worker is "
            "still holding the previous one: update MQTT_PLAYBACK_CREDENTIALS and recreate the "
            "playback container." % (detail, edge_node, rc)
        )

    sent = 0
    started = time.monotonic()
    last_report = 0.0
    error = None

    try:
        for delay_ms, topic, payload_bytes, _ in plan:
            # THE SCHEDULE IS ABSOLUTE, not a sleep between messages. Accumulating per-message
            # sleeps would drift by however long each publish and each progress call took, and an
            # hour-long playback would finish measurably late with its timestamps -- rebased against
            # the plan's clock, not the drifted one -- pulling further out of window as it went.
            target = started + (delay_ms / 1000.0)
            now = time.monotonic()
            if target > now:
                time.sleep(target - now)

            # QoS 0, matching what the fleet publishes and what capture.py play uses. Worth knowing
            # rather than assuming: a publish the ACL refuses is dropped WITHOUT a PUBACK, so the
            # broker's refusal is invisible here. That is what the credential check above is for.
            client.publish(topic, payload_bytes, qos=0, retain=False)
            sent += 1

            elapsed = time.monotonic() - started
            if elapsed - last_report >= PROGRESS_INTERVAL_SECONDS:
                last_report = elapsed
                try:
                    stop = supabase.rpc("playback_progress", {
                        "p_job_id": job_id,
                        "p_messages_sent": sent,
                        "p_messages_total": len(plan),
                        "p_elapsed_seconds": int(elapsed),
                    }).execute()
                    if stop.data is True:
                        logger.info("Playback %s: stopped by the operator after %d message(s).",
                                    job_id, sent)
                        break
                except Exception as err:
                    # Transient and survivable: a progress tick that cannot reach Supabase means the
                    # card stops moving, not that the playback should be abandoned.
                    logger.warning("Playback %s: progress update failed: %s", job_id, err)
    except Exception as err:
        error = "publishing stopped after %d message(s): %s" % (sent, err)
    finally:
        client.loop_stop()
        try:
            client.disconnect()
        except Exception:
            pass

    return sent, error


def main():
    if not SUPABASE_PLAYBACK_KEY:
        logger.critical(
            "CRITICAL CONFIGURATION ERROR: SUPABASE_PLAYBACK_KEY is not set. This worker "
            "authenticates as Service_Playback (archived migration 0056) and every gate it calls checks "
            "that the caller IS that principal, so without this key it can claim nothing and would "
            "sit polling an empty queue forever while looking healthy. Run `npm run setup`, or "
            "copy the key from .env.example for a demonstration stack."
        )
        raise SystemExit(1)

    supabase = _supabase()
    storage = _storage()
    credentials = _credentials()

    if not credentials:
        # NOT FATAL, deliberately, and the difference from the key above is worth stating. A worker
        # with no Supabase key cannot do anything at all. A worker with no broker credentials is
        # correctly configured for a stack that has not issued any playback targets yet -- it should
        # come up, report the queue is unreachable to it, and start working the moment one is added.
        logger.warning(
            "No playback credentials configured (MQTT_PLAYBACK_CREDENTIALS / MQTT_PLAYBACK_USER), "
            "so every job will be refused for want of an identity to publish as. Issue a broker "
            "credential for a simulated gateway and give it to this worker."
        )
    else:
        logger.info("Playback worker holds credentials for %d gateway(s): %s",
                    len(credentials), ", ".join(sorted(credentials)))

    # SWEEP FIRST. A row left at RUNNING keeps matching the per-target unique index, so every future
    # playback onto that gateway is refused -- and `is_active_playback_capture()` keeps returning
    # true for its capture, leaving this worker a standing read of one object in the bucket for as
    # long as the row survives.
    try:
        swept = supabase.rpc("playback_reconcile_jobs", {}).execute().data or 0
        if swept:
            logger.warning(
                "%d playback job(s) were left in flight by a previous run and have been failed. "
                "Whatever they had published is already in the historian.", swept,
            )
    except Exception as err:
        logger.error("Startup reconciliation failed: %s", err)

    logger.info(
        "Playback worker running: polling every %.0fs, publishing to %s:%d.",
        POLL_INTERVAL_SECONDS, MQTT_HOST, MQTT_PORT,
    )

    last_report = 0.0

    while True:
        # ------------------------------------------------------------------------------------
        # Say what this worker can publish as.
        # ------------------------------------------------------------------------------------
        # THE ONLY THING THAT KNOWS. `gateway_has_broker_credential()` answers whether the PLATFORM
        # issued a credential; nothing in the database can answer whether this process was given
        # the password. Without this the playback dialog showed a target as ready and the job then
        # failed with "this worker holds no broker credential for …" -- correct, and far too late
        # to be useful, because minting the credential and pasting it here are two separate acts.
        #
        # IN THE LOOP RATHER THAN ONCE AT STARTUP, because the page has to distinguish "holds
        # nothing" from "is not running", and only a repeating timestamp does that. Failure is
        # logged and otherwise ignored: a worker that cannot report is still a worker that can
        # play back, and refusing to work because the status row is unreachable would turn a
        # cosmetic outage into a real one.
        now = time.monotonic()
        if now - last_report >= CREDENTIAL_REPORT_INTERVAL_SECONDS:
            last_report = now
            try:
                supabase.rpc("playback_report_credentials", {
                    "p_edge_nodes": sorted(credentials.keys()),
                }).execute()
            except Exception as err:
                logger.warning("Could not report held credentials: %s", err)

        try:
            job = supabase.rpc("playback_claim_job", {}).execute().data
        except Exception as err:
            logger.warning("Could not ask for queued playbacks: %s", err)
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        if not job:
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        logger.info(
            "Playback %s started: %s onto %s at %sx, %d device mapping(s).",
            job["id"], job["capture_storage_path"], job["target_edge_node_id"],
            job.get("speed"), len(job.get("device_map") or {}),
        )
        try:
            sent, error = _run_job(supabase, storage, credentials, job)
        except Exception as err:
            logger.error("Playback %s: unhandled error: %s", job["id"], err, exc_info=True)
            sent, error = 0, "unhandled error: %s" % err

        try:
            supabase.rpc("playback_finish", {
                "p_job_id": job["id"], "p_messages_sent": sent, "p_error": error,
            }).execute()
        except Exception as err:
            # The job stays RUNNING, and the next restart's reconciliation is what clears it. Said
            # loudly because until then this gateway accepts no further playback.
            logger.error(
                "Playback %s finished but could not be recorded (%s). The row stays RUNNING and "
                "will block further playbacks onto %s until this worker restarts.",
                job["id"], err, job["target_edge_node_id"],
            )
            continue

        if error:
            logger.warning("Playback %s failed after %d message(s): %s", job["id"], sent, error)
        else:
            logger.info("Playback %s complete: %d message(s) published as %s.",
                        job["id"], sent, job["target_edge_node_id"])


if __name__ == "__main__":
    main()
