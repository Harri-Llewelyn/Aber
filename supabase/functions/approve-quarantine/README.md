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

## Refusals

A refusal a person can act on, whose sentence was written for a person, is answered as the database words it. Everything else is answered in a fixed sentence, because the database's own names tables, columns and constraints. `refusals.ts` decides, `refusals_test.ts` holds each, and drift check 607 holds the triggers to it.

| The database refuses | Code | Answer |
| :--- | :--- | :--- |
| A merge, for one of the reasons above | `P0001` | `409`, as it is worded |
| A cell that is archived (`refuse_filing_in_an_archived_cell()`) | `23514` | `409`, as it is worded |
| A gateway that is archived (`refuse_assigning_to_an_archived_gateway()`) | `23514` | `409`, as it is worded |
| An Area-Wide device in an archived area (`refuse_area_wide_in_an_archived_area()`) | `23514` | `409`, as it is worded |
| The Playback gateway (`refuse_hand_assigning_a_replay_lane()`), in words that name a table and a column | `23514` | `500`, `Approval failed` |
| A replay lane moved to another gateway (`refuse_hand_making_a_replay_lane()`). Not on this path: the RPC runs as its owner, whom it lets through | `23514` | `500`, `Approval failed` |
| A CHECK constraint, which names itself and its table | `23514` | `500`, `Approval failed` |
| A gateway, cell or area that does not exist | `23503` | `500`, `Approval failed` |
| A scope with no cell or area, or a device merged into itself | `22023` | `400`, `Invalid approval request` |
| A device that does not exist, either one | `P0002` | `404`, `Device not found` |
| An actor without the role | `42501` | `403`, `Forbidden: Insufficient privileges` |

The code alone does not say which `23514` is which, so the three that are shown are known by how their sentence ends.

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
