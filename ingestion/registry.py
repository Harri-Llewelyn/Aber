"""
The ingestion daemon's counters, histograms and scrape-time series.

WHAT IS OURS AND WHAT IS UPSTREAM'S. `prometheus_client` owns the registry, the exposition format
and the histogram arithmetic. This module owns the thing that is actually ours: the flat counter
names in `ingestion.py` -- `count("dropped_gateway_binding")` -- sit at the site that already made
the decision, one-to-one with the `logger.warning` beside them, so the counters and the log cannot
disagree about what happened. `metrics.COUNTER_MAP` declares what each flat name is published as,
and this module builds the metric objects from that declaration.

So a new drop reason is still a `count("dropped_x")` at the site plus a line in COUNTER_MAP, and
`test_metrics_endpoint.py` still fails if the second is missing. Nothing on the hot path changed
shape; what went is the 400 lines that rendered the text.

THE FLAT NAMES ARE STILL READABLE BACK, because the STATS log line reports by them
(`dropped_gateway_binding=+3(12)`) for whoever is reading logs with no Prometheus to hand.
`counter_snapshot()` reverses the declaration rather than keeping a second tally, so there remains
exactly one place a counter lives.
"""
import threading

import prometheus_client
from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
from prometheus_client.core import CounterMetricFamily, GaugeMetricFamily

from metrics import COUNTER_MAP, EXPORTED_LABELLED_INSTEAD, HELP, TYPES

# NO `_created` SERIES. prometheus_client emits a `<name>_created` gauge beside every counter and
# histogram by default, carrying the unix time the series was first observed. Nothing in this stack
# reads one: no dashboard, no alert rule, and the daemon's own restart time is already
# `acs_ingestion_up`. They would roughly double the line count of the exposition for a fleet's worth
# of `edge_node` label values, on an endpoint whose whole content is a deliberate decision.
prometheus_client.disable_created_metrics()

# Historian write latency histogram. A distribution, not a mean: the interesting write is the slow
# one that stalls every other device behind it. Buckets cover a healthy local insert (sub-ms to a
# few ms), contention (tens to hundreds of ms) and the bounded reconnect: at or above 0.25s means
# DB_CONNECT_BACKOFF_SECONDS ran, so a reconnect stall is readable off the top three buckets.
#
# PASSED EXPLICITLY AND NEVER INHERITED. prometheus_client's defaults are a web-request ladder
# (.005 to 10 with nothing below 5ms), which would put every healthy write of this daemon in the
# first bucket and answer every quantile with the same number.
WRITE_SECONDS_BUCKETS = (
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
)

HISTOGRAMS = {
    "acs_ingestion_write_seconds": "One historian transaction, committed.",
    "acs_ingestion_uns_publish_seconds": "One UNS republish pass for a message.",
}

# The catch-all for a flat name with no mapping. NAMED, NOT DISCARDED: a counter added to
# ingestion.py without a line in COUNTER_MAP would otherwise vanish from monitoring with nothing to
# indicate it ever existed.
UNMAPPED = "acs_ingestion_unmapped_counter_total"

# Everything below is rebuilt by reset(); the module-level names are bound there so the daemon and
# the suites take the same path.
REGISTRY = None
_by_metric = {}          # prometheus metric name -> Counter, for COUNTER_MAP's families
_labelled = {}           # (metric, labelnames) -> Counter, created on first use
_labelled_lock = threading.Lock()
_histograms = {}         # metric -> Histogram
_scrape_time = None      # the _ScrapeTimeCollector instance


def _families():
    """
    COUNTER_MAP grouped into one Prometheus family per metric name, with its label names.

    REFUSES A FAMILY WHOSE LABEL SET DISAGREES BETWEEN FLAT NAMES. prometheus_client fixes the
    label names when the metric is created, so two flat names publishing the same metric with
    different dimensions cannot both be right -- and the failure without this check is a
    ValueError from deep inside a `.labels()` call on whichever one happened to run second.
    """
    families = {}
    for flat, (metric, labels) in COUNTER_MAP.items():
        names = tuple(sorted(labels))
        if metric in families and families[metric] != names:
            raise ValueError(
                f"COUNTER_MAP publishes {metric} with two different label sets "
                f"({families[metric]} and {names}); a Prometheus metric has one"
            )
        if TYPES.get(metric, "counter") != "counter":
            raise ValueError(
                f"COUNTER_MAP publishes {metric}, which TYPES calls a "
                f"{TYPES[metric]}. A flat count() is monotonic, so it can only be a counter; a "
                f"gauge belongs in the scrape-time source"
            )
        families[metric] = names
    return families


def _help(metric: str) -> str:
    """
    HELP for a declared metric, REQUIRED rather than defaulted.

    A metric rendering with its own name as its help text is worse than one with none: a reader
    meeting it in Grafana has nothing to go on and no sign that anything is missing. Declared
    metrics are built at import, so this is a startup failure -- the scrape-time collector is
    lenient instead, because a new gauge must not be able to 500 a live scrape.
    """
    try:
        return HELP[metric]
    except KeyError:
        raise ValueError(f"{metric} has no HELP text in metrics.py; add one beside its name")             from None


