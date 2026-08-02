# Web Dashboard

React 18 SPA served by NGINX. Talks to Supabase directly via PostgREST, subscribes to a Realtime
change feed, and invokes edge functions for privileged operations.

```bash
cd frontend
npm install
npm run dev        # Vite dev server on :3000
npm test           # Vitest
npm run test:cov   # with coverage
npm run build      # production bundle
```

---

## Layout

```
src/
├── App.jsx                  shell, routing, auth gate, theme
├── api.js                   every server call, in one module
├── constants.js             PERMISSION_UUIDS and role mappings
├── lib/supabaseClient.js    the single Supabase client
├── components/
│   ├── tabs/                one file per tab, lazy-loaded
│   ├── modals/              detail and edit dialogs
│   └── common/              ActionMenu, TagList, Model3DUploader, VocabularyPanel
├── hooks/                   usePermissions, usePolling, useRealtimeTable, useToast, …
├── utils/                   pure, unit-tested derivations
└── __tests__/               Vitest suites
```

---

## Key Patterns

### Derived state is computed client-side, never stored

Device tags, unmodelled metrics, metric grouping, gateway staleness, effective cell and
provisioning-overdue all follow the same shape: **a pure function in `src/utils/`, unit-tested,
with no backend cron and nothing persisted that could go stale.**

The reason is concrete. Editing a schema reclassifies its devices *immediately*; a stored flag
would stay wrong until the device's next birth, and rebirths are rare.

### Several utils mirror SQL, and must be kept in step

| Util | Mirrors |
| :--- | :--- |
| `utils/sparkplugId.js` | the `sparkplug_id` generated column |
| `utils/metricGroup.js` | the `metric_group` generated column and the spelling trigger |
| `utils/cellResolution.js` | `public.device_locations` |
| `utils/gatewayStatus.js` | `public.gateway_status` (90 s threshold) |
| `utils/schemaVersion.js` | `public.schema_version_base_name()` |
| `utils/deviceTags.js` | `ingestion/validate.py`'s Python mirror |
| `utils/sparkplugDatatype.js` | `functions/aas-export/sparkplugToXsd.ts` |
| `utils/model3d.js` | `functions/aas-export/model3dContentType.ts` |

