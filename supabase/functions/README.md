# Edge functions

The Deno functions behind `/functions/v1/`. This page says what a caller sees when a function fails,
and how an operator finds out why. What each function does, who may call it and how the router
starts it are in [`supabase/README.md`](../README.md#edge-functions).

## When a function fails

A function that cannot do what it was asked answers in one of two ways.

- **A refusal the caller can act on keeps its own message.** A missing field, a bad token, a role
  that is not allowed or a row that does not exist answers `4xx` with a sentence saying what to
  change. A deployment missing a setting answers a fixed sentence that names the setting.
- **An unexpected failure answers a fixed sentence and a request id, and nothing else.** The status
  is the one that path has always answered: `500`, or `502` from `forge-membership` and
  `forge-sweep`. The dashboard shows the id after the message, as `Reference: <id>`.

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json
X-Request-Id: 3f6c1b52-8a0e-4d6f-9b1e-2c7d5a4e9f10

{"error":"Could not generate the bundle","request_id":"3f6c1b52-8a0e-4d6f-9b1e-2c7d5a4e9f10"}
```

The error itself never reaches the caller. It can name an internal host, a table or a constraint,
and the router's own failure answers callers who have not signed in. It goes to the function's log
instead, as one JSON line under the same id:

```json
{"level":"error","function":"gateway-bundle","request_id":"3f6c1b52-8a0e-4d6f-9b1e-2c7d5a4e9f10","message":"...","stack":"..."}
```

`context`, when present, says what the function was doing. A database error adds its SQLSTATE as
`code`. `aas-api` answers in the AAS specification's own shape instead: the id is the message's
`correlationId`, and the header carries it too.

### Finding the cause

1. Copy the id from the message, or from the `X-Request-Id` header.
2. In Grafana, open **Explore**, choose the **Loki** data source, and run:

   ```logql
   {service="supabase-functions"} |= "3f6c1b52-8a0e-4d6f-9b1e-2c7d5a4e9f10"
   ```

3. If nothing comes back, widen the time range to when the request failed.

`service` is the label Alloy sets from the pod's `app.kubernetes.io/component`. Without the chart's
observability stack, the line is in the pod's own log:

```bash
kubectl -n <namespace> logs deployment/supabase-functions | grep 3f6c1b52-8a0e-4d6f-9b1e-2c7d5a4e9f10
```

### Where the id comes from

The gateway gives a request an `X-Request-Id` when it arrives without one, and passes on one the
caller sent ([`docs/gateway.md`](../../docs/gateway.md#the-request-id)). A function reuses that id
when it is 8 to 128 letters, digits, `.`, `_` or `-`, and makes a new UUID otherwise. So a caller
that sends its own id can find its request in the log by it.

### Writing a function

Answer an unexpected failure with `serverError()` from [`_shared/failure.ts`](_shared/failure.ts).
Pass the request, the function's name and the error, with the path's status and a fixed sentence.
Never put an error's `message` or `stack` in a response. Check 41 of
[`scripts/check-docs-drift.mjs`](../../scripts/check-docs-drift.mjs) refuses the two common ways of
doing so, in each function's `index.ts`.
