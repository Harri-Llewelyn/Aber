# Web Dashboard

**In short:** how the dashboard is built: its layout, how it reads and updates data, and the
conventions its pages share. Read this if you are changing the dashboard. To learn how to use it,
open the help panel on any of its pages.

React 18 SPA served by NGINX. Talks to Supabase directly via PostgREST, subscribes to a Realtime
change feed, and invokes edge functions for privileged operations.

```bash
cd frontend
npm install
npm test           # Vitest
npm run test:cov   # with coverage
npm run build      # production bundle
```

**To see a change running**, rebuild the image into the dev cluster from the repository root with
`npm run dev:up -- --only=frontend`, then open http://app.localhost.

**`npm run dev` (Vite on :3000) needs a stack that admits its origin.** The dashboard throws at
load until `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are set (on the dev cluster,
`http://api.localhost` and the `publishableKey` in `values-dev.yaml`), and the gateway answers only
the origins the chart derives, so `http://localhost:3000` must also be in `global.corsExtraOrigins`.

---

## Layout

```
src/
├── App.jsx                  shell, routing, auth gate, theme
├── routes.js                the addresses one page links to on another -- see Routing
├── api.js                   every server call, in one module
├── constants.js             PERMISSION_UUIDS and role mappings
├── lib/supabaseClient.js    the single Supabase client
├── components/
│   ├── tabs/                one file per tab, lazy-loaded
│   ├── modals/              detail and edit dialogs
│   └── common/              TagList, Model3DUploader, VocabularyPanel
├── help/                    the repository's help/, parsed at build time, and its search -- see Contextual help
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
| `utils/sparkplugId.js` | the `sparkplug_id` generated column, and `gateways_sparkplug_group_format` (`sparkplugGroupProblem()`) |
| `utils/metricGroup.js` | the `metric_group` generated column and the spelling trigger |
| `utils/cellResolution.js` | `public.device_locations` |
| `utils/gatewayStatus.js` | `public.gateway_status` (90 s threshold) |
| `utils/schemaVersion.js` | `public.schema_version_base_name()` |
| `utils/deviceTags.js` | `ingestion/validate.py`'s Python mirror |
| `utils/sparkplugDatatype.js` | `functions/_shared/aas/sparkplugToXsd.ts` |
| `utils/model3d.js` | `functions/_shared/aas/model3dContentType.ts` |
| `utils/standards.js` (`mtconnectSemanticId()`) | `mtconnect_vocabulary.semantic_id`, as `0002` seeds it |
| `utils/ashrae223.js` (`ASHRAE223_GROUP`) | the one metric group registered under ASHRAE 223P, and the group its seeded metrics file under |
| `utils/historianBackupSchedule.js` (`nextHistorianBackup()`) | the historian backup sidecar's schedule, `physical_backup_missed_slot()` and `physical_backup_type()` in `timescaledb/physical_backup.sql` |
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

### What looks clickable

Only what acts looks clickable. `.mono` is a typeface and takes the text colour; accent colour
means a real link (the Directory's open chip, a `.count-link`). A value that copies is a
`CopyableId`: a bordered monospace chip with its copy icon at rest and a tick after a copy. A long
id passes `truncate="start"` to keep its end (`…/iso22400/EFFECTIVENESS`); the tooltip and the copy
carry the full value. A read-only or disabled `.form-control` takes the page background and muted
text, and `.btn-warning` is the amber button for a risky action that is not destructive.

### The rail opens when the pointer rests on it

In the rail's Hover mode, `Sidebar` opens the panel only once the pointer has rested on the rail for
150ms (`RAIL_OPEN_DELAY_MS`, through `hooks/useHoverIntent.js`). A pointer crossing the 52px strip
on its way somewhere else takes less, so the panel no longer flicks open and shut. Chrome and Edge on
Windows send hover events to a window that is not the active one, so a pointer passing to another
app did exactly that. Leaving shuts the panel at once, and a click during the wait still navigates.

Keyboard focus opens the rail at once, in every mode. Two kinds of focus are not keyboard focus:

- **A click's focus.** A focus that arrives while the pointer is on the rail is a click, and is
  ignored so the panel does not stay open over the page it opened. "On the rail" is a flag set the
  moment the pointer enters, not the delayed open state: read against a panel still shut, a quick
  click would look like a Tab and hold the panel open.
- **The window coming back.** A link clicked with the mouse keeps focus. When the window is activated
  again (Alt+Tab, a screenshot overlay closing), the browser focuses it again, with no previous
  focus (`relatedTarget` is null). The rail's blur notes whether the panel was open as the window
  lost focus (`document.hasFocus()` is already false then), and that return puts it back as it was.

Tab moving from one of the rail's controls to another is not leaving it, so the blur in between
does not shut the panel. Shutting it would hide a page's chevron and tabs, which show only on the
wide rail, from under the focus arriving on them, and the browser would drop that focus.

### The rail lists each page's tabs

A page with tabs (`pageTabs` on its `TABS` entry) is a `SidebarPage`: its link, a chevron, and a
list of its tabs' links beneath it. It is the WAI-ARIA disclosure navigation pattern, not a tree:
the chevron is a `<button>` with `aria-expanded`, `aria-controls` and a name of its own ("Show the
Devices tabs"), 28px square, and the list is a `<ul>` of `<a href>`s to each tab's address. Tab
reaches the page's link, the chevron, then each tab; Enter or Space on the chevron toggles it.
There are no arrow-key rules, which a tree would bring and nobody expects in a menu.

- **Which pages are open.** Arriving on a page opens its tabs and marks the current one
  `aria-current="page"` (its page's link then says `aria-current="true"`); a change of tab moves
  the mark. Arriving also closes every other page's tabs, those opened by hand included: any change
  of page does, from the rail, a link, `[` and `]` or the address bar. Until then, pages opened by
  hand stay open together. Closing the current page lasts until the next arrival on it.
- **Collapse all tabs**, the foot's item under the account control, closes every list, the current
  page's included. While none is open it is `aria-disabled`, dimmed and inert but still a Tab stop,
  rather than hidden, so the foot never changes height. It is 34px, the row the account menu's
  arrow is measured from.
- **Counts.** A signal from `useNavSignals` belongs to a page, and `signalTab` names the tab it is
  about: Devices' Quarantine and Approvals' Awaiting a decision. While the page's tabs are on
  screen the number moves to that tab, named as the tab bar names it ("Quarantine, 3 waiting"), and
  the page's link reads plain. Otherwise the page's link carries it, so no number shows twice.
- **No tooltips** on the tab entries. A tooltip on every row would flash as the pointer moves down
  the rail, and the tab bar's tabs already carry each tab's sentence.
- **The modes.** The list shows only on the wide rail: as it opens in Hover mode, always in Expanded
  mode, and on keyboard focus. Collapsed mode has no room for it, and the page's own tab bar is one
  click away, so a click on a tabbed page's icon opens the page, as any page's does.
- **Settings' categories** come from the database, so the rail lists `SETTINGS_TABS`, the frontend's
  copy in the database's order, before the page has read them. A category missing from it still
  shows on the page. Directory lists its three groups; the page adds a tab for any service type
  no group claims.
- **Profile** is not in the rail, so its tabs are on its tab bar only.

### Tooltips

Every tooltip in the dashboard is its own bubble (`common/Tooltip.jsx`), never the browser's
`title`. A `title` shows after about a second, never to a keyboard and never on a touch screen,
screen readers read it unevenly, and on an icon-only button it was often the only name.

- **Three outcomes for a `title`.** *Drop* it where the control already says the same in visible
  text. *Convert* it where it says something a keyboard or touch user needs: wrap the control in
  `<Tooltip text="…">`, and give an icon-only button an `aria-label`, so its name never depends on
  the tooltip. *Move* it where it is a hint repeated on every row: say it once, on the column
  header. `SortHeader`'s `title` is its button's tooltip, and `ColumnHeader` is a header that
  cannot be sorted with one.
- **Converting a control** is one wrapper:

  ```jsx
  <Tooltip text="Send the bundle to the gateway again">
    <button type="button" className="btn btn-ghost btn-sm" onClick={resend}>Resend</button>
  </Tooltip>
  ```

  It adds `useTooltip`'s handlers and `aria-describedby` to the control, keeps the control's own,
  and draws the bubble beside it. With no `text` it draws the control alone, in the same place, so
  a tooltip that comes and goes never remounts it. Text that is the control's name (its
  `aria-label`, or its own text shown whole where it is cut short) is not read again as its
  description. A tooltip shows on hover and focus, so it goes on something that takes focus; a
  sentence about anything else belongs in visible text or a `HelpTip`, or on the column header.
  A control that gets focus back, as a dialog's opener does, shows its tooltip, and the first
  Escape closes that. A component that draws a control takes the text as a prop and wraps its own
  element: `ActionButton`'s `title` and `deniedTitle`, `RouteLink`'s, `CopyableId`'s and
  `AreaPlanPin`'s `title`, and a `ContextPanel` action's. `Badge`'s `title` is the one on
  something that takes no focus, so a pointer alone sees it. An icon-only button is a `TipButton`,
  whose name is its `label` and whose bubble repeats it without describing it again
  (`describe={false}`). A drawer field's sentence is its `help`, a HelpTip beside the label, which
  a keyboard and a touch screen reach; fields take no tooltip.
- **In a test**, `src/test/tooltips.js` finds a control by its tooltip (`getByTooltip`), reads
  one (`tooltipOf`) and reads a HelpTip's sentence (`helpTipText`). A closed bubble is in the document, hidden, so a `getByText` that would also
  match a tooltip's words passes `{ ignore: '[role=tooltip]' }`.
- **The words.** About 20 words, plain sentences, no code, and never the visible label again.
- **The guard.** `npm run lint:js` fails on a `title` on an HTML element or an `Icon*` (which
  passes it to its `<svg>`) in `frontend/src`, a `no-restricted-syntax` rule in
  `scripts/lint/eslint.config.mjs`. A component's prop named `title`, such as a dialog's heading,
  is not matched. `title` stays where it is what the element
  means: `<abbr>` and `<iframe>`, which the rule lets through, and an SVG's `<title>` element,
  which is not an attribute. A link whose text is its own address, cut short, wants
  `<Tooltip text={url}>`, which shows it whole; a `title` there takes an
  `eslint-disable-next-line no-restricted-syntax -- the text is the address`. No file is let off
  the rule: `scripts/lint/browser-tooltip.test.mjs` fails on a block that turns it off, on a line
  let off with no reason, and on any `title` left in the dashboard.

### Tooltips on a tab

A tab explains itself in a tooltip, its `description` in `TabStrip`'s `tabs`. It is there to help
someone choose a tab, so it must be readable before the tab is opened. The browser's own tooltip
(`title`) is not used: it shows after about a second, never to a keyboard and never on a touch
screen, and screen readers read it unevenly.

- **One bubble.** `common/Tooltip.jsx` draws the bubble for HelpTip and for every tab, so the two
  always look alike (`.tooltip-bubble`, beside `.help-tip` in `App.css`). Inside an open native
  dialog it goes into the dialog, which sits in the top layer above anything portalled to `<body>`.
  The Audit Trail drawer's step buttons use `useTooltip` too, so a button at an end can say why on
  keyboard focus.
- **It points at its control.** The bubble carries an arrow on the border facing the control, drawn
  as the popovers' are (*Popover arrows* in `App.css`). `placeTooltip` puts the bubble below the
  control, or above a control low in the window, with the arrow hanging from the bottom border. It
  sets `--arrow-x` to the control's centre, measured from the bubble's edge. Near the window's right
  side the bubble ends at the control's right edge rather than being pushed left, so a short bubble
  still reaches it. The script places the arrow for the widest bubble, 320px; the stylesheet keeps
  it 14px (`ARROW_INSET`) inside a narrower one, which only the browser can measure.
- **When it shows.** `useTooltip` shows it once the pointer has rested on the tab for 300ms
  (`TOOLTIP_DELAY_MS`, through `useHoverIntent`, as the rail does), so bubbles do not flash as the
  pointer crosses the bar. Keyboard focus shows it at once. A press, the pointer leaving, blur, a
  scroll and a resize close it, and so does Escape, from the shared stack, before a drawer behind it.
  A press's focus is not keyboard focus, and the focus a window hands back when it is activated
  again is treated as the rail treats it.
- **What a screen reader hears.** The tab's `aria-describedby` names the bubble, which is in the
  document, hidden, while closed. So the sentence is read with the tab's name, "Quarantine,
  3 waiting", whether or not the bubble shows.
- **How long.** Plain sentences, 20 words at most, no code: the tooltip appears whenever the
  pointer rests on the bar, which is more often than a `?` is opened. Anything longer goes on the
  page's help page. `tabTooltips.test.jsx` holds each page's sentences to that.
- **Where the sentences live.** Beside each page's tab list (`SECTIONS`, `QUEUES`, `VIEWS` and the
  like). Settings' categories come from the database, which has no description for one, so their
  sentences are `CATEGORY_DESCRIPTIONS` in `SettingsTab.jsx`; a category missing from it has no
  tooltip. Vocabulary's are each standard's `hint`, and each standard's description and caveats
  are on the Vocabulary page's help page. Directory's are its groups' descriptions.

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

### A page's summary is one row of cards

Backups and Cold Storage sum up their list in one row of `common/SummaryCard.jsx` cards between the
toolbar and the table, drawn like the Site Map's lanes: a 4px cap in the state's colour (grey while
nothing is wrong) and a chevron on a card that opens a panel. A card that opens something is a
`<button>`; one that opens nothing is a focusable group, so its tooltip still shows from the
keyboard. The state is in words on a `role="status"` line, and the whole card in sentences is the
shared Tooltip and, after the title, the accessible name.

**Every line is one line high, cut short with an ellipsis**, so a warning changes a card's colour
and words but never its height, and the list does not move. That is the point of the design: the
stat strip and the full-width callouts it replaced grew a row per warning, and at 1366×768 the
Backups list showed one run under two warnings. What a card holds is chosen for what someone acts
on; the rest (a duration, the oldest restorable backup) is in its tooltip. Anything with a button
of its own, such as a backup in flight with Cancel, stays full width outside the row, since a
button cannot sit inside a card that is one. The row is four across, two by two below 1100px and
one column on a phone, by the window rather than the card, so a drawer opening beside the page
does not move a card from under the pointer. The tints are measured in `themeContrast.test.js`; a
badge in a card sits on `.summary-card-badge`, the card's own ground, because a badge's ink has
too little headroom over its own tint to survive a second one.

### A dialog keeps its buttons in view

`Modal` is a flex column capped at the window height. The header row, the error slot and the footer
(`.modal-actions`) keep their size; only `.modal-body` (the lead and the children) scrolls, so Save
never scrolls away and an error never pushes it down. `.modal` itself must not scroll. A dialog
whose list should take the leftover height passes `fill` and marks that child `modal-fill`; the
schema builder's metric list does. A fixed `max-height` on a list inside a dialog is a guess at the
window and is not needed any more.

### A dialog takes focus

`Modal` renders a native `<dialog>` and opens it with `showModal()`, following the WAI-ARIA dialog
(modal) pattern. The browser draws it in the top layer, above every z-index, and makes the rest of
the page inert: Tab and Shift+Tab stay inside it, and neither a pointer nor a screen reader reaches
the page behind. `.modal-overlay` is the `<dialog>`, sized to the window; `.modal` is the box inside
it; the dimmed page is `.modal-overlay::backdrop`. A click on the dialog outside the box is a click
on the backdrop.

- **Where focus starts.** On the dialog itself (`tabIndex={-1}`), named by its title and described
  by its lead, so a screen reader reads both first. A dialog whose first field is the obvious start
  passes a ref to that field as `initialFocus`: Add a Person, Change Password, Take a Backup, and
  the machine identity's create and describe dialogs. A dialog that guards an act which revokes or
  overwrites keeps the default, as ConfirmModal's typed gate does, so its warning is read before
  its field. No dialog starts on a button. `autoFocus` does nothing inside a dialog, because React
  focuses the control before the dialog is shown; `modalFocus.test.jsx` fails on a dialog that
  uses it.
- **Where focus goes back.** To what had it as the dialog opened. When that has gone (its row was
  deleted), to the dialog still open beneath, or else to `main`, which is focusable for that moment
  only. A dialog opened over another hands focus back to the control in the one beneath; when both
  close in one update, focus goes to what opened the first.
- **While it is open.** When the control holding focus is removed, as when a dialog moves on to its
  next step, focus goes back to the dialog.
- **Escape** stays on the `useEscapeKey` stack, which cancels the keypress, so the browser does not
  close the `<dialog>` itself and a dialog opened over another answers first. A field that answers
  Escape itself (the semantic ID search) cancels it too. Any other close request, such as Android's
  back gesture, arrives as the dialog's `cancel` event and calls `onClose`.
- **What must be inside.** The page under a dialog is inert and drawn beneath it, so anything that
  must be used over a dialog goes into it: `overlayHost()` returns the open dialog, or `<body>`. The
  clipboard fallback's scratch field (`copyText`) and the help tip's bubble go there. The toasts do
  not, so a message a person must see while a dialog stays open is shown in the dialog: a failure in
  its error slot, a refused copy beside the value.
- jsdom has no `showModal()`. `src/test/setup.js` stubs it to set `open`, so the tests assert what
  `Modal` does itself; the inert page and the top layer are checked in a real browser.

### A plan and a 3D model open expanded

An area's plan (on a Site Map card, and in the Areas and Cells panels) and a device's 3D model (in
its drawer) each have an Expand button (`common/ExpandButton.jsx`). It opens `Modal` at size
`full`, the window less a 24px margin, with `fill`. The button's hover text is the shared tooltip
(`common/TipButton.jsx`), and the dialog hands focus back to it on close.

- **Where the button sits.** In the top-right corner of what it enlarges, so nobody misses it: one
  rule, `.expand-corner`, inside an `.expand-frame` that holds the view and the button side by side.
  On a Site Map card the frame is the space under the header (`.expand-frame-fill`), which the plan
  is centred in. In the panels it is `.plan-card`, which draws the frame the plan used to draw,
  across the panel, because the preview is a link and a button cannot sit inside one. On the model
  it is the viewer's box. The button is above the pins, inside the plan's margin where the plan
  fills the frame's width: it covers at most 16 by 5px of the drawing, at three columns. A pin
  placed on the drawing's top-right corner has the upper part of its disc under the button; the
  rest of the pin, and its label, can still be clicked.

- **The plan viewer** (`common/PlanViewer.jsx`) zooms by laying the drawing out wider, never by a
  CSS scale: the SVG is redrawn sharp at every size, and the pins over it (`AreaPlanPin`, 40px) keep
  their size on screen and spread apart. It holds the view as the zoom and the drawing's fraction
  at the viewport's centre, so a resize keeps the same place in view. A plan smaller than the
  viewport is centred, a larger one always covers it, so it cannot be panned out of view.
- **Input.** Wheel and trackpad pinch zoom about the pointer (a native, non-passive listener, so the
  page neither scrolls nor zooms); two fingers pinch; one pointer pans once it has moved 4px, and
  the click that ends a pan is swallowed so a pin under it is not opened. The keys (+, = and −, 0,
  the arrows) are bound on the `<dialog>`, so they act wherever focus is in it and nowhere else;
  App's single-key shortcuts already stand down while a dialog is open (`shortcuts.js`).
- **The cap is 4 times the fitted size,** measured on the plan of an office floor with about a
  hundred room labels (3 units high in a 387-unit-wide drawing). Fitted, the labels are 7.7px on
  screen in a 1280×720 window, 10.1px at 1440×900 and 13.4px at 1920×1080; they pass 12px by 1.6×,
  and are 31 to 54px at 4×. Memory did not grow with the zoom: zoomed and panned up to 8× (a drawing
  13,865px wide), the JS heap stayed at 12 to 15 MiB and Chrome's private memory showed no trend, at
  a device pixel ratio of 1 and of 2. Chrome draws an SVG image by tiles, so the cap is about use,
  not memory.
- **The Site Map's dialog** draws the card's own pins (`React.cloneElement` of `cellPin`, at the
  one-column icon size), so their state comes from the same data. A click opens the cell's panel
  and closes the dialog; it opens rather than toggles, as the panel behind cannot be seen. The
  page's legend is repeated in the dialog's header. The dialog is rendered outside the grid and the
  cards, whose click and `--pin-size` are not its own. The Areas and Cells dialogs draw the
  preview's marks (`previewPins` in `AreaPlanPreview.jsx`) at full size.
- **The 3D model** is the same `<model-viewer>` in `Model3DViewer`'s `expanded` mode: no
  auto-rotate, and the camera's start (`START_VIEW`, the element's defaults) set as attributes so
  Reset view can set them again. The element animates to a camera property set to its own value.

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
`supabase/functions/_shared/aas/shell.ts`.

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

### Why the Audit Trail groups overlapping markers into a badge

`components/tabs/AuditTrailTab.jsx` draws one lane per asset with a marker per event. Events
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

### How the Audit Trail drawer steps

The event drawer moves along a lane and between lanes, like a cursor in a grid:

- **← and →, or ◀ Previous and Next ▶,** step through the open lane's events. A lane is a kind and
  an id (`laneKeyOf`), so a device, its nameplate and its schemas are three lanes and "Event 3 of 7"
  counts the one on screen. The order is `byTimeThenId`, the badge's order: oldest first, and the
  rows of one transaction, which share a time, in the order they were written.
- **↑ and ↓, or Previous Entity and Next Entity,** move to the lane drawn above or below, across
  section headings, and open its event nearest in time to the one open (`nearestInTime`; the
  earlier of two as near). The order is the one on screen when the key is pressed, so a poll that
  re-ranks the lanes moves the next press with it. Neither pair wraps. While the drawer is open the
  page keeps all four keys, so ↑ and ↓ do not scroll the timeline; Page Up and Page Down still do.
- **They stand down** where `shortcutAllowed` (`shortcuts.js`) says, so a dialog in front, a field,
  a select and Ctrl, Cmd or Alt all keep them, and for a key a control has already taken. They are
  not character keys, so the Single-key shortcuts setting does not cover them.
- **At an end** a button is `aria-disabled`, not `disabled`: it stays in the Tab order, a press does
  nothing, and its tooltip (the shared one, which shows on focus) says why. Previous at the oldest
  event says what is loaded: Show more may hold older ones.
- **What a screen reader hears.** The drawer does not take focus, so a step would change it
  silently. A visually hidden `role="status"` line says what each step opened ("Event 4 of 7:
  Updated, 14:02, Press 4"). It is drawn with the drawer and speaks after a step only, by key or
  button, so opening the drawer reads as it does on every page.
- **The marker follows.** After every step the selected marker is scrolled into view (`nearest`).
  Its `scroll-margin` keeps it clear of the pinned axis row, the section heading and the label
  column.

### What the Access Control page claims, and how it says so

`components/tabs/AccessControlTab.jsx` shows two sources side by side and never merges them. The
**Credential** column is what the platform issued and recorded; the **Broker** column is what the
broker holds right now, read live from its Dynamic Security plugin through `broker-inventory`. The
difference shows up wherever a credential was minted outside a dashboard session:
`record_gateway_credential_issued()` cannot be called on a script's behalf, because `has_role()`
resolves through `auth.uid()`, which is NULL for the service-role key. Such a gateway reads *No
platform record* and *Active*, and connects perfectly well. The recorded state is named for the
record and not for the credential: *No credential* would be a claim about the broker.

The broker read may fail without failing the page. The Broker column then reads *Not read*, which
is a fact about the page load and not about any account, and the reason is stated once in the
card. The page does not show sessions: an *Active* account is one that may connect.

People, Broker credentials and Machine identities are searched and filtered in the browser: each
list is tens of rows, read whole. What is gone is hidden the same way on every tab, behind a **Show
… (N)** toggle that appears only while N is above 0: removed people (`accessRemoved()` in
`utils/people.js`, which leaves out a removal whose sign-in is still open, since that row needs
Remove Access again), archived gateways and withdrawn identities. The tab and the filters are in
the address (see [Routing](#routing)), which is why the page has no Refresh: every action reads its
list again, and a reload returns to the same view.

The **People** tab (`components/tabs/PeopleSection.jsx`) is offered only when `App.jsx` passes
`userRole` Administrator, and the page opens on it. Roles go through `set_person_role()`; adding,
removing, restoring and Set New Password go through `manage-people`, because GoTrue's admin API
needs the secret key. The controls the database would refuse (your own row, the last Administrator
who can sign in, a removed person's role or password) are disabled with the reason as their
tooltip, computed in `utils/people.js`, so the page and the database state the same rule. A password
`manage-people` mints, for Add Person on a site with no mail relay or for Set New Password, is shown
by `PasswordShownOnce` and lives in its dialog's state until it closes, as a minted token does in
`ServiceTokenModal`.

**Change Password**, the Password row's action on Profile's Account tab, opens `ChangePasswordModal`.
`utils/passwords.js` sends the current password with the new one in one
`supabase.auth.updateUser()`, and GoTrue checks the current one before it sets anything
(`docs/security-model.md`, *People*). The button is disabled for a session with no email address,
a machine identity, which has no password.

### A Third-party gateway's dialog gives every setting its edge node needs

A Third-party gateway (`deployment = 'third_party'`, migration `0196`) is an edge node on its own
machine, running software Aber does not manage. `credentialIssuedHere()` in `utils/gatewayType.js`
is true for it and for a Host gateway, and every page that decides whether to offer a credential or
a bundle asks it. Placement follows Remote: `cellResolution.js` and the Site Map's host flag test
`deployment === 'host'` only, so a Third-party gateway holds a cell and carries no flag.

Its credential dialog shows `EdgeNodeSettings` (`components/modals/EdgeNodeSettings.jsx`) in place
of the Node-RED steps, and so does Show Broker Credential. Each value comes from where the dashboard
already learns it (`utils/edgeNodeSettings.js`):

- **The broker address and port** from the Directory's broker row, which db-init keeps to the
  chart's public broker address, the one an appliance is handed. A row still naming an in-stack
  host is shown with a warning, and an unreadable Directory is said rather than guessed.
- **The primary host id** from `VITE_PRIMARY_HOST_ID`, which the chart renders from
  `ingestion.primaryHostId`. Absent, the dialog says where it is set.
- **The root certificate** from `/.well-known/aber/ca.pem` on the dashboard's own host, which
  `nginx.conf` serves when ingress TLS is on. It is offered as a download and an address to copy.

The link to *Bringing your own edge node* is an `a[data-help]` naming `site/bring-your-own-edge-node`,
whose `href` is the page on GitHub at the running release's tag, or `main` for a development build
(`sourceRef()`). The help panel takes over such a click; without it, the link opens GitHub.

Saving a new Third-party gateway opens the dialog with `confirmFirst={false}`, which issues on open
once, as the setup dialog does for a new Remote gateway: there is nothing yet to replace. The drawer
says what the gateway does not get (**Not Provided**), and shows no appliance health rows for it.

### Why the cold-archive destination is one dialog

`ColdStorageDestinationModal` holds the whole destination, the write-only secret key and the
archiving switch, as Backups' destination dialog does, so each value has one editor: the Settings
page does not list those six rows. The switch refuses "on" until the destination is complete,
because archiving switched on with nowhere to write cannot run. The values stay `system_settings` rows written by `api.patchSetting`, so RLS, `sensitive` and the audit
trail are unchanged. The secret key is a `CredentialField` (`components/common/CredentialField.jsx`),
the field Backups' destination dialog uses for its key too. A stored key reads as stored and is never
shown, and replacing it asks first: `set_archive_credential()` overwrites it with no undo, and
nothing can show either value again. A first key goes straight in. Its `useCredential()` hook
writes the key when the dialog saves, before archiving is switched on, and names a 403 as a refusal.

### Why a reload waits for the auth server

A session can end on the server while the browser still holds its tokens: a Sign Out in another
browser, a password change, a wiped `auth.sessions`. PostgREST checks only the JWT's signature, so
reads on such a token still succeed. `App.jsx`'s `restoreSession` therefore asks the auth server
with `getUser()` before anything renders. The spinner stays up for that round trip, and the
`INITIAL_SESSION` and `SIGNED_IN` events supabase-js raises for the stored session do not end it.

- **An ended session reaches the page as a 400.** auth-js turns GoTrue's 403 `session_not_found`
  into an `AuthSessionMissingError` with status 400, and deletes the stored session before it
  returns. `isSessionRejected()` names that error. `restoreSession` also keeps only the session
  `getSession()` still returns after the check, so a later auth-js that names the error differently
  cannot bring back a session supabase-js has dropped. A page holding one sends every request with
  the publishable key alone, and PostgREST refuses them all.
- **An unreachable auth server is not a rejection.** A fetch failure or a 5xx comes back as
  `AuthRetryableFetchError`, supabase-js keeps the session, and the dashboard opens on it. The
  connection strip then says whether the page is updating.
- **The wait is bounded.** A connection that never answers would hold the spinner until the browser
  gives up, so after `AUTH_CHECK_TIMEOUT_MS` (10 seconds) the page opens as it would for an
  unreachable server. It uses the session supabase-js last announced. A refusal that arrives later
  still signs the page out, with the same notice.

### Profile, and the preferences that follow the person

Two pages, two scopes, and each says which in its heading's note. **Profile**
(`components/tabs/ProfileTab.jsx`, page id `profile`, tabs `account` and `appearance`) is the signed-in
person's own: "Applies to you, on any browser". **Settings** is the site's: "Applies to everyone on
this site". Profile's tabs reuse the Settings table (Setting, Description, Value, Actions), header
row and all, so the two read alike.

- **Profile is not in the page list.** Its `TABS` entry has no group, so `groupedNav()` leaves it
  out of the rail; the router, the help drawer, the tab title and the search still know it. The way
  in is the account menu, App.jsx's `UserMenu`, which `Sidebar` draws at the rail's pinned foot
  above Collapse all tabs: the session's facts, then the Theme switch and the Sidebar layout switch,
  each a section of its own, then Profile, Report Bug and Sign Out. Each switch is a
  `SegmentedControl` with `menu` across the whole row: a `role="group"` of `menuitemradio`s, each
  its icon and its name, the current one checked. Theme holds Light and Dark (a sun, a moon).
  Sidebar layout holds Hover, Expanded and Collapsed, the three `SIDEBAR_MODES` in short words so
  they fit the menu; each segment's tooltip is its layout's description, in the shared bubble. Neither
  row has a visible label: the segments' names say what they are, and
  the group's name tells a screen reader what the row is for. Choosing applies at once and the menu
  stays open, since the result shows behind it. A third theme would be a third segment.
- **Settings is every role's.** Every signed-in account may read a setting, so the page is in every
  rail and the search offers its rows to everyone. `SettingsTab`'s `readOnly`, which `App.jsx`
  passes for anyone but an Administrator, disables each field and puts "Only an Administrator can
  change this" in Actions. RLS already withholds the rows marked `sensitive`; a row another page's
  dialog edits is offered by the search only while that page is in the rail.
- **Theme, sidebar layout and single-key shortcuts are the person's `user_settings` row**
  (`supabase/README.md`, `0188`, `0194`), read and written by `hooks/useUserSettings.js`. `useTheme`,
  `useSidebarMode` and `useSingleKeyShortcuts` keep the browser's copy in localStorage
  (`aber_theme`, `aber_sidebar_mode`, `aber_single_key_shortcuts`), so the page paints at once and
  the sign-in screen shows the theme last used here; once the row loads it wins. A person with no
  row is seeded from that copy's theme and layout (`utils/userSettings.js`, ON CONFLICT DO NOTHING,
  then a second read); the shortcuts take the column's default, on. Each change goes to the copy at once and to the row behind it, and the menu's two switches
  and Appearance all write through the one hook's setters. A choice made before the row
  arrives is not undone by it.
- **Without the row the page works as it did before.** A failed read or write leaves `source` at
  `browser`: Appearance says the choices are this browser's, and a change holds here only.
- **There is no display name.** The account is named by its email address everywhere, the menu and
  Profile included.

---

## Realtime

`supabase-realtime` publishes `cells`, `gateways`, `devices`, `areas`, `platform_alerts`,
`capture_jobs` and `playback_jobs`, and deliberately not `audit_trail`. Tabs subscribe through `hooks/useRealtimeTable.js`.

- **`captures` is not published either.** Realtime tells a subscriber that a published table
  changed even when RLS hides the row ([`docs/security-model.md`](../docs/security-model.md)), and
  an Operator may not read captures. The Capture page re-reads its list on every capture job change
  and whenever the upload dialog opens, and `begin_capture_upload()` decides any replace on the
  server, so a page that has not caught up cannot replace a capture it never showed.

- **`telemetry` is unpublishable, not merely unpublished.** It is a `postgres_fdw` foreign table
  whose rows enter TimescaleDB's WAL, never Supabase's. Adding it to the publication does not
  error — it silently emits nothing, which is the worse failure. **Do not "fix" the telemetry
  inspector (`modals/TelemetryModal.jsx`) by subscribing it.**
- **Never delete `usePolling`.** Realtime has no replay: a dropped socket loses every change in the
  gap and the client is not told. The 60 s poll is also the only path carrying the exponential
  backoff, and the only one that reports a refresh's outcome (see **When the dashboard stops
  updating** below).
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

### When the dashboard stops updating

A page that keeps its last rows after the API has gone looks live, and people act on it. So every
poll and every Realtime channel reports into one module, `lib/connectionState.js`, and the shell
shows `common/ConnectionStrip.jsx` under the top bar once a failure has lasted
`STALE_AFTER_MS` (10 seconds). The tab title then leads with "Not updating · ", for a background
tab; the strip is the signal that matters, because full screen and pinned tabs hide the title.

- **Two flags, each cleared only by its own kind of success.** A poll that fails with a network
  error, a 5xx or a PostgREST connection error, or the browser's `offline` event, sets the refresh
  flag; the next poll that succeeds clears it. A channel's `CHANNEL_ERROR` or `TIMED_OUT` sets the
  Realtime flag; only `SUBSCRIBED` clears it. Coming back online clears nothing by itself, but
  every waiting poll then runs within `ONLINE_RETRY_JITTER_MS` (1 second, spread at random so the
  pages' polls do not land together) instead of at its next turn, which with Realtime on is up to a
  minute away; the first success clears the strip.
- **The refresh flag counts at once; the Realtime flag only once no poll has succeeded for
  `REALTIME_RECONCILE_WINDOW_MS` (90 seconds).** Every Realtime page pairs its channel with a
  60-second reconcile poll (`refreshInterval(true)`), which keeps bringing data while the channel is
  down, so "Not updating" would be false. Letting each poll clear a Realtime failure instead made
  the strip show for 50 seconds and hide for 10 in every cycle, which on a wall display is worse
  than either steady state. The threshold counts from when the connection became failing under
  this rule; "since" is still the last refresh that worked.
- **What does not:** a 4xx other than 401. The server answered, so the connection is not the
  problem, and a page that never loads for one role should not claim the network is down.
- **The status is mostly gone by the time an error reaches a poll.** supabase-js returns a
  PostgREST error without its HTTP status, a non-JSON proxy body (Envoy's "no healthy upstream")
  as a bare message, and a fetch rejection as "TypeError: Failed to fetch"; `api.js` sometimes
  rethrows only the message. `classifyRefreshError()` therefore reads the status where there is
  one, then the PostgREST code, then the message.
- **A 401 says "Your session has ended."** with **Sign In Again**, which is the rejected-session
  path `App.jsx` already uses (`clearInvalidSession()`, then the sign-in screen). The poll keeps
  going at its longest interval instead of stopping, so a token the auth client refreshes a moment
  later gets through and clears the strip. The strip lives in the signed-in shell, so it never
  shows over the sign-in page, and the state is reset when the shell mounts and unmounts.
- **Device status is not touched.** The chips still show the stored status; the strip is what says
  it may be stale.
- **The strip takes its own row**, so it covers nothing. Below 800px a drawer overlays the page
  from a fixed `top`; the strip publishes its height as `--connection-strip-height` on the shell so
  the drawer starts below it.

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

### The Content-Security-Policy names what a page may load

The chart sends the dashboard's policy from nginx, built from the same addresses as `/config.js`
([`help/site/running-the-server.md`](../help/site/running-the-server.md#what-a-browser-may-load-the-content-security-policy)
lists each directive). Under it, the browser refuses:

- a request to an origin `/config.js` does not name: a new `fetch`, image or WebSocket elsewhere;
- an inline `<script>`, an event-handler attribute, or `eval`;
- a `<style>` element, or a `style="..."` attribute in parsed markup. React's `style` prop and
  Lit's adopted stylesheets are not affected.

The one inline stylesheet admitted is the 3D viewer's, by its hash. Check 68 of
`scripts/check-docs-drift.mjs` fails when an `@google/model-viewer` upgrade changes it, and names
the new hash. `node test-harness/csp-walk.mjs` walks every page against a running stack and lists
each refusal. `npm run dev` sends no policy, and nor does the image without the chart.

### The bundle's version and the release's are two different facts

`src/version.js` states what **this bundle** is, baked at image build, and is the one setting that
deliberately has no runtime twin — a deployment must not be able to claim a version its bundle is
not. `VITE_RELEASE_VERSION` states what **the release** is, `Chart.AppVersion` arriving through the
same ConfigMap as everything else.

`utils/releaseVersion.js` compares them and the account menu shows a line under the version when
they disagree: *Update available — 1.5.1*.

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
  (`v1.5.0-12-g04374f9-dirty`), so anything stricter would warn on every dev cluster permanently.
- **It is a statement, not a button.** Nothing in a browser can upgrade the stack; the upgrade is
  [`docs/upgrades.md`](../docs/upgrades.md).

Unknown renders nothing, and that is the point: an unlabelled build, or a plain image build that
supplies no release version, is not evidence of drift.

---

## Routing

**The address names the view on screen**, so a view can be bookmarked, shared, reloaded and walked
back with Back. There is no router library: `hooks/useAppRouting.js` reads the page from the first
path segment, and `hooks/useUrlState.js` holds everything below it.

| Part of the view | Where it lives | Example | A change |
| :--- | :--- | :--- | :--- |
| Page | first path segment | `/devices` | adds a history entry |
| Tab | second path segment, `useUrlTab(page, ids, fallback)` | `/devices/quarantine` | adds a history entry, so Back returns to the previous tab |
| Filter | query parameter, `useUrlState(key, default)` | `/devices?lifecycle=archived&gateway=<id>` | rewrites the current entry, so Back does not replay each keystroke |
| Table sort | query parameter `sort`, `useSortableRows` ([Sortable tables](#table-and-row-conventions)) | `/gateways?sort=-last_heartbeat` | rewrites the current entry |
| Open drawer | query parameter, `useUrlState` | `/devices?device=<uuid>` | rewrites the current entry |

- **Defaults are left out**: `/devices`, not `/devices/registered?lifecycle=active`. A value the
  page does not offer reads as the default, and the address is tidied to match. A list that loads
  (gateway ids, settings categories) passes `allowed: null` or `ready: false` until it arrives, so a
  good value is not tidied away first.
- **A tab change drops the query**, so each tab opens on its own defaults. `keep` names the filters a
  page shares across its tabs: the Vocabulary search, and Capture's stored filter and search.
- **`useUrlState` returns `[value, setValue]`**, as `useState` does. A setter reads the address when
  it runs, so several setters called in one handler compose.
- **A new tab needs only an entry in its page's list**, in `navigation.jsx` (`DEVICES_TABS` and the
  rest), which holds its id, its name and its tooltip; the page, the rail and the search all read
  it. `useUrlTab` returns `[tab, setTab, hrefFor]`: `hrefFor(id)` is the address `setTab(id)` goes
  to, kept filters included, and it is what the tab bar's links carry.
- **A rail click goes to the bare page**, so nothing a drill-down set comes along. A drill-down goes
  to an address built in `routes.js` (`deviceUrl(id)` is `/devices?search=<id>`); the page reads its
  filters from it, and `useArrivalSelection` opens the drawer on an exact id.
- **The rail's entries and the drill-downs are real links**, `common/RouteLink.jsx`: an `<a href>`
  that navigates in place on a plain click and leaves Ctrl, Cmd, Shift and middle clicks to the
  browser, which opens a new tab. A `ContextPanel` action takes `to` for the same, and the tab
  bar's tabs follow the same rule ([Tabs](#tabs)).
- **A hand-over that carries an object stays state.** The Vocabulary page's Use
  (`pendingVocabularyEntry`) opens Add Metric prefilled: an act to perform once, not a view.
- **Nothing goes in the address that should not be in a log**: nginx writes query strings to its
  access log. Search text and ids are fine.
- **Any path loads.** nginx serves `index.html` for any path (`try_files`), and every asset URL is
  absolute (Vite's `base` is `/`). An address carrying the sign-in callback's `code` or `state` is
  left alone for supabase-js to read.
- **Tests start at `/`** (`src/test/setup.js`). A test that needs a view sets the address before it
  renders the page.

| Page | Tabs in the path | Query keys (drawer last) |
| :--- | :--- | :--- |
| Site Map | | `archived`; the panel: `area`, `cell` or `lane` |
| Areas | | `search`, `lifecycle`, `sort`; `area` |
| Cells | | `search`, `lifecycle`, `attention`, `empty`, `sort`; `cell` |
| Gateways | | `search`, `lifecycle`, `status`, `type`, `quarantined`, `sort`; `gateway` |
| Devices | `quarantine` | `search`, `status`, `attention`, `lifecycle`, `type`, `schema`, `gateway`, `cell`, `replay`, `sort`; `device` |
| Audit Trail | | `search`, `type`, `action`, `range`, `since`, `until`, `deleted`; `event` |
| Schemas | | `search`, `status`, `sort`; `schema` |
| Metrics | `deprecated`, `uncatalogued` | `search`, `standard`, `unmapped`, `sort`; `metric`. Uncatalogued: `name`, `sort` |
| Vocabulary | the standard, as a slug (`opc-ua`) | `search` |
| Approvals | `decided` | `kind`, `search`, `sort`; `proposal` |
| Capture | `device` | `stored`, `search`, `gateway`, `sort`; `subject` |
| Archives | `retired` | `sort` |
| Directory | the group | `sort` |
| Access Control | `credentials`, `identities`, `accounts`, `roles` | Every tab: `sort`. People: `search`, `role`, `status`, `removed`. Broker credentials: `search`, `state`, `archived`. Machine identities: `search`, `withdrawn`. Broker roles: `broker-role` |
| Backups | | `status`; `run` |
| Settings | the category, as a slug (`cold-storage`) | `setting`, the search bar's highlight |

---

## Tabs

**A page has one card.** Its title and description are the card's `CardHeading`. The seamless tab bar
(`common/TabStrip.jsx`, one underline style, no pills) sits under the heading and shows one tab's
content at a time; the card scrolls, the page does not. Each tab explains itself in a tooltip, its
`description` ([Tooltips](#tooltips-on-a-tab)), so the bar holds the tabs and nothing after them.
Under the bar is a toolbar row, the existing `.filter-bar`, drawn only when the tab has
filters or actions: its filters first, its actions in `.filter-bar-actions` at the right. Tabs carry
no counts. A tab with work waiting takes `attention={n}`: the label turns
the warning colour and gains an icon and the number, only while n is above 0. A row that outgrows one
line keeps search, status and the key toggle and moves the rest into `common/FiltersPopover.jsx`.

**The tabs are links, not the WAI-ARIA tabs pattern.** The bar is a `<nav>` named for the page,
holding an `<a href>` per tab, the open one `aria-current="page"`. The tabs pattern is for panels
within one page, and each tab here is an address of its own with a history entry
([Routing](#routing)), so changing tab is navigation. As links, a tab opens in a
new browser tab with Ctrl-click or middle-click, and "Copy link address" works; a plain click still
changes tab in place, through the page's `onChange`, so any reset the page does still happens. Each
tab is its own Tab-key stop and the arrow keys do nothing: `[` and `]` step between tabs from
anywhere on the page ([The toolbar](#the-toolbar)). The tabs pattern was dropped because each tab
gained an address; bringing `role="tab"` back would first need a case against the addresses.

```jsx
const [view, setView, viewHref] = useUrlTab('devices', DEVICES_TABS.map(t => t.id), 'registered')

