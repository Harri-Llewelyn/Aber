# Approve-Quarantine Edge Function

Supabase Edge Function for approving quarantined industrial devices and optionally assigning a gateway.

## Authorization & Security Policy

This function enforces **fail-closed** authorization. The caller's role is read from their row in `public.user_roles`, through a client bound to their own token so RLS applies. The JWT's `app_metadata.role` claim is never consulted, so deleting the row revokes the role at once:

* **`Administrator`**: Allowed (`200 OK`)
* **`Shopfloor_Manager`**: Allowed (`200 OK`)
* **`Operator`**: Denied (`403 Forbidden`)
* **No `user_roles` row**: Denied (`403 Forbidden`)

---

## Location

The body may carry `cell_id`, `area_id` and `location_scope` (`gateway`, `cell`, `area_wide` or `site_wide`). Each is written only when present: an absent key leaves the column alone, so a device that arrived following its gateway keeps following it, while an empty string is written as NULL. `gateway` (Follow Gateway) and `site_wide` clear the cell and the area; `area_wide` requires an `area_id` and clears the cell; `cell` requires a cell and clears the area. A `cell_id` sent with no `location_scope` means `cell`. The RPC mirrors the same rules.

## Merging into a provisioned device

A body with `merge_into_device_id` merges the quarantined device into that one and deletes the quarantined row. The RPC locks both rows, then refuses a merge it should not make. The answer is `409`, and `error` is the RPC's own sentence, which the dashboard shows as it is worded:

* `device_id` is not in Quarantine, or was registered before it was held (`requarantined_at`).
* `merge_into_device_id` is archived, is in Quarantine itself, or has sent its first birth.

It is the one refusal whose message is the database's. Every other failure answers a fixed sentence.

## Smoke Testing with Curl

The gateway refuses a request that does not carry the publishable key (`sb_publishable_…`, `secrets.publishableKey` in the values) as `apikey`, before the function runs, with `401 {"message":"No API key found in request"}`. With `npm run dev:forward` open, the gateway is `http://localhost:54321`.

### 1. Test User with No `user_roles` Row (Expected: `403 Forbidden`)

```bash
curl -i -X POST "http://localhost:54321/functions/v1/approve-quarantine" \
  -H "apikey: <PUBLISHABLE_KEY>" \
  -H "Authorization: Bearer <JWT_OF_USER_WITHOUT_ROLE>" \
  -H "Content-Type: application/json" \
  -d '{"device_id": "<device-uuid>"}'
```

**Expected Response**:
```json
HTTP/1.1 403 Forbidden
{"error":"Forbidden: Insufficient privileges"}
```

### 2. Test User with `Operator` Role (Expected: `403 Forbidden`)

```bash
curl -i -X POST "http://localhost:54321/functions/v1/approve-quarantine" \
  -H "apikey: <PUBLISHABLE_KEY>" \
  -H "Authorization: Bearer <JWT_OPERATOR_ROLE>" \
  -H "Content-Type: application/json" \
  -d '{"device_id": "<device-uuid>"}'
```

**Expected Response**:
```json
HTTP/1.1 403 Forbidden
{"error":"Forbidden: Insufficient privileges"}
```

### 3. Test Privileged User (`Administrator` / `Shopfloor_Manager`) (Expected: `200 OK`)

```bash
curl -i -X POST "http://localhost:54321/functions/v1/approve-quarantine" \
  -H "apikey: <PUBLISHABLE_KEY>" \
  -H "Authorization: Bearer <JWT_ADMINISTRATOR_ROLE>" \
  -H "Content-Type: application/json" \
  -d '{"device_id": "<device-uuid>", "gateway_id": "<gateway-uuid>"}'
```

**Expected Response**:
```json
HTTP/1.1 200 OK
{"success":true,"data":{"merged":false,"device":{...}}}
```
