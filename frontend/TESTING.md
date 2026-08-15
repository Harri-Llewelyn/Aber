# Frontend Vitest Automated Test Suite

This directory contains automated unit and component tests for the React frontend of **ACS-Cymru Asset Tracking Platform**.

## Test Suite Structure

- `usePermissions.test.js`: Verifies the `usePermissions` hook loading states, permission evaluation, and error fail-safe behavior.
- `usePolling.test.js`: Verifies the `usePolling` hook's polling interval, immediate halt on 401 error, and backoff behavior.
- `ArchivesTab.test.jsx`: Verifies table rendering and permission-gated restore controls in `ArchivesTab`.

## Running Tests

```bash
# Navigate to frontend directory
cd frontend

# Run unit tests via Vitest
npm run test
```
