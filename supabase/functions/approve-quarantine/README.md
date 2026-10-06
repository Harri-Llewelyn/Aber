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

The body may carry `cell_id`, `area_id` and `location_scope` (`cell`, `area_wide` or `site_wide`). Each is written only when present: an absent key leaves the column alone, so `devices.cell_id` keeps its NULL-means-inherit meaning, while an empty string is the picker's explicit Inherit and is written as NULL. `area_wide` requires an `area_id` and clears the cell; `site_wide` clears both; `cell` clears the area. The RPC mirrors the same rules.

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
