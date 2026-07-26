# Approve-Quarantine Edge Function

Supabase Edge Function for approving quarantined industrial devices and optionally assigning a gateway.

## Authorization & Security Policy

This function enforces **fail-closed** authorization. Requests are evaluated against user claims in `app_metadata.role` or `user_metadata.role`:

* **`Administrator`**: Allowed (`200 OK`)
* **`Shopfloor_Manager`**: Allowed (`200 OK`)
* **`Operator`**: Denied (`403 Forbidden`)
* **Missing / Null Role Claim**: Denied (`403 Forbidden`)

---

## Smoke Testing with Curl

### 1. Test User with No Role Claim (Expected: `403 Forbidden`)

```bash
curl -i -X POST "http://localhost:54321/functions/v1/approve-quarantine" \
  -H "Authorization: Bearer <JWT_WITHOUT_ROLE_CLAIM>" \
  -H "Content-Type: application/json" \
  -d '{"device_id": "VAL_Quarantine_Device_001"}'
```

**Expected Response**:
```json
HTTP/1.1 403 Forbidden
{"error":"Forbidden: Insufficient privileges"}
```

### 2. Test User with `Operator` Role (Expected: `403 Forbidden`)

```bash
curl -i -X POST "http://localhost:54321/functions/v1/approve-quarantine" \
  -H "Authorization: Bearer <JWT_OPERATOR_ROLE>" \
  -H "Content-Type: application/json" \
  -d '{"device_id": "VAL_Quarantine_Device_001"}'
```

**Expected Response**:
```json
HTTP/1.1 403 Forbidden
{"error":"Forbidden: Insufficient privileges"}
```

### 3. Test Privileged User (`Administrator` / `Shopfloor_Manager`) (Expected: `200 OK`)

```bash
curl -i -X POST "http://localhost:54321/functions/v1/approve-quarantine" \
  -H "Authorization: Bearer <JWT_ADMINISTRATOR_ROLE>" \
  -H "Content-Type: application/json" \
  -d '{"device_id": "VAL_Quarantine_Device_001", "gateway_id": "gateway-uuid-here"}'
```

**Expected Response**:
```json
HTTP/1.1 200 OK
{"success":true,"data":[...]}
```
