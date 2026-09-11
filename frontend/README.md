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
├── help/                    one markdown file per page, bundled -- see Contextual help
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
| `utils/sparkplugDatatype.js` | `functions/_shared/aas/sparkplugToXsd.ts` |
| `utils/model3d.js` | `functions/_shared/aas/model3dContentType.ts` |

All eight are now guarded, by `scripts/check-mirror-drift.mjs`, a CI step, or
`test_aas_export.py`. `sparkplugId.js` matters most — it derives an **immutable wire identity**, so
a divergence cannot be corrected in place.

`check-mirror-drift.mjs` reads the **whole applied migration chain in filename order and takes the
last definition of each function**, because migrations are replayed on every boot with no ledger:
`ensure_gateway_status_view()` is declared in `0001` and redeclared in `0025`, and for a while the
guard was reading the dead one.

A ninth mirror — `modelledMetrics()` — is behaviour rather than a literal, so it has a **fixture
contract** instead: `test-harness/fixtures/modelled-metrics.json`, asserted by four implementations in
three languages. See [Migrated design notes](#migrated-design-notes) for what that fixture caught.

### Permission gating

`hasPermission(uuid)` from `usePermissions`, against `PERMISSION_UUIDS` in `constants.js`. Gating
is a UI affordance only — RLS is the enforcement, and every gated action is independently refused
by the database.

### Derived lists in a tab are memoised, and the dependency list is the contract

`DevicesTab` holds around thirty pieces of state, so *any* of them — opening a modal, a Realtime
tick, one keystroke in the search box — re-renders the whole component. Its filter predicate is not
cheap: it resolves each device's schemas, tags, gateway and effective cell. Recomputing that for
every device on every render is what turns a search box sticky on a real fleet, and the cause is
nowhere near the search box.

So `filteredAssets`, `attentionCount` and `tagOptions` are `useMemo`d, and the per-row
`gateways.find(...)` / `cells.find(...)` scans are hoisted into `gatewayById` / `cellById` Maps.
**Miss a dependency and the table silently stops responding to that filter** — a worse bug than the
slowness, so the list names every value the predicate reads, in the order it reads them.

---

## Migrated design notes

Reasoning that used to sit as long header comments in the files it describes. It was moved here
because it explains **why the code looks like this**, which is a question a reader asks once,
rather than **what this line does**, which they ask every time. The mechanism-level notes stayed
where they were.

### Why entity detail is a drawer, not a modal or an expanding row

`components/common/ContextPanel.jsx` is the third way this dashboard has shown entity detail, and
the first two are why it looks like it does:

- **Modals covered the list.** Comparing two devices meant open, read, close, open, read — and the
  row you came from was hidden behind the thing describing it.
- **Expanding rows** kept the list visible but pushed every row below the one you opened, so the
  table reflowed under the cursor and a second click landed somewhere else.

A drawer in the layout flow does neither. It is **not an overlay**: `.page-layout` is a flex row
and the panel is a sibling of the list, so opening it narrows the table instead of hiding it. Rows
stay clickable while it is open, which is what makes flicking between entities work at all.

It is also **presentational only** — it renders `fields` and `actions` and knows nothing about
cells, gateways, devices or schemas. Four pages sharing a panel that understood all four would be
the same component four times over, each conditional branch reachable from exactly one caller.

### What the modelled-metrics fixture caught, twice

`modelledMetrics()` answers "which metrics does this schema model?" and exists four times, in three
languages, because it runs in four processes that cannot import one another:
`utils/deviceTags.js`, `ingestion/validate.py`, `i3x/i3x_service.py` and
`supabase/functions/aas-export/index.ts`.

`typeof [] === 'object'`, so a schema with `properties: ['Temp','Pressure']` reached `Object.keys`
and came back modelling two metrics named **`'0'` and `'1'`**. The dashboard judged the device
against those, so nearly everything it published read as Unmodelled, while `validate.py` read the
same schema as having no model at all.

Writing the fixture found it. Adding a fourth implementation without adding it to the fixture let
it happen **again**: the AAS exporter was written from the uncorrected JavaScript and carried the
same bug, unchecked, while the fixture's own comment described it. That copy was the worst place
for it — those names become Submodel Property `idShort`s in an exported AAS shell, a document
handed to a third party, and `'0'` cannot begin an `idShort`, so the shell fails validation at the
**consumer** while the exporter reports success.

The lesson is the one the fixture already taught: *an implementation that is not listed in the
fixture is an implementation that is not checked.*

### Why the Digital Thread groups overlapping markers into a badge

`components/tabs/DigitalThreadTab.jsx` draws one lane per asset with a marker per event. Events
written by one transaction share a timestamp exactly (`recorded_at` is the transaction start time),
so a commissioning burst of five or six rows lands on one pixel. Two fixes were tried and rejected:

- **A vertical fan** displaced colliding markers off the lane's centre line. The track is 32px and
  a marker 15px, so it held three; a fourth cycled back into the first slot, and the densest
  moments on the page were the ones it could not draw. Three fanned dots and five look alike, so
  it could not be counted either.
- **Nudging along the time axis** would make the same pair of events appear different distances
  apart depending on the range control, and it would erase the causation signal: perfect overlap
  is the visual signature of one act.

Markers closer than `CLUSTER_GAP_PX` (14px, one marker plus its ring) become one badge carrying the
count. Grouping is by **pixel** distance, not by time, so the range control acts as a zoom and a
cluster dissolves into its members as the same events move apart on screen. The badge sits at the
mean of its members' positions, so the x-axis still tells the truth, and its hover says whether the
members share a `causation_id` (one act) or merely a timestamp. Ordering inside a cluster falls
back to `event_id`, the order the rows were written, which is also how `causationSiblings()` orders
the rows of one transaction.

### What the Access Control page deliberately does not claim

`components/tabs/AccessControlTab.jsx` is not an inventory of the broker. Mosquitto's accounts live
in a file reachable only by `gateway-credential-service`, which is add-only and cannot list
anything back; giving it a LIST verb would hand whoever holds one bearer token the whole account
table. So the page shows what the **platform issued and recorded**, and the difference shows up
wherever a credential was minted outside a dashboard session: `record_gateway_credential_issued()`
cannot be called on a script's behalf, because `has_role()` resolves through `auth.uid()`, which is
NULL for the service-role key. Such a gateway reads *No platform record* and connects perfectly
well. The state is named for the record and not for the credential: *No credential* would be a
claim about the broker, which is the one thing the page cannot see.

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

`VITE_ENABLE_REALTIME` is resolved by `src/config.js` — see **Configuration** below. On the Compose
path it is still inlined at build time, so flipping it there means rebuilding the image; on Kubernetes
it comes from a ConfigMap and flips with a `helm upgrade`.

---

## Configuration

`src/config.js` resolves every `VITE_*` setting **at runtime first, build time second**, so one image
can serve any environment.

**Why this layer exists.** Vite inlines `import.meta.env` when the bundle is built, so every setting
used to be frozen into the image by `Dockerfile`'s build args. Under Compose that is invisible — the
image is built against the stack it will serve. Under Kubernetes it means **one image cannot serve two
environments**: a bundle built for staging carries staging's Supabase URL wherever it is deployed,
which defeats build-once/promote-the-artefact.

`public/config.js` is a shipped **no-op placeholder** that a deployment replaces — on Kubernetes, a
ConfigMap mounted over `/usr/share/nginx/html/config.js`. Both paths run the same code, so Compose
behaves exactly as it did before this existed.

| | Docker Compose | Kubernetes |
| :--- | :--- | :--- |
| Build | default; values inlined by Vite | `--build-arg VITE_RUNTIME_CONFIG=true`, nothing inlined |
| Source of values | `Dockerfile` build args from `.env` | a ConfigMap mounted at `/config.js` |
| Changing one | rebuild the image | `helm upgrade` |

Five things about it are load-bearing, and each has a comment in the file saying so:

- **Never read `import.meta.env` in a component again.** Go through `readSetting()` / `readFlag()` and
  add the name to `RUNTIME_SETTING_NAMES`. Reading it directly reintroduces exactly the freezing this
  layer exists to undo.
- **`BUILD_TIME_SETTINGS` must spell each name out as a static property access.** Vite substitutes
  `import.meta.env.VITE_FOO` *textually*; a dynamic `import.meta.env[name]` is not a substitution site
  and reads `undefined` for everything in a production bundle.
- **`/config.js` loads from `<head>` as a plain classic script.** A classic script is parser-blocking
  and a module script is deferred, so it runs first regardless of position — adding `type`, `defer` or
  `async` silently inverts that. It is in `<head>` because `vite build` injects the bundle's own module
  script there, so the built `index.html` would otherwise read in the opposite order to the one it
  executes in.
- **An unsubstituted `${…}` / `__X__` placeholder counts as absent**, never as a value. A rendered but
  unsubstituted config is worse than an empty one: the client constructs and every request fails
  against a nonsense origin with nothing naming the cause.
- **NGINX serves it `no-store`.** Fixed filename, environment-specific contents — a cached copy points
  a redeployed dashboard at the previous environment's Supabase URL.

`__tests__/runtimeConfig.test.js` pins all of it, including that the placeholder's key set matches
`RUNTIME_SETTING_NAMES`. The anon key moving from the bundle to a ConfigMap is **not** a security
change: it is the `anon` role, public by construction, and already readable in any built bundle.

---

## Tabs

| Tab | Notes |
| :--- | :--- |
| `OverviewTab` | The site map, the whole ISA-95 ladder on one page: the enterprise (the gateways' Sparkplug group) and the site (the `site.name` setting) named at the top, then **Site-Wide, Simulated and Unassigned full-width above the area selector** — they belong to no area, and inside the grid they reflowed between bays as cells were added. Dropping onto Unassigned *clears* the override, because Unassigned is derived and cannot be set. The map cycles **All areas** and one area at a time; an area view groups its cells by floor. **Area-Wide is one tile per area, first among that area's cells**, so a drop always knows its area. The counts the page used to carry are the rail's signals (`hooks/useNavSignals.js`) |
| `AreasTab` | The ISA-95 areas (buildings). Cells are filed by dragging a chip onto an area row; unfiled cells sit in a queue row above the table. Devices are never filed here: a device's area is its cell's, or its own when Area-Wide |
| `CellsTab` | Cell management. Device membership is grouped from its own `/api/v1/devices` load. Area and floor are on the form; the floor is a number, not a level |
| `GatewaysTab` | **Launch UI** and **Edit** visible, the rest in an `ActionMenu`; **Restore replaces Edit** on an archived row |
| `DevicesTab` | Quarantined devices render **in the onboarding queue banner only** — `filteredAssets` excludes them before every other filter, so no filter combination can list one twice. Two visible actions, not seven |
| `SchemasTab` | Metric catalog, the standard-vocabulary reference card, and the schema registry. **Building from the catalog is the only way to create a schema**; changing one is versioning, not editing |
| `TelemetryTab` | Time-series viewer over the FDW view. A time window is required whenever a tag filter is active |
| `DigitalThreadTab` | Audit trail. Filtering by tag matches devices carrying it **now**; the log records what was true then, and the UI says so |
| `DirectoryTab` | Directory service configuration and the GitOps flow push |
| `ArchivesTab` | Soft-deleted record restoration |

---

## Contextual help

A control in the top bar opens a drawer describing **the page you are on** — what it is for, what
its controls do, and what its states mean ([issue #39](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/39):
*"going to the GitHub to read the documentation takes a lot of time"*).

**The hard part was never the button.** The documentation this repository already had is written for
somebody changing the stack — it argues why things are built as they are, at length. A help panel
needs the other half, in a few hundred words per page, and shipping the control before the corpus
would have produced a help system whose honest content is a link to the README. That is what the
request called too slow in the first place.

### One file per page, resolved by filename

`src/help/<tab id>.md`, bundled by an eager `import.meta.glob` in `src/help/index.js`. There is no
manifest: a second list is the one that goes stale. `scripts/check-docs-drift.mjs` asserts the
correspondence **in both directions** — every page in `navigation.jsx` has a file, and every file
names a page that exists. The second direction is the one that rots silently: a help file left
behind by a renamed page is never resolved again, and the renamed page quietly has none.

**Why `src/help/` and not `docs/help/`,** which is where the roadmap entry proposed it.
`frontend/Dockerfile`'s build context is `./frontend` — on Compose, in `release.yml` and in the
k3d job alike — so `docs/` is not present at image build time at all, for the same reason `.git` is
not. Bundling from there works on a developer's machine and fails in every container build. The
properties that placement was chosen for are unaffected: these are markdown in the repository,
reviewed in the pull request that changes the behaviour they describe, and checked by a guard. They
are also still free in CI, which is not a `docs/` property either — `ci.yml` classifies a diff with
`*.md|docs/*`, and a `case` glob's `*` spans directory separators, so a `.md` file anywhere skips
the two end-to-end stacks.

### A restricted renderer, on purpose

`HelpMarkdown.jsx` renders headings, lists, paragraphs, bold, inline code and **absolute** links.
That is the whole subset. It exists rather than a markdown dependency because the corpus is thirteen
files this repository writes and ships in its own bundle — it is not untrusted input and does not
need CommonMark — and because every branch of it builds React elements, so there is no
`dangerouslySetInnerHTML` anywhere in the app for the next thing to be piped into.

An unsupported construct does not fail at runtime; it **renders as its own source text** — a table
arrives as a row of pipes, a repository-relative link as a dead anchor. That is a defect the reader
sees and the author never does, so the drift check rejects it at build time instead.

### The drawer is `ContextPanel`

The same component the entity pages use, with `subject="help"` for its region label and close
control. It is a sibling of `.content` rather than of a page's list, so it survives a tab switch,
works on pages that have no drawer of their own, and cannot be unmounted by the page it describes —
`tabId` follows the active tab, so it re-reads as you navigate. Both drawers can be open at once on
Devices; the flex row narrows the table rather than stacking them, and below 1100px it takes the
same dismissible overlay treatment every other drawer takes.

**Its contents are mounted only while it is open**, which the per-page drawers do not need to do.
The panel stays in the DOM so its width can transition, but a page of prose whose first line is the
page name put a second *"Devices"* into the document on every page — a duplicate for find-in-page
and for anything reading the document as text. `aria-hidden` kept it out of the accessibility tree;
nothing was keeping it out of the text.

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
