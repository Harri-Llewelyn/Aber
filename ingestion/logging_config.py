import os
import sys
import json
import logging
from datetime import datetime, timezone

# =============================================================================================
# WHY THERE ARE TWO FORMATTERS AND NOT ONE.
#
# The daemon's diagnostics were built as a PAIR: every `count("dropped_*")` sits beside a
# `logger.warning` at the same site, so "the counters and the log cannot disagree about what
# happened" (metrics.py). Prometheus holds one half. The half naming WHICH device, under WHICH
# edge node, and why lives only in the message text -- and text is what a log store cannot query.
#
# So the fields that matter are passed as `extra=` and rendered as FIELDS in JSON mode, rather
# than being formatted into the sentence and parsed back out with a regex forever.
#
# BOTH FORMATTERS RENDER THE SAME FIELDS, and that is the property to preserve when editing
# either. If text mode dropped the extras, a developer reading `docker logs` would see strictly
# less than the store holds, and would be debugging a different record from the one that was
# kept. The formats differ in syntax and in nothing else.
# =============================================================================================

# LogRecord's own attributes. Anything in a record's __dict__ beyond these arrived via `extra=`
# and is one of ours. Taken from a real record rather than from the CPython source, so a new
# attribute in a future version cannot silently start being logged as a caller's field.
_RESERVED = frozenset(
    logging.LogRecord("", 0, "", 0, "", None, None).__dict__
) | {"message", "asctime", "taskName"}


def _extras(record):
    """The fields a caller passed via `extra=`, in the order they were set."""
    return {k: v for k, v in record.__dict__.items() if k not in _RESERVED}


def _isoformat(created):
    return datetime.fromtimestamp(created, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class UTCFormatter(logging.Formatter):
    """Human-readable lines with ISO 8601 UTC timestamps, and any `extra=` fields appended.

    THE APPENDED FIELDS ARE NOT DECORATION. They are the same keys JSON mode emits, so the two
    modes describe the same event and a developer can read locally what the store will hold.
    """

    def formatTime(self, record, datefmt=None):
        dt = datetime.fromtimestamp(record.created, tz=timezone.utc)
        if datefmt:
            return dt.strftime(datefmt)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    # `formatMessage`, NOT `format`. Appending in `format` puts the fields AFTER the traceback,
    # where they read as the last line of the exception rather than as fields of the record.
    def formatMessage(self, record):
        line = super().formatMessage(record)
        extras = _extras(record)
        if extras:
            line = f"{line} [{' '.join(f'{k}={v}' for k, v in extras.items())}]"
        return line


class JSONFormatter(logging.Formatter):
    """One JSON object per line, with `extra=` fields promoted to top level.

    TOP LEVEL, NOT NESTED UNDER `fields`. A label-based store indexes what it can reach cheaply,
    and `reason` is the key every drop query starts from -- burying it one level down makes the
    common query the awkward one for no gain.

    A CALLER CANNOT OVERWRITE `ts`, `level`, `logger` OR `msg`. `extra=` with one of those names
    raises inside logging itself (it refuses to shadow a LogRecord attribute) for `msg`, but
    `ts` and `level` are ours rather than logging's -- so the envelope is written LAST and a
    collision loses to it. A log line whose `level` says something other than the level it was
    emitted at is worse than a lost field.
    """

    def format(self, record):
        payload = _extras(record)
        payload.update({
            "ts": _isoformat(record.created),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        })
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)
        # `default=str` rather than a failure: a field that cannot be serialised must not be able
        # to take down the daemon that was trying to report a fault.
        return json.dumps(payload, default=str)


def get_logger(service_name: str) -> logging.Logger:
    """
    Configures and returns a logger for the specified service.

    Log level is controlled via the LOG_LEVEL environment variable (default: INFO).

    LOG_FORMAT selects the rendering: `text` (default) or `json`.

    THE CODE DEFAULT IS TEXT AND THE DEPLOYMENTS SET JSON, which is deliberate and is not the same
    as "the default is json". Someone running `python ingestion.py` against a local stack is
    reading with their eyes and wants prose; a daemon writing into a log store is being read by a
    query and wants fields. So `docker-compose.yml` and the chart both set `LOG_FORMAT=json` on
    ingestion and playback -- both targets, so the daemon behaves identically on each and no
    divergence row is owed -- and this default serves the case neither of them covers.

    An unrecognised value is text, because a typo in an env var must not silently stop the logs
    being readable.
    """
    log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
    log_level = getattr(logging, log_level_str, logging.INFO)

    logger = logging.getLogger(service_name)
    logger.setLevel(log_level)

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(log_level)
        if os.getenv("LOG_FORMAT", "text").strip().lower() == "json":
            handler.setFormatter(JSONFormatter())
        else:
            handler.setFormatter(UTCFormatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
        logger.addHandler(handler)

    logger.propagate = False
    return logger
