"""
The Sparkplug primary host application's STATE birth and death certificate.

Sparkplug gives a host application one way to tell every edge node on the broker whether it is
still consuming: a retained message on `spBv1.0/STATE/<host_id>` carrying `online: true`, and a
Last Will carrying `online: false` that the broker publishes on its behalf when the connection
dies. An edge node watches that topic and decides for itself whether to keep publishing, buffer,
or re-birth when the host returns.

WHY IT MATTERS HERE AND NOT ONLY IN THE ABSTRACT. The daemon already compensates for a host that
vanishes with machinery of its own -- the rebirth poller, the device watchdog, the stale sweep --
and those work. They only work for devices that behave the way this stack expects. A compliant
third-party gateway, which is the whole point of docs/remote-gateways.md and the enrolment path,
watches STATE instead. Without a publisher it watches a permanently empty topic and falls back to
whatever its vendor chose. The broker's roles have granted every gateway read on this subtree from
the beginning (mosquitto/dynsec-roles.json), so the promise was already made; this keeps it.

THERE IS NO ENABLE FLAG, unlike the Directory and UNS bridges. Those are off by default because
they publish the plant's address space and its readings, so switching them on is an exposure
decision. This publishes two booleans on a topic every gateway can already read, and a stack that
did not publish it would leave the ACL's promise unkept on a default install.

`PRIMARY_HOST_ID` HAS NO DEFAULT. The host id is the contract every third-party gateway is
configured against -- it goes in the vendor's own configuration screen, not in ours -- so a stack
inheriting a word nobody chose is worse than one that refuses to start. The chart fails the render
when it is unset (deploy/helm/aber/templates/apps/ingestion.yaml), so the ordinary way to meet
this is a `helm upgrade` that stops before anything restarts.

THIS DAEMON IS THE SINGLE PRIMARY HOST. i3X is a read-side adapter over what the historian already
holds; its role publishes nothing, and a gateway that kept publishing while i3X was down would lose
nothing by doing so. The playback worker cannot announce itself either -- it authenticates AS the
gateway it replays (playback_worker.py), so it holds the shared `gateway` role, which grants read
on this subtree and no write anywhere in it.

QoS 1 AND RETAINED, which is the one place this daemon departs from the QoS 0 it uses everywhere
else. A gateway connecting later must learn the current state immediately rather than waiting for
a transition it already missed, and that is what retain is for.
"""
import json
import os
import time

from logging_config import get_logger

logger = get_logger("ingestion")

# -------------------------------------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------------------------------------
# NO DEFAULT. See the header: an unset host id is refused, not guessed.
PRIMARY_HOST_ID = os.getenv("PRIMARY_HOST_ID", "").strip()

# The subtree the broker's `gateway` role grants read on. A host id carrying `/`, `+` or `#` would
# publish outside the single level the ACL grant and every subscriber assume.
_FORBIDDEN = ("/", "+", "#")


class PrimaryHostIdError(ValueError):
    """The configured host id cannot be used as one topic level."""


def state_topic(host_id=PRIMARY_HOST_ID):
    """The STATE topic for a host id, validated. Raises PrimaryHostIdError on an unusable one."""
    if not host_id:
        raise PrimaryHostIdError(
            "PRIMARY_HOST_ID is not set. It is the Sparkplug host id every gateway on this site "
            "watches to learn whether the historian is consuming, and it becomes part of each "
            "gateway's own configuration -- so it is named by the deployment rather than defaulted "
            "here. Set ingestion.primaryHostId in the chart's values."
        )
    bad = [c for c in _FORBIDDEN if c in host_id]
    if bad:
        raise PrimaryHostIdError(
            "PRIMARY_HOST_ID %r contains %s. The host id is ONE topic level: the broker grants the "
            "ingestion role write on exactly `spBv1.0/STATE/<host_id>`, so a value with a "
            "separator or a wildcard in it publishes where nothing is granted and is dropped "
            "silently at the broker." % (host_id, " and ".join(repr(c) for c in bad))
        )
    return "spBv1.0/STATE/%s" % host_id


