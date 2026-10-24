"""
i3X 1.0 subscription engine -- sync (MUST), streaming (MAY), TTL and overflow.

DELIBERATELY FREE OF HTTP AND MQTT. Everything here is a pure state machine over an injected clock,
which is what lets the spec's timing rules -- queue overflow, TTL expiry, sequence-number
acknowledgement -- be tested without sleeping and without a broker. `i3x_service.py` owns the
transport; this owns the semantics.

THE RULES THIS ENFORCES, all from the Implementation Guide's Subscribe Methods, each of which fails
quietly when got wrong (README.md -> "Subscriptions" says how):

  1. `/sync` MUST NOT clear the queue when `lastSequenceNumber` is omitted or invalid, MUST clear
     everything at or below it when valid, and MUST clear the WHOLE queue for the sentinel `-1`.
  2. Overflow is reported, not hidden: the OLDEST batches drop and the next `/sync` answers 206, so
     a client can compute the gap and backfill from history. A queue overflows at its batch count,
     or when the bytes queued for its principal, or on the whole server, pass their ceiling. A
     dropped batch a sync had already returned is reported only if the next `/sync` does not
     acknowledge it.
  3. ONE stream per subscription. Opening a second MUST close the first, cleanly and with no error.
  4. Sync and stream are mutually exclusive: `/sync` MUST error while a stream is open, because the
     stream has already delivered -- and discarded -- the queue the sync caller is acknowledging.
  5. An Object registered more than once MUST succeed and the repeat is ignored, so the first
     registration's `maxDepth` stands.

Sequence numbers are 64-bit unsigned and never reused within a subscription. What an update reaches
follows `maxDepth` through composition, which is read from the elementId (`receives`).

What the owner may see is the transport's to decide; `withdraw()` applies its verdict, dropping the
elements and queued updates it rejects and holding their ids until a `/sync` reports them
(README.md -> "Security").
"""
from __future__ import annotations

import secrets
import sys
import threading
import time
from collections import OrderedDict, deque
from typing import Callable, Dict, Iterable, List, Optional

# The spec fixes no numbers here; these are this server's declared limits and both are reported to
# the client when they bite -- the queue depth in the 206 detail, the TTL by a 404 on a reaped
# subscription.
DEFAULT_QUEUE_LIMIT = 500
DEFAULT_TTL_SECONDS = 300
# Past these, create and stream answer 429 naming the limit. An open stream holds a server thread.
DEFAULT_MAX_PER_PRINCIPAL = 20
DEFAULT_MAX_SUBSCRIPTIONS = 500
DEFAULT_MAX_STREAMS = 50
# The most bytes the queues may hold for one principal and on the whole server, by `batch_bytes`.
# Past one, the largest queue it covers drops its oldest batches (rule 2). README.md -> "Memory".
MIB = 1 << 20
DEFAULT_MAX_QUEUED_BYTES_PER_PRINCIPAL = 32 * MIB
DEFAULT_MAX_QUEUED_BYTES = 128 * MIB

# What a queued batch and each update in it hold beyond the update's value and strings: the batch
# dict, its list and sequence number, and the per-subscription copy of the update. Measured with
# tracemalloc on CPython 3.13 (README.md -> "Memory"), and rounded up.
BATCH_OVERHEAD_BYTES = 640
UPDATE_OVERHEAD_BYTES = 200
_sizeof = sys.getsizeof


def update_bytes(update: dict) -> int:
    """
    The estimated bytes one queued update holds: UPDATE_OVERHEAD_BYTES, its two strings, and its
    value, a map counted with each value in it. One shallow pass, since the values are scalars. A
    value or string several queues share is counted in each.
    """
    value = update.get("value")
    size = (UPDATE_OVERHEAD_BYTES + _sizeof(value) + _sizeof(update.get("timestamp"))
            + _sizeof(update.get("elementId")))
    if isinstance(value, dict):
        size += sum(map(_sizeof, value.values()))
    return size


def batch_bytes(updates: Iterable[dict]) -> int:
    return BATCH_OVERHEAD_BYTES + sum(map(update_bytes, updates))


# 2**64 - 1. Sequence numbers MUST be 64-bit unsigned; a subscription that somehow reached this
# would wrap into reuse, so it is refused instead.
MAX_SEQUENCE_NUMBER = (1 << 64) - 1


