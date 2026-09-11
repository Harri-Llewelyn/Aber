"""
The ingestion daemon's counter and histogram registry.

Monotonic, never reset, behind one lock. Every increment sits at the site in ingestion.py that
made the decision, one-to-one with the log line beside it, so the counters and the log cannot
disagree about what happened. metrics.py renders a snapshot of this in Prometheus exposition
format; nothing here knows about Prometheus.
"""
import threading

# Monotonic, never reset, behind a lock. Incremented at the sites that already decide, so the
# counters and the log cannot disagree about what happened.
_counters = {}
_counters_lock = threading.Lock()

def count(name: str, n: int = 1):
    """Add to a monotonic counter. Unknown names are created on first use."""
    if n <= 0:
        return
    with _counters_lock:
        _counters[name] = _counters.get(name, 0) + n

def counter_snapshot() -> dict:
    """A copy of the counters, safe to read while the callback thread is writing."""
    with _counters_lock:
        return dict(_counters)

# Labelled counters, beside the flat ones. The only label is `edge_node`, one per gateway;
# labelling by device would be unbounded.
_labelled = {}

def count_labelled(name: str, labels: dict, n: int = 1):
    """Add to a monotonic counter carrying labels. Key order is normalised so it cannot split."""
    if n <= 0:
        return
    key = (name, tuple(sorted(labels.items())))
    with _counters_lock:
        _labelled[key] = _labelled.get(key, 0) + n

def labelled_snapshot() -> dict:
    with _counters_lock:
        return dict(_labelled)

# Historian write latency histogram. A distribution, not a mean: the interesting write is the
# slow one that stalls every other device behind it. Buckets cover a healthy local insert
# (sub-ms to a few ms), contention (tens to hundreds of ms) and the bounded reconnect: at or
# above 0.25s means DB_CONNECT_BACKOFF_SECONDS ran, so a reconnect stall is readable here.
WRITE_SECONDS_BUCKETS = (
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
)

# COUNTS PER BUCKET, NOT CUMULATIVE. Prometheus wants cumulative `le` buckets and metrics.py
# accumulates them at render time, because this list is written on the callback thread and read
# once per scrape: one increment per observation is the right trade against thirteen.
_write_seconds_buckets = [0] * len(WRITE_SECONDS_BUCKETS)
_write_seconds_sum = 0.0
_write_seconds_count = 0

def observe_write_seconds(seconds: float):
    """
    Record one committed historian write.

    Only committed writes are observed; a failed write has its own counter and its duration
    describes the failure, not capacity. Shares _counters_lock (re-entrant, held briefly).
    """
    global _write_seconds_sum, _write_seconds_count
    with _counters_lock:
        _write_seconds_count += 1
        _write_seconds_sum += seconds
        for i, upper in enumerate(WRITE_SECONDS_BUCKETS):
            if seconds <= upper:
                _write_seconds_buckets[i] += 1
                return
        # Above the last finite bucket. Nothing to increment -- +Inf is derived from the total at
        # render time, so an outlier is still counted in `_count` and still moves `_sum`.

# The UNS bridge's publish, timed the same way: it runs on the same callback thread after the
# commit, so its cost is part of the single-writer ceiling and belongs beside the write's.
_uns_seconds_buckets = [0] * len(WRITE_SECONDS_BUCKETS)
_uns_seconds_sum = 0.0
_uns_seconds_count = 0

def observe_uns_seconds(seconds: float):
    """Record one UNS republish pass for a message, published or skipped."""
    global _uns_seconds_sum, _uns_seconds_count
    with _counters_lock:
        _uns_seconds_count += 1
        _uns_seconds_sum += seconds
        for i, upper in enumerate(WRITE_SECONDS_BUCKETS):
            if seconds <= upper:
                _uns_seconds_buckets[i] += 1
                return

def histogram_snapshot() -> dict:
    """Histogram state, in the shape metrics.render_exposition() takes."""
    with _counters_lock:
        return {
            "acs_ingestion_write_seconds": {
                "buckets": tuple(zip(WRITE_SECONDS_BUCKETS, _write_seconds_buckets)),
                "sum": _write_seconds_sum,
                "count": _write_seconds_count,
            },
            "acs_ingestion_uns_publish_seconds": {
                "buckets": tuple(zip(WRITE_SECONDS_BUCKETS, _uns_seconds_buckets)),
                "sum": _uns_seconds_sum,
                "count": _uns_seconds_count,
            },
        }