def state_payload(online, timestamp_ms):
    """
    One STATE payload, serialised.

    JSON, not protobuf: STATE is the one Sparkplug message that is not a payload of metrics, and
    3.0.0 defines it as an object of exactly `online` and `timestamp`. The timestamp is UTC
    milliseconds since epoch.
    """
    return json.dumps({"online": bool(online), "timestamp": int(timestamp_ms)},
                      separators=(",", ":"))


def register_will(client, host_id=PRIMARY_HOST_ID, now_ms=None):
    """
    Register the death certificate as the connection's Last Will, and return its timestamp.

    MUST BE CALLED BEFORE connect(). paho applies the will when the CONNECT packet is built, so a
    will set afterwards is registered for a session that has not started and the broker publishes
    nothing when this one dies.

    THE RETURNED TIMESTAMP IS THE BIRTH'S TOO. Sparkplug 3.0.0 requires the birth and death
    certificates of one connection to carry the SAME timestamp, both being the time the connection
    was established, so that a subscriber can pair them. That is why this returns a value rather
    than each half taking its own clock reading.
    """
    topic = state_topic(host_id)
    timestamp_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    client.will_set(topic, payload=state_payload(False, timestamp_ms), qos=1, retain=True)
    logger.info(
        "Sparkplug primary host '%s': death certificate registered as the Last Will on %s. Every "
        "gateway granted read on spBv1.0/STATE/# learns within the keepalive if this daemon dies.",
        host_id, topic,
    )
    return timestamp_ms


def announce_online(client, timestamp_ms, host_id=PRIMARY_HOST_ID):
    """
    Publish the birth certificate. Called from on_connect, once the broker has accepted the session.

    `timestamp_ms` is the value register_will() returned for this connection -- see there.
    """
    topic = state_topic(host_id)
    client.publish(topic, payload=state_payload(True, timestamp_ms), qos=1, retain=True)
    logger.info("Sparkplug primary host '%s' is ONLINE (retained on %s).", host_id, topic)


def announce_offline(client, timestamp_ms, host_id=PRIMARY_HOST_ID):
    """
    Publish the death certificate on a shutdown this daemon asked for.

    SAYING IT OURSELVES IS THE POINT. The daemon's SIGTERM path ends in `os._exit(0)` and never
    sends a DISCONNECT, so the broker does in fact also fire the will -- measured on the dev
    cluster, where a rollout produces TWO `online: false` messages. They are byte-identical,
    timestamp included, because both come from the value registered at connect, so a subscriber
    sees one state repeated rather than two events.

    The duplicate is kept deliberately rather than suppressed with a `disconnect()` before exit. A
    DISCONNECT would make the broker discard the will, which is tidier only while the publish below
    succeeds; if it did not, the topic would be left saying `online: true` for as long as the
    daemon stayed down. A repeated death certificate costs nothing and an absent one is the whole
    fault this module exists to fix.

    What this buys over the will alone is ORDER: it goes out at the start of the shutdown, before
    the historian drain, so a gateway hears it then rather than up to
    TELEMETRY_SHUTDOWN_DRAIN_SECONDS later when the socket finally closes.

    Best effort and never raises: this runs on the signal path, where the telemetry already
    accepted is the thing worth protecting.
    """
    try:
        topic = state_topic(host_id)
        info = client.publish(topic, payload=state_payload(False, timestamp_ms), qos=1, retain=True)
        # QoS 1 is only delivered once the loop runs, and the loop is about to stop. A short wait,
        # not an unbounded one: a broker that has already gone is why this cannot raise.
        try:
            info.wait_for_publish(timeout=2)
        except (TypeError, ValueError):
            # paho 1.6.1's wait_for_publish takes no timeout on some builds; the publish is already
            # queued either way and the will covers the case where it never leaves.
            pass
        logger.info("Sparkplug primary host '%s' is OFFLINE (retained on %s).", host_id, topic)
    except Exception as e:  # noqa: BLE001 -- see the docstring
        logger.warning(
            "Could not publish the primary host death certificate on shutdown: %s. The broker's "
            "will covers an unclean exit, but a gateway may see this host as online until then.", e,
        )