class SubscriptionError(Exception):
    """Raised for conditions that map onto a specific HTTP status."""

    def __init__(self, status: int, title: str, detail: str):
        super().__init__(detail)
        self.status = status
        self.title = title
        self.detail = detail


def composition_parent(element_id: str) -> Optional[str]:
    """
    The object `element_id` is a component of, read from the id alone. A metric
    `<sparkplug_id>/<name>` is its device's, split at the first `/` since a sparkplug_id never
    contains one. Nothing else is a component: locations and gateways never compose.
    """
    device, sep, _ = element_id.partition("/")
    return device if sep and device else None


def receives(monitored: Dict[str, int], element_id: str) -> bool:
    """
    Whether a subscription monitoring `monitored` (elementId -> maxDepth) receives an update for
    `element_id`: it registered that object, at any depth, or the object it is a component of at a
    maxDepth that descends one level, which is 0 (unbounded) or 2 or more.
    """
    if element_id in monitored:
        return True
    parent = composition_parent(element_id)
    depth = monitored.get(parent) if parent else None
    return depth is not None and (depth == 0 or depth >= 2)


class Subscription:
    """One client's subscription: its monitored set, its queue, and its stream (if any)."""

    def __init__(
        self,
        subscription_id: str,
        client_id: str,
        display_name: str,
        now: float,
        principal: str = "",
    ):
        self.subscription_id = subscription_id
        self.client_id = client_id
        self.display_name = display_name
        # Who created it: the token's `sub`. Ownership is this AND the clientId.
        self.principal = principal
        # elementId -> the maxDepth of its first registration. Ordered so `/subscriptions/list`
        # reports registrations in the order they were made.
        self.monitored: "OrderedDict[str, int]" = OrderedDict()
        self.batches: "deque[dict]" = deque()
        # Each queued batch's `batch_bytes`, in step with `batches`, and their sum. Only the
        # registry's `_put`, `_take` and `_set_queue` change the three, so the totals stay true.
        self.sizes: "deque[int]" = deque()
        self.queued_bytes = 0
        self.next_seq = 1
        self.stream_open = False
        # Bumped on every create/sync/stream/register. The reaper reads only this.
        self.last_activity = now
        # Set when a dropped batch is a loss to the client (`_drop_oldest`), cleared once the client
        # has been told via a 206.
        self.overflowed = False
        # The highest sequence number a sync has returned, and the highest of those dropped since
        # the last sync (0 for none), which the next sync's acknowledgement settles.
        self.sent_seq = 0
        self.dropped_sent_seq = 0
        # Elements withdrawn because the owner can no longer see them, in the order found, held
        # until a `/sync` names them in its 206.
        self.withdrawn: "OrderedDict[str, None]" = OrderedDict()

    def to_json(self) -> dict:
        return {
            "subscriptionId": self.subscription_id,
            "displayName": self.display_name,
            "monitoredObjects": [
                {"elementId": eid, "maxDepth": depth} for eid, depth in self.monitored.items()
            ],
        }