def reset():
    """
    A registry with every declared metric present and at zero.

    Called once at import, and by the suites between tests. A prometheus_client counter cannot be
    decremented, so a fresh registry is the only way back to zero -- which is also why this is
    public rather than a `_counters.clear()` reached into from outside.
    """
    global REGISTRY, _by_metric, _labelled, _histograms, _scrape_time
    REGISTRY = CollectorRegistry()
    _by_metric = {}
    _labelled = {}
    _histograms = {}

    for metric, labelnames in _families().items():
        _by_metric[metric] = Counter(metric, _help(metric), labelnames, registry=REGISTRY)

    # EVERY SERIES COUNTER_MAP DECLARES IS PRESENT AT ZERO FROM STARTUP, not from its first event.
    # prometheus_client does this for an unlabelled counter on its own; a labelled one appears only
    # when `.labels()` is first called, which would leave half the exposition initialised and half
    # not. Initialising both is also what makes `rate()` see the step from no drops to some: a
    # counter whose series springs into existence at 1 has no previous sample to compare against,
    # and a dashboard shows "No data" where the honest answer is zero.
    for flat, (metric, labels) in COUNTER_MAP.items():
        if labels:
            _by_metric[metric].labels(**labels)

    # `messages_<type>` is written per message type by ingestion.py already, so the msg_type
    # dimension costs nothing at the call site -- it is derived from a convention that was there
    # first. Declared here rather than in COUNTER_MAP because the label VALUES are open: a new
    # Sparkplug message type needs no table entry.
    _by_metric["acs_ingestion_messages_total"] = Counter(
        "acs_ingestion_messages_total", _help("acs_ingestion_messages_total"), ["msg_type"],
        registry=REGISTRY)

    _by_metric[UNMAPPED] = Counter(UNMAPPED, _help(UNMAPPED), ["counter"], registry=REGISTRY)

    for metric in HISTOGRAMS:
        _histograms[metric] = Histogram(metric, _help(metric),
                                        buckets=WRITE_SECONDS_BUCKETS, registry=REGISTRY)

    _scrape_time = _ScrapeTimeCollector()
    REGISTRY.register(_scrape_time)


# ---------------------------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------------------------
def count(name: str, n: int = 1):
    """
    Add to a monotonic counter, by the flat name the call site uses.

    An unknown name lands under the catch-all rather than raising: a counter is a report about
    something that already happened, and the daemon must not fail on the way to filing one.

    THE ORDER OF THE BRANCHES BELOW IS LOAD-BEARING. `messages_total` is both a `messages_` name and
    an EXPORTED_LABELLED_INSTEAD one; tested the other way round it would publish as
    acs_ingestion_messages_total{msg_type="total"}, which double-counts every message against the
    per-type series it is the sum of.
    """
    if n <= 0:
        return
    if name in EXPORTED_LABELLED_INSTEAD:
        # Kept by the labelled series it names, and summed back by counter_snapshot(). Counting it
        # here as well would give a scraper two ways to count one event.
        return
    if name.startswith("messages_"):
        _by_metric["acs_ingestion_messages_total"].labels(
            msg_type=name[len("messages_"):]).inc(n)
        return
    mapped = COUNTER_MAP.get(name)
    if mapped is None:
        _by_metric[UNMAPPED].labels(counter=name).inc(n)
        return
    metric, labels = mapped
    family = _by_metric[metric]
    (family.labels(**labels) if labels else family).inc(n)


def count_labelled(name: str, labels: dict, n: int = 1):
    """
    Add to a monotonic counter carrying labels, named as it is published.

    The family is created on first use because the label NAMES are fixed at creation and the call
    sites are the only declaration of them. Key order is normalised so one metric cannot split
    into two families on the order a caller happened to write.
    """
    if n <= 0:
        return
    labelnames = tuple(sorted(labels))
    key = (name, labelnames)
    family = _labelled.get(key)
    if family is None:
        with _labelled_lock:
            # Re-checked under the lock: two callback threads reaching a new edge node at once
            # would otherwise both create the family and the second would raise Duplicated.
            family = _labelled.get(key)
            if family is None:
                family = Counter(name, HELP.get(name, name), labelnames, registry=REGISTRY)
                _labelled[key] = family
    family.labels(**labels).inc(n)


def observe_write_seconds(seconds: float):
    """
    Record one committed historian write.

    Only committed writes are observed; a failed write has its own counter and its duration
    describes the failure, not capacity.
    """
    _histograms["acs_ingestion_write_seconds"].observe(seconds)


def observe_uns_seconds(seconds: float):
    """
    Record one UNS republish pass for a message, published or skipped.

    It runs on the same writer thread after the commit, so its cost is part of the single-writer
    ceiling and belongs beside the write's.
    """
    _histograms["acs_ingestion_uns_publish_seconds"].observe(seconds)


