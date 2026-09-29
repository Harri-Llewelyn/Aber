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
| `utils/standards.js` (`mtconnectSemanticId()`) | `mtconnect_vocabulary.semantic_id`, as `0002` seeds it |
| `utils/ashrae223.js` (`ASHRAE223_GROUP`) | the one metric group registered under ASHRAE 223P, and the group its seeded metrics file under |
| `hooks/usePermissions.js` (`DEFAULT_ROLE_PERMISSIONS_MAP`) | the `role_permissions` grants, as the chain seeds and withdraws them |

Each is guarded, by `scripts/check-mirror-drift.mjs`, a CI step, or `test_aas_export.py`.
`sparkplugId.js` matters most — it derives an **immutable wire identity**, so a divergence cannot
be corrected in place.

`check-mirror-drift.mjs` reads the **whole applied migration chain in filename order and takes the
last definition of each function**, because migrations are replayed on every boot with no ledger:
`ensure_gateway_status_view()` was declared in `0001` and redeclared in archived `0025`, and for a
while the guard was reading the dead one.

One more mirror — `modelledMetrics()` — is behaviour rather than a literal, so it has a **fixture
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

`VITE_ENABLE_REALTIME` is resolved by `src/config.js` — see **Configuration** below. It comes
from the frontend ConfigMap and flips with a `helm upgrade`.

---

## Configuration

`src/config.js` resolves every `VITE_*` setting **at runtime first, build time second**, so one image
can serve any environment.

**Why this layer exists.** Vite inlines `import.meta.env` when the bundle is built, so every setting
used to be frozen into the image by `Dockerfile`'s build args. It means **one image cannot serve two
environments**: a bundle built for staging carries staging's Supabase URL wherever it is deployed,
which defeats build-once/promote-the-artefact.

`public/config.js` is a shipped **no-op placeholder** that a deployment replaces — on Kubernetes, a
ConfigMap mounted over `/usr/share/nginx/html/config.js`. A bundle served without the ConfigMap keeps
its build-time values.

| | Build-time (plain `docker build`) | Runtime (the chart) |
| :--- | :--- | :--- |
| Build | values inlined by Vite | `--build-arg VITE_RUNTIME_CONFIG=true`, nothing inlined |
| Source of values | `Dockerfile` build args | a ConfigMap mounted at `/config.js` |
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
`RUNTIME_SETTING_NAMES`. The publishable key moving from the bundle to a ConfigMap is **not** a
security change: it stands for the `anon` role, is public by construction, and is already readable
in any built bundle.

### The bundle's version and the release's are two different facts

`src/version.js` states what **this bundle** is, baked at image build, and is the one setting that
deliberately has no runtime twin — a deployment must not be able to claim a version its bundle is
not. `VITE_RELEASE_VERSION` states what **the release** is, `Chart.AppVersion` arriving through the
same ConfigMap as everything else.

`utils/releaseVersion.js` compares them and the account menu shows a line under the version when
they disagree: *Update available — 0.2.0*.

**A pod is self-consistent**, so this is not a rollout progress indicator: `config.js` is mounted
with `subPath` and never updates in place, and the chart's `checksum/config` annotation rolls the pod
when it changes. The two disagree in two situations:

- the browser is running an `index.html` and bundle **cached from before an upgrade**, while
  `config.js` — served `no-store` — came fresh from the new pod. This is the common one, and a forced
  reload is the fix;
- `frontend.image.tag` is **pinned or overridden**, so the running image is not the one the release
  names. That survives a reload, which is how the two are told apart.

Three things it is not:

- **It does not reach the network**, so it cannot see a release published upstream — only the one
  this stack was told to run. Checking GHCR would need an egress allowance the chart does not grant,
  and would fail closed on a plant network with no route out.
- **It compares `MAJOR.MINOR.PATCH` only.** A development bundle names itself with `git describe`
  (`v0.1.0-752-g04374f9-dirty`), so anything stricter would warn on every dev cluster permanently.
- **It is a statement, not a button.** Nothing in a browser can upgrade the stack; the upgrade is
  [`docs/upgrades.md`](../docs/upgrades.md).

Unknown renders nothing, and that is the point: an unlabelled build, or a plain image build that
supplies no release version, is not evidence of drift.

---

## Tabs