Five are guarded by CI or by `test_aas_export.py`; four are not
([issue #2](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/2)). `sparkplugId.js` matters most —
it derives an **immutable wire identity**, so a divergence cannot be corrected in place.

### Permission gating

`hasPermission(uuid)` from `usePermissions`, against `PERMISSION_UUIDS` in `constants.js`. Gating
is a UI affordance only — RLS is the enforcement, and every gated action is independently refused
by the database.

---

## Realtime

`supabase-realtime` publishes `cells`, `gateways`, `devices` and `digital_thread`. Tabs subscribe
through `hooks/useRealtimeTable.js`.

- **`telemetry` is unpublishable, not merely unpublished.** It is a `postgres_fdw` foreign table
  whose rows enter TimescaleDB's WAL, never Supabase's. Adding it to the publication does not
  error — it silently emits nothing, which is the worse failure. **Do not "fix" the Telemetry tab
  by subscribing it.**
- **Never delete `usePolling`.** Realtime has no replay: a dropped socket loses every change in the
  gap and the client is not told. The 60 s poll is also the only path carrying the 401 stop and
  exponential backoff.
- **The replication slot is created lazily, *after* `SUBSCRIBED`.** A client can be subscribed and
  receiving nothing, so the hook reloads once on `SUBSCRIBED` to close that window. This is not
  redundant with the initial load.
- **Channels open only after authentication.** An unauthenticated subscriber still receives the
  event *envelope* (payload redacted, plus a 401), so subscribing pre-login leaks change timing.
  The hook checks `getSession()` itself rather than trusting callers.
- **Wall-clock-derived state needs `useClockTick`.** A gateway going quiet writes nothing and emits
  no event, so it would otherwise keep its last-rendered status until the next poll.

`VITE_ENABLE_REALTIME` is inlined by Vite at **build** time — flipping it requires rebuilding the
frontend image, not restarting the container.

---

## Tabs

| Tab | Notes |
| :--- | :--- |
| `OverviewTab` | Asset summary and the shopfloor map. **Site-Wide and Unassigned stack full-width above the cell grid** — they are not cells, and inside the grid they reflowed between bays as cells were added. Dropping onto Unassigned *clears* the override, because Unassigned is derived and cannot be set |
| `CellsTab` | Cell management. Device membership is grouped from its own `/api/v1/devices` load |
| `GatewaysTab` | **Launch UI** and **Edit** visible, the rest in an `ActionMenu`; **Restore replaces Edit** on an archived row |
| `DevicesTab` | Quarantined devices render **in the onboarding queue banner only** — `filteredAssets` excludes them before every other filter, so no filter combination can list one twice. Two visible actions, not seven |
| `SchemasTab` | Metric catalog, the standard-vocabulary reference card, and the schema registry. **Building from the catalog is the only way to create a schema**; changing one is versioning, not editing |
| `TelemetryTab` | Time-series viewer over the FDW view. A time window is required whenever a tag filter is active |
| `DigitalThreadTab` | Audit trail. Filtering by tag matches devices carrying it **now**; the log records what was true then, and the UI says so |
| `DirectoryTab` | Directory service configuration and the GitOps flow push |
| `ArchivesTab` | Soft-deleted record restoration |

---

## Theming

Colours come from **CSS variables in `App.css`** (`:root` / `[data-theme="light"]`). There is no
Tailwind in this project. Prefer `.card`, `.form-control`, `.form-label` over inline colour styles.

Two rules that were each learned from a real bug:

- **A floating surface needs an opaque background.** The toast is `position: fixed` over arbitrary
  content, so its `rgba(…, 0.15)` tint composited against whatever table was underneath. It now
  paints the tint as a `background-image` over an opaque `background-color: var(--bg-card)`.
  **Never fold those into the `background:` shorthand** — that resets `background-color` and brings
  the transparency straight back. `themeContrast.test.js` asserts both halves.
- **Do not give `var()` a hardcoded fallback.** The sign-in card rendered white-on-white in light
  mode because it referenced `--text-main` / `--bg-main`, neither of which exists; the fallbacks
  made the typo look correct in dark mode and fail silently in light mode.
  `authScreenTheme.test.jsx` now asserts that every variable referenced in `App.jsx` is one the
  stylesheet defines.

---

## Table and Row Conventions

- **Constrain cells holding variable-length data.** `.table-wrap` scrolls horizontally, so an
  unconstrained cell pushes the row's action buttons off-screen. This has bitten the quarantine
  queue twice.
- **A popover in a table row must be portalled.** Same cause, third symptom: `.table-wrap` is
  `overflow-x: auto`, so a menu positioned inside the row is clipped to a sliver. `ActionMenu`
  renders into `document.body` at `position: fixed` — which is why it closes on scroll and resize
  rather than trying to follow. Its `z-index` (900) sits under `.modal-overlay` (1000)
  deliberately; a menu floating over an open modal is unreachable.
- **Row actions belong in `common/ActionMenu.jsx`.** The Devices cell reached seven controls and
  over half the row's width. Keep one or two primary actions visible; a menu item can also carry
  *why* it is disabled, which reads far better than a greyed-out button.
- **`common/TagList.jsx` collapses long tag lists**, with `priority` entries pinned ahead of the
  cut — the entry that matters most is not the one that sorts first.

---

## Error Handling

Async handlers invoked from `onClick` must terminate their own promise chain. `SchemaDetailModal`'s
`run()` demonstrates the case: `SchemasTab.handleSaveDraft` toasts an error and then **rethrows**,
purely so a failed save aborts the publish that would otherwise activate a version whose edits were
rejected. That control-flow rethrow had nowhere to land and surfaced as an unhandled promise
rejection in the browser console. `run()` now catches it, logs, and does not re-toast — the user
has already been told.

---

## Testing

Vitest with globals enabled and a jsdom environment. **607 tests across 39 files.**

The suite treats an unhandled promise rejection as a defect, not noise — Vitest reports them
separately and they can mask real failures.

---

## Related

- [`../supabase/README.md`](../supabase/README.md) — the API this consumes, RLS, edge functions
- [`../ingestion/README.md`](../ingestion/README.md) — where device state comes from