# ---------------------------------------------------------------------------------------------
# Series read when a scrape arrives
# ---------------------------------------------------------------------------------------------
class _ScrapeTimeCollector:
    """
    States rather than events: cache occupancy, the connection flags, the queue depth, and each
    appliance's last-reported health and clock offset.

    READ WHEN THE SCRAPE ARRIVES, not written when something happens, which is why they are a
    collector and not Gauge objects the daemon sets. The daemon already holds each of these as its
    own state; mirroring them into gauge objects would be a second copy that can disagree.
    """

    def __init__(self):
        self.source = lambda: {}

    def collect(self):
        families = {}
        shapes = {}
        for (metric, label_items), value in sorted(self.source().items()):
            labelnames = tuple(k for k, _ in label_items)
            if metric in _by_metric or metric in _histograms:
                # Two families of one name is a repeated HELP/TYPE pair, which is a parse error in
                # a strict scraper and silently drops series in a lenient one -- so it would cost
                # the whole scrape, not just this series.
                raise ValueError(
                    f"{metric} is both recorded and read at scrape time; it can only be one")
            if metric in shapes and shapes[metric] != labelnames:
                # add_metric() zips values onto the family's label names, so a second shape would
                # be mislabelled rather than refused -- a series that looks right and is not.
                raise ValueError(
                    f"{metric} is produced with two different label sets "
                    f"({shapes[metric]} and {labelnames}); a Prometheus metric has one")
            family = families.get(metric)
            if family is None:
                kind = (GaugeMetricFamily if TYPES.get(metric, "counter") == "gauge"
                        else CounterMetricFamily)
                # HELP is lenient here and strict for a declared metric: raising inside a collector
                # answers a live scrape with 500, and a new gauge must not be able to do that.
                family = kind(metric, HELP.get(metric, metric), labels=labelnames)
                families[metric] = family
                shapes[metric] = labelnames
            family.add_metric([v for _, v in label_items], value)
        return list(families.values())


def set_scrape_time_source(source):
    """`source()` returns {(metric, ((label, value), ...)): value}, read once per scrape."""
    _scrape_time.source = source


def render() -> str:
    """The exposition, for the HTTP handler in metrics.py."""
    return generate_latest(REGISTRY).decode("utf-8")


# ---------------------------------------------------------------------------------------------
# Reading back
# ---------------------------------------------------------------------------------------------
def counter_snapshot() -> dict:
    """
    The counters under the FLAT names the call sites use, for the STATS log line.

    Reversed out of the declaration rather than tallied separately, so there is one place a
    counter lives. Only the recorded counters are walked -- not REGISTRY.collect() -- so reading
    this never runs the scrape-time collector.
    """
    reverse = {
        (metric, tuple(sorted(labels.items()))): flat
        for flat, (metric, labels) in COUNTER_MAP.items()
    }
    out = {}
    for metric, family in list(_by_metric.items()):
        for sample in _samples(family):
            if metric == "acs_ingestion_messages_total":
                out[f"messages_{sample.labels['msg_type']}"] = int(sample.value)
            elif metric == UNMAPPED:
                out[sample.labels["counter"]] = int(sample.value)
            else:
                flat = reverse.get((metric, tuple(sorted(sample.labels.items()))))
                if flat:
                    out[flat] = int(sample.value)

    # The two names that are kept by a labelled series instead of a flat one. Summing them back is
    # what makes the STATS line complete while the exposition stays free of a double count; the
    # table says which series each comes from.
    for flat, (source, _why) in EXPORTED_LABELLED_INSTEAD.items():
        total = sum(
            sample.value
            for family in _families_named(source)
            for sample in _samples(family)
        )
        if total:
            out[flat] = int(total)
    return out


def labelled_snapshot() -> dict:
    """The labelled counters, keyed as the call sites name them."""
    out = {}
    for (metric, _labelnames), family in list(_labelled.items()):
        for sample in _samples(family):
            out[(metric, tuple(sorted(sample.labels.items())))] = int(sample.value)
    return out


def histogram_snapshot() -> dict:
    """Bucket counts, sum and count per histogram. Buckets are CUMULATIVE, as exposed."""
    out = {}
    for metric, family in _histograms.items():
        buckets, total, observations = [], 0.0, 0
        for sample in _samples(family):
            if sample.name.endswith("_bucket"):
                buckets.append((float(sample.labels["le"]), sample.value))
            elif sample.name.endswith("_sum"):
                total = sample.value
            elif sample.name.endswith("_count"):
                observations = int(sample.value)
        out[metric] = {"buckets": tuple(buckets), "sum": total, "count": observations}
    return out


def _samples(family):
    for collected in family.collect():
        for sample in collected.samples:
            yield sample


def _families_named(metric):
    """Every recorded family publishing `metric`, flat or labelled."""
    if metric in _by_metric:
        yield _by_metric[metric]
    for (name, _labelnames), family in list(_labelled.items()):
        if name == metric:
            yield family


reset()