<div className="card">
  <CardHeading title="Devices" description="…" />
  <TabStrip ariaLabel="Devices" value={view} onChange={setView} hrefFor={viewHref}
    tabs={DEVICES_TABS.map(t => (t.id === 'quarantine' ? { ...t, attention: waiting } : t))} />
  {/* Only a tab with filters or actions draws this row. */}
  <div className="filter-bar">
    <SearchInput … />
    <FiltersPopover activeCount={extraCount} onClear={clearExtras}>{/* the other controls */}</FiltersPopover>
    <div className="filter-bar-actions"><button className="btn btn-sm btn-primary">New …</button></div>
  </div>
  {/* the tab's content */}
</div>
```

| Tab | Notes |
| :--- | :--- |
| `SiteMapTab` | The Site Map page (tab id `site-map`), one card: the enterprise (the gateways' Sparkplug group) and the site (the `site.name` setting) named at the top, then **Site-Wide, Simulated and Unassigned as three coloured lanes** that open the context panel, then every area in service drawn as its plan (`common/AreaPlan.jsx`) with its cells as pins (archived areas only under **Show archived areas**; `?area=<id>` opens on one), one to three areas to a row by how many there are. Read only: nothing is filed or placed here. One context panel serves a lane, an area (its cells, gateways and devices as chips) or a cell; cells in no area sit in a tray under the grid. The counts the page used to carry are the rail's signals (`hooks/useNavSignals.js`) |
| `AreasTab` | The ISA-95 areas. Cells are filed by dragging a chip onto an area row; unfiled cells sit in a queue row above the table. Devices are never filed here: a device's area is its cell's, or its own when Area-Wide. An area's SVG plan is managed from its details panel (`common/AreaPlanPanel.jsx`); a plan is parsed as the browser parses it before upload (`utils/areaPlans.js` `readSvgPlan`), so a file that would draw as nothing, or whose stated size is not the one the browser would use, is refused with the reason. An area is archived from its panel the way a cell is, through the shared `ArchiveModal`, and hidden behind the lifecycle filter; it is deleted only from Archived Entities |
| `CellsTab` | Cell management. Device membership is grouped from its own `/api/v1/devices` load. The area and the place on the area's plan are on the form; the place is picked by clicking the plan (`common/CellPlacementPicker.jsx`), which refuses a spot closer than `site_map.min_pin_spacing` to another pin |
| `GatewaysTab` | Every action is in the details drawer, with one primary listed first; **Restore replaces Edit** on an archived gateway. The seeded Playback gateway is listed like any other, and reads Playing back or Idle rather than Offline |
| `DevicesTab` | One card, tabs **Registered** and **Quarantine**. Quarantined devices render **on the Quarantine tab only** — `filteredAssets` excludes them before every other filter, so no filter combination can list one twice. The panel's **Export…** opens `modals/DeviceExportModal.jsx` (AAS JSON, AASX or Bundle), which Archived Entities opens too |
| `SchemasTab` | The schema registry: each schema, its versions and the devices on it. **Building from the catalog is the only way to create a schema**; changing one is versioning, not editing |
| `AuditTrailTab` | Audit trail. The log records what was true when each row was written, and the UI says so |
| `DirectoryTab` | The read-only registry of the services this deployment runs, a tab per group, with each one's version, address and reach |
| `ArchivesTab` | One card, a tab for each stage of one lifecycle. **Archived**: areas, cells, gateways and devices taken out of commission, with Restore, Permanent Delete (the one typed-name gate in the application) and, on a device, Export Bundle, which downloads the AASX with its history (`/api/v1/devices/asset-export`). **Retired**: the tombstones `retired_entities` holds for rows that were archived and then deleted, each linking to what survives it: the Audit Trail page with deleted entities shown, a gateway's forge repository, and any bundle taken while it was alive (`api.assetExportDownloadUrl`) |

---

## The toolbar

**Every page has one toolbar, in one place, with one look.** It is the `.filter-bar` row straight
under the `CardHeading`, or under the tab bar on a tabbed page, a direct child of the card. The
filters go on the left, **the search box first when the toolbar has one**, so the control people
reach for most is in the same place on every page; `toolbarSearchFirst.test.js` reads every
toolbar in the source and holds to it. The other filters follow in the page's own order. The
page's buttons go in `.filter-bar-actions` at the right-hand end: `ClearFilters` first, then other
buttons such as Export or a destination button, then the main button last. A legend that explains
the page, as on the Site Map, goes there too. The row runs edge to edge and is ruled off from what
is below it. A page or tab with nothing to filter and no buttons draws no toolbar.

**Actions are filled, filter controls are outlined.** Every action in `.filter-bar-actions` is
`btn-primary`: New Device, Export CSV, Play a file…, Take a backup, a destination button. A filter
control is `btn-ghost`, because it changes what the page shows rather than doing something: Clear
filters, Filters (n), Expand all, and an on/off toggle such as Needs attention, which is filled
only while it is on, so its look says whether it is. **Amber (`btn-warning`) marks a destination
that needs finishing**: Set a destination and Complete the destination. Backups shows two filled
buttons side by side, Change destination and Take a backup, with the main one still last. Only the
toolbar follows this rule: a side panel keeps exactly one primary action, and Discard stays
outlined beside Save. `toolbarActionsFilled.test.js` reads every `.filter-bar-actions` group in
the source and fails on an outlined button written into one.

`CardHeading` takes no buttons: it has no `actions` prop, and `cardHeading.test.jsx` fails on a
page that passes one. So a page's main button is in the same place whether or not it has tabs.

`/` focuses the open page's search box (`focusPageSearch` in `common/SearchInput.jsx`, bound in
`App.jsx` beside `?`). It finds the first shown `SearchInput` in a `.filter-bar` inside `main`, so a
search box added to a toolbar is reached with no wiring of its own. The top bar's search is outside
`main`, and Ctrl K owns it. The box shows a `/` hint while it is empty and unfocused, and App.css
draws it only where `/` reaches.

`[` and `]` move to the open page's previous and next tab (`stepPageTab` in `src/shortcuts.js`,
bound beside `?`). They find the tab bar the way `/` finds the search box, the first shown
`nav.tab-strip` inside `main`, its links and the one marked `aria-current="page"`, so a page with a
`TabStrip` needs no wiring. They click the tab, so the address, the history entry and the page's
own reset follow as they do for a click, then focus it, so a screen reader reads its name. They stop
at the first and last tab and do nothing on a page without tabs.

**One check decides when a shortcut may act** (`shortcutAllowed` in `src/shortcuts.js`). It stands
down in a text field, a select or a contenteditable, with Ctrl, Cmd or Alt held, and while a dialog
or popover is open: `role="dialog"`, `aria-modal="true"` or a native `dialog[open]`. AltGr passes,
though Windows reports it as Ctrl+Alt, because German, French and Nordic layouts type `[` and `]`
with it. Every shortcut is read from `e.key`, the character, never the key code. Ctrl K uses the
dialog part alone: with a dialog open it does nothing, rather than moving focus behind it.

**Single-key shortcuts can be turned off** (WCAG 2.2 SC 2.1.4, Character Key Shortcuts). `?`, `/`,
`[` and `]` are one character with no modifier, which speech input can type by mistake. Profile ›
Appearance has a Single-key shortcuts switch, on by default and saved in `user_settings`
(`singleKeyShortcutAllowed`). Ctrl K and the arrow keys are not character keys, so it leaves them
alone. While it is off, the shortcuts list stays one click away on the top bar's Keyboard shortcuts
button, and marks the four rows Off. `aria-keyshortcuts` names `?` on that button, `/` on the page's
search box (read from `SingleKeyShortcutsContext`) and Control+K or Meta+K on the top bar's search.
The first two, and the `/` hint, go while the switch is off. `[` and `]` are named on no element,
because the tab they open changes; the shortcuts list covers them.

---

## Words and rules

The words and rules every page follows, so a page is checked against one list rather than against
the page beside it. They were settled by the frontend consistency audit
([#579](https://github.com/Harri-Llewelyn/Aber/issues/579)) and amended by the 2026-10-01 review
([#629](https://github.com/Harri-Llewelyn/Aber/issues/629)). Change them here, not page by page.
Retired names are the other half of the record: check 19c of `scripts/check-docs-drift.mjs` refuses
them. Nothing checks this list, because a word that is allowed cannot be policed by a pattern.

| Thing | Use | Not |
| :--- | :--- | :--- |
| The Devices queue | Quarantine queue | Zero-Touch Onboarding Quarantine Queue, onboarding queue, the banner |
| Approving a queued device | Approve & Onboard | Approve & Assign |
| A device before its first birth | Awaiting first birth | Never sent a birth |
| A non-human principal | machine identity | database/service principal, service identity |
| A machine identity taken out of use | Withdraw / Reinstate, WITHDRAWN | Revoke(d) |
| A token or broker credential taken back | Revoke, REVOKED | Withdraw |
| Out of commission | Archived | Decommissioned, Out of Commission, Inaccessible |
| Archived Entities' two tabs | Archived, Retired | |
| The alert flag | WARNING | WARN |
| The shadow target for playback | Playback gateway | simulated gateway, replay lane, Shadow, Shadow lane |
| A shadow device | replay lane | SHADOW |
| The ISA-95 site | site | campus, as a name |
| A group of cells | area | building, floor |
| A cell | cell | cell zone, zone, work center |
| Any audited row | entity | asset, unless it is the shopfloor class |
| A filter's no-constraint option | Any … (Any gateway, Any status) | All … (All gateways) |

**Site and campus.** "Site" is the term: the page, the setting, the Site-Wide scope and the ISA-95
level all say it. "Campus" may gloss it in running text and tooltips, as in "the site is this
campus", but never names a control, a setting or an identifier. "Area" is used everywhere except
in "building management system".

- **Page identity.** A page has one card. Its icon, title and one-sentence description are the
  card's `CardHeading`, stated once; there is no `PageHeading` above it. A tabbed page puts its tab
  bar inside that card, and the tabs' tooltips and the toolbar row follow [Tabs](#tabs). Buttons go
  in the toolbar, never the heading ([The toolbar](#the-toolbar)).
- **Scroll.** Every page scrolls inside its card, Access Control, Directory and Approvals included.
- **Counts.** None on card headings, section headings or tabs. A count stays where it states what is
  loaded ("30 of 55" beside Show more), what a filter option or toggle holds ("Active (4)", "Show
  deleted entities (3351)"), what an export will write, or how much work is waiting (a Quarantine
  or Awaiting tab, the sidebar).
- **Queues are tabs.** Devices' quarantine queue is its Quarantine tab, not a card above the roster;
  a tab with work waiting takes `attention`.
- **Clear filters (N).** N counts every control that is off its default, the lifecycle select
  included. The button (`common/ClearFilters.jsx`) sits at the right end of the toolbar, first in
  `.filter-bar-actions` when the page has buttons.
- **Empty states** tell "none yet" from "none match".
- **Permission hints** name the roles that hold the permission ("Requires Administrator or Shopfloor
  Manager"), from one helper, never "Admin".
- **Clickable cues.** A chevron at the right end means it opens a side panel, and anything that
  opens one shows it: a table row through `row-selectable`, and a lane, card or line that is not a
  row through a trailing `IconChevronRight` in the shared chevron colours (`.area-card-chevron` and
  its siblings in `App.css`). The copy chip copies.
  Accent colour is a real link. A button acts. Monospace text takes the text colour. Nothing else
  looks clickable ([What looks clickable](#what-looks-clickable)).
- **Side panels.** The title carries the entity's icon, and there is exactly one primary action,
  listed first, picked in the order under [The drawer is `ContextPanel`](#the-drawer-is-contextpanel).
- **Tables.** Every header row, group band and section band is one opaque colour, `--bg-base`
  ([Table and Row Conventions](#table-and-row-conventions)).
- **Colour is never the only signal.** Tabs, sidebar flags, warning buttons and the Audit Trail
  markers each carry an icon, a shape or a number as well (WCAG 2.2 SC 1.4.1).
- **The sidebar** colours an icon only when the viewer can act on what it flags, and shows how many.
- **Archived things are hidden by default**, in every list and on the Site Map. A list opens on
  Active, archived rows are one filter away, and Archived Entities lists them all.
- **Sizes** use binary units labelled KiB and MiB. There is one relative-time style and one absolute
  date-time format (`utils/format.js`).
- **Help pages** state nothing wrong and name the page's main controls; they are not full manuals.
  A `HelpTip` is about 35 words or fewer, and a tab's tooltip 20 words at most.
- **Comments** state the current state only. An archived migration is cited as "archived migration
  NNNN", never as a bare number, which a live migration will reach; where that is ambiguous (the
  archive has two numbering schemes, and two files numbered 0074), cite the file name.

**Earlier decisions the 2026-10-01 review reversed**, recorded so the next audit does not undo them:
counts always showing, including on headings; Settings and Vocabulary keeping a `PageHeading`;
Access Control, Directory and Approvals scrolling the page; the Devices queue as a card above the
roster.

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

A help page uses the words in [Words and rules](#words-and-rules), as the page it describes does.

### One file per page, resolved by filename

[`help/pages/<tab id>.md`](../help/pages) at the top of the repository. `src/help/index.js`
bundles every Markdown file in `help/` with one eager `import.meta.glob` of `**/*.md` there,
and keys each by its path under `help/` without `.md`: `pages/devices`, `guides/tutorial`,
`site/install`, and `README` for the contents. The page for a tab is `pages/<tab id>`. There is no
manifest: a second list is the one that goes stale. `scripts/check-docs-drift.mjs` (check 16)
asserts the correspondence **in both directions** — every page in `navigation.jsx` has a file, and
every file names a page that exists. The second direction is the one that rots silently: a help
file left behind by a renamed page is never resolved again, and the renamed page quietly has none.

**The folder is the list.** [`help/`](../help/README.md) holds every page written for newcomers:
the install guide, the tutorial, the glossary and the page files. What the dashboard bundles comes
from that folder and from nowhere else, so a contributor document under `docs/` cannot reach the
bundle by accident. Everything in it ships, and `help/README.md` lists all of it (check 109).

**How the image build sees it.** `frontend/Dockerfile`'s build context is `./frontend`, which
holds neither `help/` nor `.git`. The build is handed `help/` as a BuildKit named context,
`--build-context help=./help`: `release.yml` passes it in the image matrix's `build-contexts`,
`scripts/dev-cluster.mjs` in its `docker build`, and the runbook's build command spells it out. The
Dockerfile copies the context to `/app/help` and builds from `/app/frontend`, so `index.js`'s
`../../../help` resolves the same in the image as in a checkout. A build not handed the
context stops at `COPY --from=help` with `pull access denied`: BuildKit reads `help` as an image
name. In a checkout, `vite.config.js` adds `../help` to `server.fs.allow`, without which the dev
server and vitest refuse to read a file outside this package. Drift check 105 holds the glob to
every file in `help/` and to nothing outside it, and check 106 holds every build of the image to
passing the context.

The pages are still free in CI: `ci.yml` classifies a diff with `*.md|docs/*`, and a `case` glob's
`*` spans directory separators, so a `.md` file anywhere skips the end-to-end stack
(`k8s-validation`).

### Parsed when the bundle is built, drawn by a walker

The glob imports each file with the `?help` query, and a small Vite plugin, `helpCorpus.js` beside
`vite.config.js`, answers it. The plugin parses the file with [marked](https://marked.js.org/), a
devDependency with no dependencies of its own, and hands the app the result as plain data:
`{ title, titleId, tokens }`. `title` is the text of a leading `# ` heading (the guides have one,
the page files do not), and the tree leaves that heading out because the drawer's title shows it.
At runtime `HelpMarkdown.jsx` walks `tokens` into React elements. The parser never reaches the
bundle (after `npm run build`, `dist/assets/*.js` has no `markedjs`), and nothing in the app uses
`dangerouslySetInnerHTML`, so there is no HTML sink for the next thing to be piped into. Vitest
runs the same plugin, so the suites see what the bundle sees.

**What the walker draws** is the list in `src/help/syntax.js`, which the plugin, the walker and the
drift check share. The tree's shapes:

| Node | Shape |
| :--- | :--- |
| Text | a plain string; a line break inside a paragraph is a space |
| Heading | `{ type: 'heading', depth, id, children }`: `##` is an h3, one level under the drawer's title |
| Paragraph; a tight list item's text | `{ type: 'paragraph' \| 'text', children }` |
| List | `{ type: 'list', ordered, start, items }`, each item an array of blocks, so lists nest |
| Code block | `{ type: 'code', lang, text }`, drawn with a Copy button (`copyText` from `CopyableId.jsx`) |
| Quote | `{ type: 'blockquote', children }` |
| Table | `{ type: 'table', align, header, rows }`, each cell an array of inline nodes |
| Rule | `{ type: 'hr' }` |
| Inline | `{ type: 'strong' \| 'em', children }`, `{ type: 'codespan', text }`, `{ type: 'br' }` |
| Link | `{ type: 'link', children }` with `help` and `anchor`, `repo` and `anchor`, or `href` |

A table and a code block scroll sideways inside the panel rather than widen it, and each is
focusable so a keyboard can scroll it. **Anything else stops the build**, `npm run dev` and the
suites, with the file and line: raw HTML, an image, a task list, strikethrough, an HTML entity
(GitHub draws `&amp;` as `&`, the walker would draw it as typed), or a link the panel cannot follow.
Drift check 108 finds the same without a build. Before the walker, an unsupported construct
rendered as its own source text, a defect the reader saw and the author never did.

**Heading ids are GitHub's.** A heading's id is GitHub's slug of its text, with `-1`, `-2` for a
repeat, as check 1 computes it, so a `#anchor` that works on GitHub works in the panel. The element
carries `id="help-<slug>"`, prefixed so it cannot meet an id of the page's, and `data-heading="<slug>"`,
which the panel scrolls to.

**Links.** Each is resolved against its file's folder, as GitHub resolves it (`resolveLink()` in
`syntax.js`):

- **To another file of `help/`**, or to `#heading` in the same one: it opens in the panel, at that
  heading. It is a `HelpLink`, an `<a data-help>` (below).
- **To anything else in the repository** (a component README, a chart file, a workflow, `docs/`): it
  opens on GitHub at the release this bundle was built from, in a new tab. A relative link would
  resolve against the dashboard's routes and 404. `src/help/links.js` names the ref: the tag `v<x.y.z>`
  when `VITE_APP_VERSION` is a release's version, and `main` for anything else (`git describe` output
  with commits after a tag, a dirty tree, no version). The repository is `GITHUB_REPO_URL`.
- **To another site**: a new tab.

The last two need the internet, which a shopfloor network often does not have, so `OnlineLink` marks
them: a globe and the word *online*, and an `aria-label` that says it opens a new tab and needs the
internet. Never a `title`. A local address, such as the laptop's `http://app.localhost` that the
install guide names, needs no internet and is not marked. Drift check 109 holds every link in `help/` to a file and heading that
exist, and `help/README.md` to listing every page exactly once.

### Contents, Back and search

The panel opens on the page's help, which follows the page as the person moves between tabs. Over
it, a search box, **Back** and **Contents**. A view is the page's help, a file at a heading, the
contents, or the search results (`HelpBrowser.jsx`). Back steps through the panel's own history,
not the browser's: the panel is not a route. A view Back returns to gets its scroll position back.
Closing the panel forgets the history, so the top bar's **?** always starts on the page's help.

**Contents** draws `help/README.md`'s own tree, after a link to this page's help. A page added to
that file is in the panel in the same section and order, with nothing else to edit. Help for
another language (#446) would be another set of files, and the contents and the search follow
whichever set is loaded.

**Search** covers every heading of every file in `help/`, and every block of prose under one: a
paragraph, a list item, a table row. `src/help/searchIndex.js` builds the index from the bundled
trees the first time it is asked for, so the corpus's text ships once. The matcher is written by
hand: lower case, split on anything that is not a letter or a digit, every term must start a word
of the entry (prose is read with its heading's words). It gives one result per heading, ranked
heading matches first, then prose; within each, the current page's first; then reading order. The
panel shows the first 20, as *heading · page* with the prose that matched. Choosing one opens the
file at that heading. The index and the matcher are exported for the top bar's search:

| Export | What it is |
| :--- | :--- |
| `helpIndex()` | every entry, `{ file, page, id, heading, kind, text }`: `file` a key of `HELP_FILES`, `id` the heading it sits under (`''` before the first), `page` the file's title, `kind` `'heading'` or `'text'` |
| `searchHelp(query, { currentFile, limit, index })` | ranked results, `{ file, id, heading, page, kind, snippet }`; `limit` defaults to `HELP_RESULT_LIMIT` (20) |
| `helpTerms(text)` | the matcher's split, for highlighting |

**The top bar's search has a Help group** (`GlobalSearch.jsx`). It calls `searchHelp` on the same
index, ranked for the open page's help file, and shows at most five results (`HELP_GROUP_LIMIT`),
so a common word leaves room for pages and records. The panel's own search lists the rest. The
group sits after the pages, cards and settings and before the records, under a Help label, and
waits for two characters as the name search does. A row is the heading, with the title of the page
or guide it is in beside it (none when the heading is that title). The arrow keys and Enter walk it
like any other row. Choosing one calls `openHelpAt(file, id)` and closes the search. The panel
opens itself on that call, so `App.jsx` needs no wiring for it.

### Opening help from anywhere

- **From code:** `openHelpAt(file, headingId?)` in `src/help/openHelp.js` opens the panel at a file
  (`'guides/tutorial'`) and heading. While the panel is open it is a step Back returns from. It
  returns false, and does nothing, for a file the bundle does not carry.
- **From markup:** a plain click on any `<a data-help="site/install">` or
  `data-help="guides/glossary#quarantine"`, anywhere in the app, opens the panel there instead of
  following the link. `HelpPanel.jsx` takes it at the document. Give the link a real `href` as the
  fallback; `HelpLink` (`components/common/HelpLink.jsx`) renders one, the file on GitHub at this
  release. A Ctrl, Shift or middle click, and a file the bundle does not carry, follow the href.
- **From inside a dialog**, by either route: a modal dialog makes the rest of the page inert, so the
  panel could be neither read nor reached. The help opens in a dialog of its own over that one,
  with the same search, Back and Contents, and closing it returns to the dialog beneath.

### The drawer is `ContextPanel`

The same component the entity pages use, with `subject="help"` for its region label and close
control. It is a sibling of `.content` rather than of a page's list, so it survives a tab switch,
works on pages that have no drawer of their own, and cannot be unmounted by the page it describes —
`tabId` follows the active tab, so it re-reads as you navigate. Every drawer, this one included,
stays beside the page down to 800px wide; narrower, it slides over the page as a dismissible
overlay.

**One drawer at a time below 1440px.** From 1440px wide, help opens beside a page's drawer and the
flex row narrows the page between them. Narrower, help replaces the page's drawer:

- **Opening help hides the page's drawer without closing it.** The page keeps its selection, and
  closing help (its X, Escape, or the top bar's ?) shows the same details again. Escape closes the
  most recently opened drawer first, so with help opened second it closes help. The hiding is CSS,
  `@media (max-width: 1439px)` in `App.css`, and `display: none` also takes the hidden drawer out of
  the tab order and the accessibility tree.
- **Selecting a row, a pin or a lane while help is open closes help** and shows the details, rather
  than changing a panel nobody can see. A page's `ContextPanel` that opens or turns to another
  entity calls the App's `HelpDrawerContext` when `ONE_DRAWER_QUERY` matches. The help drawer sits
  outside that provider. The query and the media query must agree; `contextPanel.test.jsx` checks
  that they do.

**The help drawer docks; a page's drawer floats.** Help belongs to the app's frame, like the rail,
so it is drawn as the rail's mirror: flush with the window's right edge under the bar, on the rail's
`--bg-surface`, with one border on the page side and no margin, rounding or shadow. A page's drawer
belongs to the list beside it and stays a card, with its border, rounding and shadow. With both
open, the look is what tells them apart. Below 800px help is an overlay and keeps the shadow, as
the rail does when it opens over the page.

**Where 1440px comes from.** A drawer is `--context-panel-width`, `clamp(320px, 28vw, 560px)`. With
the rail collapsed (52px), the page's column is the window less the rail, the 12px gutter either
side of the page, and the page's drawer with its 16px gap. The docked help drawer adds no margin:
`W − 92 − 2 × clamp(320, 0.28W, 560)`. Between 1143px and 2000px that is `0.44W − 92`, which
reaches 500px at 1346px. A card in the column loses another 48px to its border and padding. The
Site Map card body measured 552, 411, 168 and 108px at 1600, 1280, 960 and 900px wide with both
drawers open, while help still had a 12px margin; docked, each is 12px wider. At 1440px the
column is 542px (Gateways, measured docked) and a card's body about 494px.

**The threshold stays at 1440px, though 1366px now clears 500px.** Two drawers on a 1366px laptop
would leave a 509px column and a card body of about 461px. That is 9px over the line, and a body
narrower than the 480px that 1440px was first chosen for. Moving the threshold would change what
the commonest laptop width does today, where help replaces the page's drawer, for those 9px. So
`ONE_DRAWER_QUERY` stays `(max-width: 1439px)`. The expanded rail (232px) takes 180px more at
every width; the threshold does not move with it.

**Expand widens help to half the window**, for the guides' tables and commands. The toggle sits in
help's header before the X, in ContextPanel's `headerActions` slot. No page's drawer has one.

- **Half the window, with the page beside it.** Expanded, help is `--context-panel-width-expanded`
  (`50vw`), and the page narrows beside it as it does when help opens. With the rail collapsed that
  is 720px of help and a 668px page at 1440px wide, and 683px and 631px at 1366px. Help's own
  `<aside>` redefines `--context-panel-width` (`.context-panel-app.context-panel-expanded`), so a
  page's drawer keeps its width. Below 800px the expanded overlay takes the whole width.
- **Expanded help replaces a page's drawer at every width**, as docked help does below 1440px. A
  rule beside that media query hides the drawer without closing it, and a page's drawer that opens
  or changes subject closes help: `HelpDrawerContext` carries `{ close, expanded }` for that.
  Pressing Expand is not such a change. It hides the details and leaves help open, and shrinking
  help shows them again.
- **One name for the toggle.** It is "Expand the help panel" with `aria-pressed`, as a toggle's
  name should not change with its state. Its tooltip (the shared `useTooltip`) says "Shrink the
  help panel" while pressed, and is not also its description.
- **The choice is this browser's**, in localStorage under `aber_help_expanded` (`on` or `off`,
  `hooks/useHelpExpanded.js`). It is not in the `user_settings` row: the width that suits depends
  on the screen.
- **Wide content still scrolls inside its own box.** A table or command wider than the panel
  scrolls sideways in `.help-table-wrap` or `.help-code pre`, expanded or not. The inner shell holds
  the drawer's width, so nothing on a help page can widen the drawer.
- **Help opened over a dialog has no Expand.** It is a `Modal` of size `lg`, and keeps that size.

**Its contents are mounted only while it is open**, which the per-page drawers do not need to do.
The panel stays in the DOM so its width can transition, but a page of prose whose first line is the
page name put a second *"Devices"* into the document on every page — a duplicate for find-in-page
and for anything reading the document as text. `aria-hidden` kept it out of the accessibility tree;
nothing was keeping it out of the text.

**Icon and primary action.** `icon` (a node) is drawn before the title and hidden from assistive
technology; the title stays the accessible name. The first action marked `primary` is listed first
and highlighted; a later one marked `primary` renders as a plain action in its own position. A page
picks its primary in this order: setup while a gateway is pending; otherwise the destination where
one exists (Launch UI, Open Dashboard); otherwise Restore when archived; otherwise Edit Details
(Propose a Change in propose mode).

---

## Toasts and the notification history

`showToast(msg, type)` (`hooks/useToast.js`) is the one call every page makes, with `type` one of
`success` (the default), `info`, `warning` or `error`. Each call puts a toast in the bottom-right
corner and records the same message in the history behind the bell in the top bar, unless it
passes `{ record: false }`, as a Grafana alert does.

- **Three groups, and the group is not the severity.** Every message is in one group: **Info**
  (routine news, successes included), **Warning** (the dashboard's own failures and warnings) or
  **Alert** (a Grafana alert, firing or resolved, whatever its severity). `success` and `info`
  default to Info, `warning` and `error` to Warning, and a caller passes `{ group }` only to
  override that: `usePlatformAlerts` passes `'alert'`. The group picks the icon (`GROUP_ICONS` in
  `common/Toast.jsx`: `IconInfo`, `IconAlertTriangle`, `IconShieldAlert`, the firing partner of the
  pill's resting shield), and Info and Warning are the notification filter's groups. Alert has no
  filter, because alerts are not recorded (below). The type is still the severity: it sets the
  timer and the live region, so a critical alert (`error`) stays until dismissed and is read out
  assertively, and within the group it picks the icon's colour (`toastTone`): Info is `--accent`;
  Warning is `--danger` for a failure and `--warning` otherwise; Alert is `--danger` critical,
  `--warning` warning and `--success` resolved. A success has no tick: its words say it worked.
- **A calm card.** A toast is `--bg-card` with the plain `--border` and `--text-primary` text, like
  the panels it floats beside. Only the signal is coloured: the icon, and a 3px stripe on the
  leading edge (an inset `box-shadow`, as Carbon's low-contrast notifications draw it), both from a
  `signal-tone-*` class whose icon colour the history's rows share. Each tone clears the 3:1 an icon
  needs on the card (WCAG 1.4.11); the light theme's amber is the tightest at 3.19:1. The four types
  used to tint the whole card and set the text in the signal colour, so a failure was red text on
  red, and a critical alert looked like a failed save.

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
  rest in `role="status"`. Each message is prefixed with its group in text only a screen reader
  reads ("Info:", "Warning:", "Alert:"), and a failure with "Error:" (`spokenPrefix`).
- **The history** (`common/NotificationHistory.jsx`) keeps the latest 50 messages, newest first. A
  repeat of the newest entry is counted on it rather than filling the list. The bell's badge counts
  the unread entries, is not rendered at zero, and takes the tone of the worst unread entry; a
  success leaves it neutral. Opening the list reads what it shows, dismissing a toast reads its
  entry, and a toast that times out stays unread. The list is a `role="dialog"` popover built like
  the alert pill's (`useEscapeKey`, `useClickOutside`): focus moves into it as it opens, and Escape
  or its close button hands focus back to the bell.
- **The filter.** Under the heading, sticky with it, a `SegmentedControl` offers All, Info and
  Warnings in one outlined pill, sharing the panel's width. Each segment shows its icon and its
  name. Its count is in its tooltip and its accessible name ("Info, 3"), which starts with the
  visible word, so someone using voice control can say "Info" (WCAG 2.5.3, Label in Name).
  It is back on All each time the panel opens, because opening reads what the list shows: a filter
  left on would hide entries that opening then marked read. While a filter is on, only the entries
  on show are read (`markRead(ids)` in `useToast`), so one that arrives in another group stays
  unread until All is chosen. An empty group says so, and Clear still empties the whole list, which
  its tooltip says while a filter is on. The list's footer, its empty state and the bell's tooltip
  say that Grafana alerts are in the alert counter.
- **`common/SegmentedControl.jsx`** is one choice from a few as a pill: on its own a
  `role="radiogroup"` of `radio` segments, one Tab stop whose arrow keys move and choose (the WAI-ARIA
  radio group pattern); with `menu`, a `role="group"` of `menuitemradio` segments for use inside a
  `role="menu"`, where each is a Tab stop like the menu's other items and Left and Right move without
  choosing. Every segment draws its icon and its `label`; an option's `count` is said after the label
  in the tooltip and the accessible name. The chosen segment takes a sunken fill (`--bg-base`) and a
  border, so the choice is not shown by colour alone (WCAG 1.4.1), and its icon takes the option's
  `tone`. Tooltips are the shared bubble (`common/Tooltip.jsx`): an option's `description`, tied by
  `aria-describedby`, as the Sidebar layout switch's segments are; otherwise the name with its
  count, which the label does not show; and none where the label says it all, as on the theme
  switch.
- **Where it is kept.** In `sessionStorage` under `aber_notification_history`, so it survives a
  reload and stays in that browser tab. It holds text only (the message, its group and its
  destination), and every read and write is wrapped so a blocked store degrades to memory. `App` clears it whenever the tab is left without a
  session (Sign Out, a sign-out in another tab, a rejected stored session), so the next person to
  sign in there starts with an empty list. Nothing goes to the server: most entries never touched
  it, and an unread state that followed a user between browsers would need a per-user table with
  RLS. Supabase Queues (pgmq) does not fit that either, because a queue is single-consumer and
  cannot fan one event out to several signed-in users.
- **Grafana alerts are toasts only.** `usePlatformAlerts` passes `{ group: 'alert', record: false }`
  for a firing and a resolved alert. The toast shows, with the Alert group's icon and colour and a
  link to the rule, but nothing is recorded, so the bell's badge never counts what the alert
  counter already counts. `readStoredHistory` drops any Alert entry a tab stored before this. The
  counter shows what is firing now. Grafana's alert history (Alerting > History,
  `GRAFANA_ALERT_HISTORY_URL`, linked from the counter's footer) is the record of what fired and
  cleared, including an alert that came and went while nobody was looking. That page needs
  Grafana's alert state history in Loki (`grafana/README.md`).
- **A firing alert toasts its name only.** The summary can be several sentences with a SQL
  statement, which stacked as tall blocks, kept a warning up longer and was read aloud in full by
  the `role="alert"` region. The summary is in the alert counter's list.
- **A message links to what it is about.** `showToast(msg, type, { to })` takes a destination as
  text: a path from `routes.js` or a Grafana URL. It is stored with the history entry, so the toast's
  message and the list's row are both links (`MessageLink` in `common/Toast.jsx`). A path is a
  `RouteLink`: a plain click navigates in place, and Ctrl-click or a middle click opens a new tab.
  Grafana opens in a new tab with the external-link icon, as the alert pill's platform-wide rows do,
  and needs the browser to reach `VITE_GRAFANA_URL` as those rows already do. Following a toast's
  link dismisses it; a plain click on a row's link (or any click on a Grafana one) closes the list.
  The tooltip names the page and tab (`destinationTitle`). `isSafeDestination` checks `to` as the
  message comes in and again as the history is read back: one leading `/` (never `//`), or the
  configured `GRAFANA_URL` followed by `/`, `?` or `#`, and no space, control character or
  backslash, which browsers strip or read as a slash. Anything else is dropped and the entry stays
  plain text, so nothing stored can become a `javascript:` or off-site link. This replaced
  `onOpen`/`openTitle`, a function the history could not store; a firing alert's toast used to open
  the pill's list, and the pill no longer takes `open`/`onOpenChange` from `App`.
- **Every message about a record links to it** (#1019), because the list is read later, from any
  page: "Cell 'Bay 3' created" is a link to the cell however long after the save it is read. So a
  message names its record ("Cell created" would be no help in the list), and passes `to` from
  `routes.js`: the record's page with its drawer open (`cellUrl`, `areaUrl`, `deviceUrl`,
  `gatewayUrl`, `schemaUrl`, or `entityUrl(type, id)`), a proposal on Approvals (`proposalUrl`,
  which `proposalNotice` in `utils/proposeFromForm.js` builds with the message), a metric
  (`metricUrl`), a setting (`settingUrl`), a capture's subject (`captureSubjectUrl`), a backup run
  (`backupUrl`), a person or a machine identity on Access Control (`personUrl`, `identityUrl`). A
  plan attached goes to the area on the Site Map (`siteMapAreaUrl`), where it is drawn. A Grafana
  alert goes to its rule (`grafanaAlertUrl`), a device new to the Quarantine queue to
  `tabUrl('devices', 'quarantine')`, and an AAS export's warning about metrics with no semantic id
  to `unmappedMetricsUrl()`, which `App` passes only to a reader who has the Metrics page. An
  arrival at an archived device or gateway turns the list's lifecycle filter to All, as Cells and
  Areas already did, so the record is in the list as well as the drawer. What links nowhere: a
  record that is gone (a permanent delete, a discarded draft, a rejected quarantined device, a
  deleted capture), a file (downloads and exports), the clipboard, the person's own password, and
  a failure of what was just tried, since the person is still on the form; a failure whose fix is
  elsewhere still links there. `__tests__/notificationLinks.test.js` reads every `showToast` call:
  one that is not an error passes `to`, or is in its `NO_LINK` list with the reason.
- **It is not the alert pill.** The pill says what is firing now, and its count is a reason to act;
  it drops only when Grafana resolves the alert. The history says what the dashboard said, and its
  count drops when the list is opened. One badge cannot follow both: if opening the list cleared
  it, a critical alert still firing would vanish from the bar, and if it did not, routine messages
  would add to the alarm's number. So each counts its own, and an alert is counted once, by the
  pill.

---

## Theming

Colours come from **CSS variables in `App.css`** (`:root` / `[data-theme="light"]`). There is no
Tailwind in this project. Prefer `.card`, `.form-control`, `.form-label` over inline colour styles.

Three rules that were each learned from a real bug:

- **Write a colour only in the two theme blocks.** Every other rule, and every `style={{…}}`, takes
  a token: `var(--warning)`, a tint token (`--success-tint`, `--warning-tint`, `--danger-tint`, or
  `--accent-dim` for the accent), or a tint of a token,
  `color-mix(in srgb, var(--warning) 12%, transparent)`. 47 rules once wrote the dark theme's colour
  with an alpha, so the light theme tinted its badges, chips and toasts in the dark theme's colours.
  `colourLiterals.test.js` fails on a hex, `rgb()`, `rgba()` or `hsl()` value outside the two
  blocks, in any other stylesheet under `src/`, and in any inline style. A token whose value holds
  `var()` resolves on the element that declares it, so a tint token is declared in both blocks.
  `themeContrast.test.js` reads each tint from the rule that paints it and measures the text on it
  in both themes.

- **A floating surface needs an opaque background.** A toast floats over arbitrary content, so its
  `rgba(…, 0.15)` tint once composited against whatever table was underneath. A toast is now an
  opaque `background-color: var(--bg-card)` with no tint at all, and the bell's unread badge paints
  its tint as a `background-image` over that same opaque colour. **Never fold the badge's into the
  `background:` shorthand** — that resets `background-color` and brings the transparency straight
  back. `themeContrast.test.js` asserts the toast's opaque base and both halves for every badge tone.
- **Do not give `var()` a hardcoded fallback.** The sign-in card rendered white-on-white in light
  mode because it referenced `--text-main` / `--bg-main`, neither of which exists; the fallbacks
  made the typo look correct in dark mode and fail silently in light mode.
  `authScreenTheme.test.jsx` now asserts that every variable referenced in `App.jsx` is one the
  stylesheet defines.

**A panel that opens from a button points at it.** The alert list, the notifications, the account
menu and the Filters panel share one radius (`--radius-sm`), one shadow
(`--shadow-popover`) and one arrow rule (App.css, *Popover arrows*): a 10px square turned 45°,
centred on the panel's border on the side that faces the button, so the outline runs on into the
point. It is pure CSS, as each panel's position is already known: a placement library such as
Floating UI would add only what these panels have. The arrow is the wrapper's `::after`, shown with
`:has(> panel)` while the panel is open, because the alert, notification and account panels clip or
scroll their own overflow; the Filters panel clips nothing and draws its own `::before`. The top-bar
arrows point up from `left: 50%` of the wrapper, so they follow the pill as its count widens it. The
account menu is `position: fixed`, and so is its arrow: it points left from the panel's left border,
60px or 240px, 65px above the window's bottom, the centre of the account row over the foot's
padding and its 34px Collapse all tabs row. Change the foot's padding or its rows and that number
moves with it. The Filters panel
is shifted to stay inside the window, so `FiltersPopover` sets `--arrow-x`, the button's centre from
the panel's left edge, and the arrow stays over the button. `popoverArrows.test.jsx` holds the rules
to these numbers; jsdom lays nothing out, so screenshots are the check that they line up.

---

## Table and Row Conventions

- **Constrain cells holding variable-length data.** `.table-wrap` scrolls horizontally, so an
  unconstrained cell pushes the row's action buttons off-screen. This has bitten the quarantine
  queue twice.
- **Every table header, group band and section band is one opaque colour, `--bg-base`**, sticky or
  not. A tint (`--bg-glass`, or the card colour mixed with text) was tried and either vanished on a
  white card or showed rows through a pinned header. A header never takes an inline background.
- **Group and section headings pin to the top of their scroller** while their own rows are in
  view: `.table-group-row` (Metrics) and `.vocab-section-head` (Vocabulary). A group row sits below
  a pinned `thead` at `--table-head-height`, which `.table-scroll` and `.card-fill > .table-wrap`
  set to the header's fixed height (12px padding twice plus a 16px line, so keep header cells on one
  line). It works the same whether the scroller is a `.card-fill` card body or a `.table-scroll`.
- **A row that opens a side panel has `row-selectable` and shows a chevron.** The CSS draws it on
  the row's last cell as a mask, reserving space on the right; a row without the class shows none.
  Row click opens the panel; a click on a button, link or input inside the row does not
  (`rowSelectHandler`).
- **A table can be sorted by its columns** (#801). The rows go through
  `useSortableRows(rows, columns)` (`hooks/useTableSort.js`) and each sortable header is a
  `<SortHeader sort={sort} column="name" title="…">Name</SortHeader>` (`common/SortHeader.jsx`).
  Its `title` is the column's hint, said once in the shared tooltip ([Tooltips](#tooltips)); a
  header that cannot be sorted takes one as a `ColumnHeader`.
  A click sorts ascending, a second descending, and a third returns the table to the order it had,
  which is left as it was: a table nobody sorts reads as before, and no header claims that order.
  - **A column sorts by what it means, not by its text** (`utils/tableSort.js`): `text` in natural
    order ("Line 9" before "Line 10"), `number`, `time` by instant, and `rank`, a number the column
    works out. A status ranks by its badge's colour, `severityRank(tone)`, so ascending puts red and
    amber first; a status with a fixed order of its own (Cold Storage's export sequence) uses
    `rankIn(order, value)`. A column sorts on the value its cell shows, so a count column counts
    what the cell counts.
  - **An empty cell goes last** in either direction: Never, no gateway, a dash that stands for no
    value. A count of zero is a number, even where the cell shows it as a dash, so it sorts as 0.
    Rows that compare equal keep their default order.
  - **A column with no order between its rows is not sortable**: actions, an icon, a list of chips
    another column counts, or a value column whose rows are different metrics in different units.
  - **The sort is in the address**, `?sort=name` or `?sort=-name` for descending. A page shows one
    table per tab, so the key is always `sort`, and a tab change drops it with the other filters.
    A component that holds several tabs' tables passes `{ active: tab === '…' }`, so a hidden
    table neither reads the sort nor tidies away one meant for the table on screen. A table in a
    modal has no address and uses `useLocalSortableRows`.
  - **Groups sort inside themselves.** The Metric Catalog's group bands keep their order, and
    `useTableSort(columns).apply(rows)` sorts each group's rows.
  - **A table loaded a page at a time from the server keeps its order** and has no sortable headers:
    sorting in the browser would sort only the rows on screen. Backups is the one such table.
  - **The arrow hangs in the header cell's right padding**, so a sortable column is no wider than it
    was and the header keeps its one line. The focus ring goes round the label and the arrow. `sortableTables.test.js` lists every file that draws a
    table, with the reason each unsortable one keeps its order, so a new table cannot ship unsorted.
- **Row actions live in the details drawer.** Keep one or two primary actions visible in the row; the rest go in the drawer, which can also say *why* an action is disabled.
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

Vitest with globals enabled and a jsdom environment. **3,851 tests across 162 files** at the last count (2026-10-11).

The suite treats an unhandled promise rejection as a defect, not noise — Vitest reports them
separately and they can mask real failures.

---

## Related

- [`../supabase/README.md`](../supabase/README.md) — the API this consumes, RLS, edge functions
- [`../ingestion/README.md`](../ingestion/README.md) — where device state comes from