class SubscriptionRegistry:
    """
    All subscriptions on this server.

    Thread-safe: the MQTT consumer stages batches from its own thread while HTTP handler threads
    sync, register and stream. One re-entrant lock guards the whole registry rather than one per
    subscription -- the critical sections are microseconds of dict work, and a per-subscription lock
    would still need a registry lock to find the subscription, which is the deadlock this avoids.
    """

    def __init__(
        self,
        queue_limit: int = DEFAULT_QUEUE_LIMIT,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        max_per_principal: int = DEFAULT_MAX_PER_PRINCIPAL,
        max_subscriptions: int = DEFAULT_MAX_SUBSCRIPTIONS,
        max_streams: int = DEFAULT_MAX_STREAMS,
        max_queued_bytes_per_principal: int = DEFAULT_MAX_QUEUED_BYTES_PER_PRINCIPAL,
        max_queued_bytes: int = DEFAULT_MAX_QUEUED_BYTES,
    ):
        self.queue_limit = queue_limit
        self.ttl_seconds = ttl_seconds
        self.max_per_principal = max_per_principal
        self.max_subscriptions = max_subscriptions
        self.max_streams = max_streams
        self.max_queued_bytes_per_principal = max_queued_bytes_per_principal
        self.max_queued_bytes = max_queued_bytes
        self._clock = clock
        self._lock = threading.RLock()
        self._subs: Dict[str, Subscription] = {}
        # principal -> its subscriptions by id, and the bytes they queue; the server's total.
        self._by_principal: Dict[str, Dict[str, Subscription]] = {}
        self._principal_bytes: Dict[str, int] = {}
        self._queued_bytes = 0
        # Called with the Subscription when a stream must be closed because another was opened, or
        # because the subscription was deleted or reaped. The transport owns what "close" means.
        self.on_stream_close: Optional[Callable[[Subscription], None]] = None

    # -- lifecycle ---------------------------------------------------------------------------

    def create(
        self, client_id: str, display_name: str = "", *, principal: str = ""
    ) -> Subscription:
        # "SHOULD be reasonably complex and difficult for other clients to guess" -- 256 bits from
        # secrets, not uuid4 and not anything derived from the clientId.
        sub = Subscription(
            secrets.token_urlsafe(32), client_id, display_name, self._clock(), principal
        )
        with self._lock:
            held = len(self._by_principal.get(principal, ()))
            if held >= self.max_per_principal:
                raise SubscriptionError(
                    429,
                    "Too Many Requests",
                    f"This principal already holds {held} subscriptions, the per-principal limit "
                    f"(I3X_MAX_SUBSCRIPTIONS_PER_PRINCIPAL). Delete one it no longer needs; an "
                    f"idle one expires after {self.ttl_seconds} s.",
                )
            if len(self._subs) >= self.max_subscriptions:
                raise SubscriptionError(
                    429,
                    "Too Many Requests",
                    f"This server already holds {len(self._subs)} subscriptions, its limit "
                    f"(I3X_MAX_SUBSCRIPTIONS). Retry after idle ones expire "
                    f"({self.ttl_seconds} s without a sync or stream).",
                )
            self._subs[sub.subscription_id] = sub
            self._by_principal.setdefault(principal, {})[sub.subscription_id] = sub
        return sub

    def _remove(self, sub: Subscription) -> None:
        """Forget a subscription and release what it queued. Its handler may still hold it."""
        self._set_queue(sub, deque(), deque())
        del self._subs[sub.subscription_id]
        owned = self._by_principal.get(sub.principal, {})
        owned.pop(sub.subscription_id, None)
        if not owned:
            self._by_principal.pop(sub.principal, None)

    def get_owned(
        self, client_id: str, subscription_id: str, *, principal: str = ""
    ) -> Subscription:
        """
        Resolve a subscription, or raise 404.

        A subscription owned by ANOTHER client, or created by another principal, raises the same
        404 as one that never existed. That is a spec MUST and it is the whole point: a 403 would
        confirm the id is real, turning the endpoint into an oracle for guessing other clients' ids.
        """
        with self._lock:
            sub = self._subs.get(subscription_id)
            if sub is None or sub.client_id != client_id or sub.principal != principal:
                raise SubscriptionError(
                    404, "Not Found", f"No subscription {subscription_id!r} for this client."
                )
            return sub

    def delete(self, client_id: str, subscription_id: str, *, principal: str = "") -> None:
        with self._lock:
            sub = self.get_owned(client_id, subscription_id, principal=principal)
            self._close_stream(sub)
            self._remove(sub)

    def list_owned(
        self, client_id: str, subscription_ids: Iterable[str], *, principal: str = ""
    ) -> List[dict]:
        """Bulk lookup. Missing or unowned entries report per-item failure, not a whole-request one."""
        out = []
        for sid in subscription_ids:
            try:
                sub = self.get_owned(client_id, sid, principal=principal)
            except SubscriptionError:
                out.append(
                    {
                        "success": False,
                        "subscriptionId": sid,
                        "responseDetail": {
                            "title": "Not Found",
                            "status": 404,
                            "detail": f"No subscription {sid!r} for this client.",
                        },
                    }
                )
            else:
                out.append({"success": True, "subscriptionId": sid, "result": sub.to_json()})
        return out

    # -- registration ------------------------------------------------------------------------

    def register(self, sub: Subscription, entries: Iterable[dict]) -> List[dict]:
        """
        Monitor each entry's `elementId` at its `maxDepth` (default 1), one result per entry in
        order. An id already monitored succeeds and changes nothing: the guide ignores a repeat
        registration, so the first one's depth stands.
        """
        results = []
        with self._lock:
            for entry in entries:
                element_id = entry.get("elementId")
                if not isinstance(element_id, str) or not element_id:
                    results.append(
                        {
                            "success": False,
                            "elementId": element_id,
                            "responseDetail": {
                                "title": "Bad Request",
                                "status": 400,
                                "detail": "elementId must be a non-empty string.",
                            },
                        }
                    )
                    continue
                if element_id not in sub.monitored:
                    sub.monitored[element_id] = entry.get("maxDepth", 1)
                    # Registered again after a withdrawal, so no longer news to report.
                    sub.withdrawn.pop(element_id, None)
                results.append({"success": True, "elementId": element_id, "result": None})
            sub.last_activity = self._clock()
        return results

    def unregister(self, sub: Subscription, element_ids: Iterable[str]) -> List[dict]:
        results = []
        with self._lock:
            for element_id in element_ids:
                sub.monitored.pop(element_id, None)
                # Unregistering something that was never registered is not an error: the end state
                # the client asked for is the end state it gets.
                results.append({"success": True, "elementId": element_id, "result": None})
            sub.last_activity = self._clock()
        return results

    # -- visibility --------------------------------------------------------------------------

    def has_elements(self, sub: Subscription) -> bool:
        """Whether anything is monitored or queued, so a visibility check has something to judge."""
        with self._lock:
            return bool(sub.monitored or sub.batches)

    def withdraw(self, sub: Subscription, visible: Callable[[str], bool]) -> tuple:
        """
        Drop each monitored element `visible` rejects, and each queued update for such an element,
        registered or not. A batch left with no updates is removed, so its sequence number is a gap.

        Returns (the ids dropped by this call, whether it removed the last monitored element). The
        ids are also held until `take_withdrawn`. `visible` runs under the lock: no I/O in it.
        """
        with self._lock:
            had_monitored = bool(sub.monitored)
            dropped: "OrderedDict[str, None]" = OrderedDict()
            for element_id in [e for e in sub.monitored if not visible(e)]:
                del sub.monitored[element_id]
                dropped[element_id] = None
            kept: "deque[dict]" = deque()
            sizes: "deque[int]" = deque()
            for batch, size in zip(sub.batches, sub.sizes):
                updates = []
                for update in batch["updates"]:
                    if visible(update["elementId"]):
                        updates.append(update)
                    else:
                        dropped[update["elementId"]] = None
                if len(updates) == len(batch["updates"]):
                    kept.append(batch)
                    sizes.append(size)
                elif updates:
                    kept.append(dict(batch, updates=updates))
                    sizes.append(batch_bytes(updates))
            self._set_queue(sub, kept, sizes)
            sub.withdrawn.update(dropped)
            return list(dropped), had_monitored and not sub.monitored

    def take_withdrawn(self, sub: Subscription) -> List[str]:
        """The ids withdrawn since the last report, cleared because the caller is reporting them."""
        with self._lock:
            ids = list(sub.withdrawn)
            sub.withdrawn.clear()
            return ids

    # -- value staging -----------------------------------------------------------------------

    def stage(self, updates_by_element: Dict[str, dict]) -> List[Subscription]:
        """
        Queue one batch per subscription that receives any of these updates (`receives`), holding
        those updates in the order given, each once.

        Called from the MQTT thread on every value change. Returns the subscriptions with an open
        stream so the caller can wake exactly those; each stream's own handler thread drains and
        writes, so a slow or dead SSE consumer cannot stall the ingest thread.

        Each update's size is estimated once, however many queues it joins. The byte ceilings are
        applied once every queue has its batch.
        """
        streaming = []
        sizes: Dict[str, int] = {}
        principals = set()
        with self._lock:
            for sub in self._subs.values():
                wanted = [eid for eid in updates_by_element if receives(sub.monitored, eid)]
                if not wanted:
                    continue
                for eid in wanted:
                    if eid not in sizes:
                        sizes[eid] = update_bytes(updates_by_element[eid])
                self._append_batch(
                    sub,
                    [dict(updates_by_element[eid], elementId=eid) for eid in wanted],
                    BATCH_OVERHEAD_BYTES + sum(sizes[eid] for eid in wanted),
                )
                principals.add(sub.principal)
                if sub.stream_open:
                    streaming.append(sub)
            self._enforce_byte_ceilings(principals)
        return streaming

    def _append_batch(self, sub: Subscription, updates: List[dict], size: int) -> None:
        """Append one batch of `size` bytes, dropping the OLDEST first if the queue is full."""
        if sub.next_seq > MAX_SEQUENCE_NUMBER:
            raise SubscriptionError(
                500, "Internal Server Error", "Sequence number space exhausted for this subscription."
            )
        while len(sub.batches) >= self.queue_limit:
            self._drop_oldest(sub)
        self._put(sub, {"sequenceNumber": sub.next_seq, "updates": updates}, size)
        sub.next_seq += 1

    def _drop_oldest(self, sub: Subscription) -> None:
        """
        Drop the oldest batch, on either limit. One no sync has returned is a loss at once. One a
        sync has returned is still queued only because the client has not yet acknowledged it, so
        it is a loss only if the next sync does not (`sync`): that response may never have arrived.
        """
        seq = self._take(sub)["sequenceNumber"]
        if seq > sub.sent_seq:
            # Latched, not a counter. The client is told once that a gap exists; it computes the
            # exact extent itself from the sequence numbers, which is more precise than any count
            # this server could report and cannot drift from the queue's real contents.
            sub.overflowed = True
        else:
            sub.dropped_sent_seq = max(sub.dropped_sent_seq, seq)

    def _enforce_byte_ceilings(self, principals: Iterable[str]) -> None:
        """
        Drop oldest batches until each of `principals`, and then the server, is within its ceiling.
        Each drop comes from the largest queue the ceiling covers, so the client that is not
        acknowledging loses its backlog and a client that keeps up keeps its own.
        """
        ceiling = max(self.max_queued_bytes_per_principal, 0)
        for principal in principals:
            while self._principal_bytes.get(principal, 0) > ceiling:
                self._drop_oldest(max(self._by_principal[principal].values(),
                                      key=lambda s: s.queued_bytes))
        while self._queued_bytes > max(self.max_queued_bytes, 0):
            principal = max(self._principal_bytes, key=self._principal_bytes.__getitem__)
            self._drop_oldest(max(self._by_principal[principal].values(),
                                  key=lambda s: s.queued_bytes))

    # -- byte accounting: every change to a queue goes through these three --------------------

    def _account(self, sub: Subscription, delta: int) -> None:
        if not delta:
            return
        sub.queued_bytes += delta
        self._queued_bytes += delta
        held = self._principal_bytes.get(sub.principal, 0) + delta
        if held:
            self._principal_bytes[sub.principal] = held
        else:
            self._principal_bytes.pop(sub.principal, None)

    def _put(self, sub: Subscription, batch: dict, size: int) -> None:
        sub.batches.append(batch)
        sub.sizes.append(size)
        self._account(sub, size)

    def _take(self, sub: Subscription) -> dict:
        batch = sub.batches.popleft()
        self._account(sub, -sub.sizes.popleft())
        return batch

    def _set_queue(self, sub: Subscription, batches: "deque[dict]", sizes: "deque[int]") -> None:
        sub.batches, sub.sizes = batches, sizes
        self._account(sub, sum(sizes) - sub.queued_bytes)

    def queued_bytes(self, principal: Optional[str] = None) -> int:
        """The bytes queued for `principal`, or on the whole server."""
        with self._lock:
            if principal is None:
                return self._queued_bytes
            return self._principal_bytes.get(principal, 0)

    # -- sync --------------------------------------------------------------------------------

    def sync(self, sub: Subscription, last_sequence_number=None) -> tuple:
        """
        Acknowledge, then return the remaining queue.

        Returns (batches, http_status). 206 means updates were dropped between the client's last
        acknowledgement and the first batch returned here.
        """
        with self._lock:
            if sub.stream_open:
                # The stream already delivered these and discarded them; letting sync run would
                # report an empty queue and look like data loss rather than a usage error.
                raise SubscriptionError(
                    409,
                    "Conflict",
                    "This subscription has an open SSE stream. Close the stream before calling /sync.",
                )

            acknowledged = self._acknowledge(sub, last_sequence_number)
            if sub.dropped_sent_seq:
                # Returned batches dropped since the last sync: an acknowledgement covering them
                # shows the client had them, and none or a lower one is a loss (`_drop_oldest`).
                if acknowledged is None or acknowledged < sub.dropped_sent_seq:
                    sub.overflowed = True
                sub.dropped_sent_seq = 0

            sub.last_activity = self._clock()
            batches = [dict(b) for b in sub.batches]
            if batches:
                sub.sent_seq = batches[-1]["sequenceNumber"]
            status = 200
            if sub.overflowed and batches:
                # Reported once, on the first sync that can carry it. Latching it until there is
                # something to return keeps the 206 attached to the batch whose sequence number the
                # client needs in order to measure the gap.
                status = 206
                sub.overflowed = False
            return batches, status

    def _acknowledge(self, sub: Subscription, last_sequence_number) -> Optional[int]:
        """
        Clear what `last_sequence_number` acknowledges. Returns the highest sequence number it
        covers, every one for `-1`, or None when it is omitted or invalid and acknowledges nothing.
        """
        if not isinstance(last_sequence_number, int) or isinstance(last_sequence_number, bool):
            # "MUST NOT clear the queue if lastSequenceNumber is omitted or is invalid." A string
            # that happens to look like a number is invalid, and silently coercing it would
            # acknowledge data the client never confirmed it processed.
            return None
        if last_sequence_number == -1:
            # The documented sentinel for "acknowledge everything pending".
            self._set_queue(sub, deque(), deque())
            return MAX_SEQUENCE_NUMBER
        if last_sequence_number < 0:
            return None
        while sub.batches and sub.batches[0]["sequenceNumber"] <= last_sequence_number:
            self._take(sub)
        return last_sequence_number

    # -- streaming ---------------------------------------------------------------------------

    def open_stream(self, sub: Subscription) -> List[dict]:
        """
        Mark the stream open, closing any existing one, and return the queued backlog to flush.

        The backlog is DRAINED here rather than left in place: SSE is at-most-once with no
        acknowledgement, so anything handed to the stream is gone. Leaving it queued would mean a
        later `/sync` re-delivered updates the stream had already sent.

        A stream that replaces this subscription's own does not count against `max_streams`.
        """
        with self._lock:
            if not sub.stream_open:
                open_now = sum(1 for s in self._subs.values() if s.stream_open)
                if open_now >= self.max_streams:
                    raise SubscriptionError(
                        429,
                        "Too Many Requests",
                        f"This server already has {open_now} open streams, its limit "
                        f"(I3X_MAX_STREAMS). Poll with /subscriptions/sync instead, or close a "
                        f"stream.",
                    )
            if sub.stream_open:
                self._close_stream(sub)
            sub.stream_open = True
            sub.last_activity = self._clock()
            backlog = [dict(b) for b in sub.batches]
            self._set_queue(sub, deque(), deque())
            return backlog

    def drain(self, sub: Subscription) -> List[dict]:
        """
        Take every queued batch, leaving the queue empty.

        Used only by the streaming path, on the stream's handler thread. Draining under the
        registry's own lock is what keeps it atomic against the MQTT thread appending concurrently --
        a copy-then-clear outside the lock would silently discard anything staged in between.
        """
        with self._lock:
            batches = [dict(b) for b in sub.batches]
            self._set_queue(sub, deque(), deque())
            return batches

    def close_stream(self, sub: Subscription) -> None:
        with self._lock:
            sub.stream_open = False
            sub.last_activity = self._clock()

    def _close_stream(self, sub: Subscription) -> None:
        if sub.stream_open and self.on_stream_close:
            self.on_stream_close(sub)
        sub.stream_open = False

    def touch(self, sub: Subscription) -> None:
        with self._lock:
            sub.last_activity = self._clock()

    # -- TTL ---------------------------------------------------------------------------------

    def reap(self) -> List[str]:
        """
        Delete subscriptions idle beyond the TTL. Returns the ids removed.

        "If neither an active SSE stream nor a call to /sync is received within the configured TTL,
        the Server MUST delete the Subscription" -- so an OPEN STREAM COUNTS AS ACTIVITY even when
        it carries no traffic. A quiet machine would otherwise have its subscription reaped out from
        under a perfectly healthy connection, and the client would see the stream close with no
        error and no reason.
        """
        now = self._clock()
        removed = []
        with self._lock:
            for sid, sub in list(self._subs.items()):
                if sub.stream_open:
                    continue
                if now - sub.last_activity >= self.ttl_seconds:
                    self._close_stream(sub)
                    self._remove(sub)
                    removed.append(sid)
        return removed

    def count(self) -> int:
        with self._lock:
            return len(self._subs)

    def monitored_element_ids(self) -> set:
        """
        Union of every registered elementId, so the MQTT side can skip staging what nobody wants.
        A metric absent from it is still wanted when its device is in it (`receives`).
        """
        with self._lock:
            out = set()
            for sub in self._subs.values():
                out.update(sub.monitored.keys())
            return out