| Tab | Notes |
| :--- | :--- |
| `SiteMapTab` | The Site Map page (tab id `site-map`), one card: the enterprise (the gateways' Sparkplug group) and the site (the `site.name` setting) named at the top, then **Site-Wide, Simulated and Unassigned as three coloured lanes** that open the context panel, then every area drawn as its plan (`common/AreaPlan.jsx`) with its cells as pins, one to three areas to a row by how many there are. Read only: nothing is filed or placed here. One context panel serves a lane, an area (its plan, its unplaced cells and its Area-Wide assets) or a cell; cells in no area sit in a tray under the grid. The counts the page used to carry are the rail's signals (`hooks/useNavSignals.js`) |
| `AreasTab` | The ISA-95 areas. Cells are filed by dragging a chip onto an area row; unfiled cells sit in a queue row above the table. Devices are never filed here: a device's area is its cell's, or its own when Area-Wide. An area's SVG plan is managed from its details panel (`common/AreaPlanPanel.jsx`); a plan is parsed as the browser parses it before upload (`utils/areaPlans.js` `readSvgPlan`), so a file that would draw as nothing, or whose stated size is not the one the browser would use, is refused with the reason. An area is archived from its panel the way a cell is, through the shared `ArchiveModal`, and hidden behind the lifecycle filter; it is deleted only from Archived Entities |
| `CellsTab` | Cell management. Device membership is grouped from its own `/api/v1/devices` load. The area and the place on the area's plan are on the form; the place is picked by clicking the plan (`common/CellPlacementPicker.jsx`), which refuses a spot closer than `site_map.min_pin_spacing` to another pin |
| `GatewaysTab` | **Launch UI** and **Edit** visible, the rest in an `ActionMenu`; **Restore replaces Edit** on an archived row |
| `DevicesTab` | Quarantined devices render **in the onboarding queue banner only** — `filteredAssets` excludes them before every other filter, so no filter combination can list one twice. Two visible actions, not seven |
| `SchemasTab` | Metric catalog, the standard-vocabulary reference card, and the schema registry. **Building from the catalog is the only way to create a schema**; changing one is versioning, not editing |
| `TelemetryTab` | Time-series viewer over the FDW view. A time window is required whenever a tag filter is active |
| `DigitalThreadTab` | Audit trail. Filtering by tag matches devices carrying it **now**; the log records what was true then, and the UI says so |
| `DirectoryTab` | Directory service configuration and the GitOps flow push |
| `ArchivesTab` | Two cards of one lifecycle. **Archived**: areas, cells, gateways and devices taken out of commission, with Restore, Permanent Delete (the one typed-name gate in the application) and, on a device, Export Bundle, which downloads the AASX with its history (`/api/v1/devices/asset-export`). **Retired**: the tombstones `retired_entities` holds for rows that were archived and then deleted, each linking to what survives it: the Digital Thread page with deleted entities shown, a gateway's forge repository, and any bundle taken while it was alive (`api.assetExportDownloadUrl`) |

---

## Contextual help

A control in the top bar opens a drawer describing **the page you are on** — what it is for, what
its controls do, and what its states mean ([issue #39](https://github.com/Harri-Llewelyn/Aber/issues/39):
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
`frontend/Dockerfile`'s build context is `./frontend` — in `release.yml` and in `npm run dev:up`
alike — so `docs/` is not present at image build time at all, for the same reason `.git` is
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

## Toasts and the notification history

`showToast(msg, type)` (`hooks/useToast.js`) is the one call every page makes, with `type` one of
`success` (the default), `info`, `warning` or `error`. Each call puts a toast in the bottom-right
corner and records the same message in the history behind the bell in the top bar.

- **Each toast owns its timer.** Up to three stack, each keyed by its id; a fourth pushes the oldest
  off. A message already on screen is replaced, restarting its timer, rather than shown twice. The
  single slot this replaced let a second toast inherit what was left of the first one's 3.2 s.
- **How long it stays.** Success and info 4 s, warning 8 s, or the reading time if that is longer:
  1 s plus 60 ms a character, capped at 20 s (`toastDuration` in `common/Toast.jsx`). An error
  stays until it is dismissed. The pointer or focus on a toast pauses it, and leaving resumes it
  with at least 2 s left. Every toast has a Dismiss button. Escape is not bound to toasts, because
  it already closes the modal or drawer beneath them. Pause, dismiss and sticky errors are what
  WCAG 2.2 SC 2.2.1 (Timing Adjustable) asks for.
- **Announced.** `ToastStack` renders two live regions all the time, empty when idle, because a
  region inserted together with its first message is not announced: errors in `role="alert"`, the
  rest in `role="status"`. A warning or an error is prefixed "Warning:" or "Error:" in text only a
  screen reader reads.
- **The history** (`common/NotificationHistory.jsx`) keeps the latest 50 messages, newest first. A
  repeat of the newest entry is counted on it rather than filling the list. The bell's badge counts
  the unread entries, is not rendered at zero, and takes the tone of the worst unread entry; a
  success leaves it neutral. Opening the list reads everything in it, dismissing a toast reads its
  entry, and a toast that times out stays unread. The list is a `role="dialog"` popover built like
  the alert pill's (`useEscapeKey`, `useClickOutside`): focus moves into it as it opens, and Escape
  or its close button hands focus back to the bell.
- **Where it is kept.** In `sessionStorage` under `aber_notification_history`, so it survives a
  reload and stays in that browser tab. It holds message text only, and every read and write is
  wrapped so a blocked store degrades to memory. `App` clears it whenever the tab is left without a
  session (Sign Out, a sign-out in another tab, a rejected stored session), so the next person to
  sign in there starts with an empty list. Nothing goes to the server: most entries never touched
  it, and an unread state that followed a user between browsers would need a per-user table with
  RLS. Supabase Queues (pgmq) does not fit that either, because a queue is single-consumer and
  cannot fan one event out to several signed-in users.
- **It is not the alert pill.** The pill says what is firing now, and its count is a reason to act.
  The history says what the toasts said, resolved and routine messages included; merging the two
  would fill the pill's count with entries nobody needs to act on.

---

## Theming

Colours come from **CSS variables in `App.css`** (`:root` / `[data-theme="light"]`). There is no
Tailwind in this project. Prefer `.card`, `.form-control`, `.form-label` over inline colour styles.

Two rules that were each learned from a real bug:

- **A floating surface needs an opaque background.** A toast floats over arbitrary content, so its
  `rgba(…, 0.15)` tint composited against whatever table was underneath. Each of the four types
  now paints its tint as a `background-image` over an opaque `background-color: var(--bg-card)`,
  and the bell's unread badge does the same. **Never fold those into the `background:` shorthand** —
  that resets `background-color` and brings the transparency straight back. `themeContrast.test.js`
  asserts both halves for every toast type and badge tone.
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
