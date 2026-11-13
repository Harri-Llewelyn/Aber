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
| `utils/units.js` (`UNIT_SYMBOLS`) | the units the Add Metric dialog's list offers, which `0002` seeds as the MTConnect `UNIT` and `NATIVE_UNIT` rows, the units the ISO 22400 and OPC UA rows prefill, and the example metrics' units (mirror checks 102 and 103) |
| `utils/ashrae223.js` (`ASHRAE223_GROUP`) | the one metric group registered under ASHRAE 223P, and the group its seeded metrics file under |
| `utils/historianBackupSchedule.js` (`nextHistorianBackup()`) | the historian backup sidecar's schedule, `physical_backup_missed_slot()` and `physical_backup_type()` in `timescaledb/physical_backup.sql` |
| `hooks/usePermissions.js` (`DEFAULT_ROLE_PERMISSIONS_MAP`) | the `role_permissions` grants, as the chain seeds and withdraws them |
| `utils/alertAcknowledgement.js` | the acknowledgement reasons `platform_alerts_acknowledgement_reason_valid` and `acknowledge_alert()` admit, and the roles `acknowledge_alert()` and `withdraw_alert_acknowledgement()` allow (mirror checks 45 and 46) |
| `utils/unsPath.js` (`placeNameProblem()`) | the characters `areas_name_topic_safe` and `cells_name_topic_safe` refuse in a name (mirror check 64) |
| `utils/gatewayType.js` (`gatewayTypeChange()`) | what `clean_up_after_a_gateway_type_change()` ends when a gateway's type crosses Remote's boundary: the setup state, the enrolment states, and the remote arm of `gateway_has_broker_credential()` (mirror check 68) |

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

`utils/payloadConformance.js`, Validate Payload's copy of `ingestion/conformance.py`, has one too:
`test-harness/fixtures/payload-conformance.json`, asserted by vitest and by
`ingestion/test_payload_conformance.py`. Where the languages differ it gives Python's answer:
Python's equality in an `enum`, `repr()` and `'%g'` in a detail, and a `pattern` translated to
match as Python's `re` does (`.`, `$`, `\d`, `\w`, `\s` and `\b` all differ). A pattern outside that
translation is reported as not checked here, never guessed. The translation leaves Unicode
versions aside: a character newer than one side's tables can still class differently.

What the two schema builders write is held to what ingestion reads the same way:
`test-harness/fixtures/schema-builder-output.json` is a catalog, some typed ranges and the
definition both builders must produce from them (`schemaBuilderContract.test.jsx`), plus readings
whose findings `ingestion/test_schema_builder_contract.py` asserts against that definition. Both
builders build each entry with `catalogPropertyEntry()` in `utils/schemaProperty.js`.

### Permission gating

`hasPermission(uuid)` from `usePermissions`, against `PERMISSION_UUIDS` in `constants.js`. Gating
is a UI affordance only — RLS is the enforcement, and every gated action is independently refused
by the database.

### A tab can be gated by role

A page's `TABS` entry takes a `role` or a `permission`, and so does each of its `pageTabs`. System's
Logs tab (`SYSTEM_LOGS_TAB`) carries `role: 'Administrator'` on a page every role opens.
`tabIsVisible()` decides both, and `visiblePages(hasPermission, userRole)` in `navigation.jsx`
returns the pages a viewer may open, each with only the tabs they may see. `App.jsx` computes it
once, and the four places a tab is offered read that one answer:

- **the rail**, whose list of a page's tabs is the page's `pageTabs` as `visiblePages` gives them;
- **the search**: `buildTargets()` offers a card that opens a tab only while the page's tabs hold
  it;
- **the page's tab bar**: the page asks `tabIsVisible()` for the gated tab itself, as System does
  for Logs, because it builds its bar from more than the list;
- **the address**: `urlNamesWithheldTab()` sends anyone who opens a tab they may not see to the
  page's first tab, query and all, as a hidden page sends them to the Site Map. It waits for the
  role, so an Administrator reloading on the tab stays there; System holds its own address too,
  through `useUrlTab`'s `ready`, until `rolePending` is false.

Hiding a tab removes a signpost and nothing more. Logs is read through `service-logs`, which refuses
everyone but an Administrator for itself. `tabRoleGating.test.jsx` holds the four places.

### What looks clickable

Only what acts looks clickable. `.mono` is a typeface and takes the text colour; accent colour
means a real link (the System page's open chip, a `.count-link`). A value that copies is a
`CopyableId`: a bordered monospace chip with its copy icon at rest and a tick after a copy. A long
id passes `truncate="start"` to keep its end (`…/iso22400/EFFECTIVENESS`). The copy and the aria
label always carry the full value. The tooltip carries it whenever the chip is cut, measured as the
tooltip opens, and otherwise says "Click to copy this {label}". A read-only or disabled `.form-control` takes the page background and muted
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
  shows on the page. System lists its three groups, and Logs for an Administrator ([A tab can be
  gated by role](#a-tab-can-be-gated-by-role)); the page adds a tab for any service type no group
  claims.
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
  are on the Vocabulary page's help page. System's are its groups' descriptions.

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

### A group of rows opens and closes under one heading

`common/GroupHeading.jsx` is the heading of a group of rows a reader can close. It is a disclosure
button (the WAI-ARIA Disclosure pattern) with a chevron, an optional icon, the group's name and its
count: "Devices · 12". The chevron points up while open and down while closed, as a table's group
rows do, and the name takes `.table-group-label`'s look. In place of a count, `detail` takes words,
cut before the name is (`OverflowText`): a Filters panel's section says what is chosen in its list.

```jsx
<GroupHeading open={open} onToggle={() => toggle(kind)} label="Devices" count={12}
  countLabel="12 lanes" icon={<IconCpu size={12} />} controls={lanesId} />
```

- **The page keeps the state.** The button only reports a press. The page decides which groups are
  open, hides the element named in `controls` while its group is closed, and lays out the row the
  button sits in. A screen reader hears the name and `countLabel`: "Devices, 12 lanes".
- **A closed group still shows what happened in it.** On the Audit Trail a closed section's heading
  row keeps one summary track, with every event of its lanes clustered as a lane's are. Opening an
  event there opens the section too. The History page is to group its lanes by area and cell
  under the same heading.
- **Which groups are closed belongs to the viewer, in this browser.** The Audit Trail keeps its
  closed sections in localStorage (`aber_audit_trail_closed_sections`, read and written inside
  `try`), not in the address, so a shared link opens every section. Expand all and Collapse all
  (`ExpandAllToggle`, outlined) sit at the start of the row above the sections
  ([The toolbar](#the-toolbar) says why it is not in it).

### Cut text slides on hover or focus

`common/OverflowText.jsx` draws one line that may not fit, cut with an ellipsis at rest. While the
pointer is on it, or on the button or link it sits in, or that control has keyboard focus, text
that is really cut slides at about reading pace (`SLIDE_PX_PER_SECOND`) until its end shows. It
slides back when they leave.

- It never moves by itself, and under `prefers-reduced-motion` it does not move at all, so the
  control's tooltip must carry the whole text.
- It measures as it activates (`scrollWidth` against `clientWidth`), as `CopyableId` does, so a
  drawer opening needs no listener. `onMeasure(cut)` hears each measurement.
- A section heading's `detail` (`GroupHeading`) is its button's tooltip while it is cut, and only
  then, through `onMeasure`. The tooltip does not describe the button (`describe={false}`): the
  heading's sr-only words already give a screen reader the whole value.
- The whole text is always in the DOM, so a screen reader hears all of it.

The Audit Trail's lane names use it first. The dashboard's other cut lines move onto it with
[#1219](https://github.com/Harri-Llewelyn/Aber/issues/1219).

### A unit is a symbol where it is read, and a code where it is exchanged

The catalogue holds MTConnect's unit names, and a person reads `°C` for `CELSIUS`: `unitSymbol()`,
`withUnit()` and `unitAndCode()` in `utils/units.js`, from the one map `UNIT_SYMBOLS`.

- **A symbol is read** in History's chart titles, heads, ticks, ranges and heat maps, the Metric tab's
  list, the Devices drawer's derived values and the Automations editor's help. The words functions in
  `utils/history.js` (`readingWords()`, `chartTitle()`) say it, so a chart cannot print a code.
- **A code is exchanged.** The export's CSV, the AAS exports and the APIs keep the catalogue's code,
  which other programs read. The data in the page's state is the code too: the symbol is made where
  it is printed.
- **The Metrics page says both**, `°C (CELSIUS)` (`unitAndCode()`), in its Units column and its
  drawer, because it is where a code is chosen. The Add Metric and Add Derived Metric dialogs, the
  metric picker and the vocabulary pages show the code.
- **A code with no symbol shows as it is.** A derived rate takes its counter's symbol per hour
  (`kW/h`). `%` and `°` stand against the number (`42%`, `90°`) and any other symbol follows a space
  (`18.8 °C`), so a range says them at each end (`0% to 50%`). A time in state is `SHARE_UNIT`, a
  percentage of its own, and is not in the map.
- **Checks.** Mirror checks 102 and 103 (`scripts/check-mirror-drift.mjs`) fail on a unit the Add
  Metric dialog's list, a prefill or an example offers that has no symbol, and on a symbol no source
  offers. Docs-drift check 373 holds the files that read to the map and the files that write data out
  away from it, and 374 the symbols the documents name.

### A page's summary is one row of cards

Backups and Cold Storage sum up their list in one row of `common/SummaryCard.jsx` cards between the
toolbar and the table, drawn like the Site Map's lanes: a 4px cap in the state's colour (grey while
nothing is wrong) and a chevron on a card that opens a panel. A card that opens something is a
`<button>`; one that opens nothing is a focusable group, so its tooltip still shows from the
keyboard. A card that opens another application's page, as the System page's figures open their
Grafana panels, is a link to a new tab, with the external-link icon where the chevron goes. A
`wide` card takes two cards' room, for a figure in three parts. The state is in words on a `role="status"` line, and the whole card in sentences is the
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

The header row holds the title and the controls: a dialog's `headerActions`, then the close button.
The title takes the rest of the row and wraps inside its own column, with `overflow-wrap: anywhere`
for a file name that has no break. It is never cut with an ellipsis, since the end of a file name
is the part that tells two apart. The controls keep their size and sit at the top, so the close
stays on the title's first line however long the title is. Controls too wide to leave the title 12
characters (the Site Map's legend in the expanded plan) wrap to a line below it, and narrow to the
row.

**One metric list serves the schema builder and Add Derived Metric** (`common/MetricPicker.jsx`): the
search, the standard filter and the grouped, tickable list. The list narrows what is shown, never
what is chosen, because the dialog holds the choice. `single` makes the ticks radio buttons for a
dialog that takes one metric. A caller that cannot show a long list at the window's height gives it
one with `listStyle`. The schema editor for a draft keeps its own list, which shows each metric's
stored keys.

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

### A dialog says why it cannot go ahead

A dialog whose confirm cannot go ahead yet says why where the person is looking. Its confirm looks
refused while it cannot. `dialogSaysWhy.test.jsx` holds the pattern for the dialogs a form holds.

- **A held confirm is greyed.** `ActionButton` adds `btn-disabled` whenever it is disabled and not
  pending, as it does for `permitted={false}`. A pending one keeps `btn-loading`, which stays
  legible. The `disabled` attribute alone changes nothing in `App.css`, so a dialog's confirm is an
  `ActionButton`, never a plain `<button disabled>`.
- **The first problem is said above the buttons.** Pass it as `Modal`'s `problem`, or null when
  there is none. `Modal` draws it between the body and the error slot, so it stays in view while the
  body scrolls. It is the form's warning hint (`form-hint hint-danger`, with its icon), in a live
  region.
- **It appears from the person's first edit, never on open.** A dialog that has just opened does
  not scold. A dialog with steps passes `touched` for the step it is on, and so does one that waits
  for a particular field (Change Password waits for the new password).
- **A form with buttons of its own** inside a dialog (Attach a link) draws `FormProblem` above them.
- **A problem with one field's value as typed is said under that field,** in its hint: too long,
  not an email address, a name already taken. It is not repeated above the buttons.
- **An edit that changes nothing is not a problem.** Its confirm is greyed and its tooltip says so.
  Nothing is said in red, because the form shows it.
- **A required field says so on its label** with `RequiredMark`, and its control carries
  `aria-required`. `App.css` draws the asterisk, so the label's text stays the field's name.
- **A refusal from the database or a function is shown in `Modal`'s `error`,** worded as it came.
  The dialog stays open with what was typed. A handler run from a dialog throws its refusal, rather
  than toasting it behind the dialog.
- **`ConfirmModal` shows a rejected `onConfirm` in its own error slot.** So its `onConfirm` closes
  the dialog only once the act has succeeded.
- **The tooltip on a held confirm can stay,** but it is never the only place the reason is.

Three kinds of dialog explain themselves another way:

- **A typed gate** says what to type in its label: ConfirmModal's `requireTyped`, and a gateway's
  credential and setup dialogs.
- **The schema builder** keeps Save pressable. Pressing it reveals what is missing beside each
  field, because its problems are spread across a long form.
- **A role that may not act** sees `permitted={false}`, with the roles that may in the tooltip
  ([Permission gating](#permission-gating)).

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

### An area's plan turns in quarter turns

`areas.plan_rotation` (`0221`) turns a plan on screen, clockwise, by 0, 90, 180 or 270 degrees. The
SVG and every cell's `plan_x`/`plan_y` stay as uploaded; the arithmetic is in `utils/areaPlans.js`.

- **Two aspects.** `planFrameAspect()` is the shape of the frame, `1 / plan_aspect` on its side.
  `AreaPlan` and `PlanViewer` draw with it, so the viewer fits and centres fractions of the turned
  frame. `planAspect()` stays the drawing's own, and the spacing check measures places on the
  drawing with it, so a quarter turn changes no distance.
- **Only the image turns.** `AreaPlan` lays the `<img>` out at the drawing's own shape
  (`drawingBoxInFrame()`), the frame's height wide when it is on its side, and turns it about the
  frame's centre with a CSS `rotate()`. A pin is not inside the turned box: it turns its place into
  the frame (`placeInFrame()`, with the turn `AreaPlan` provides by context), so its label stays
  upright and still slides inward at the frame's edges. A click is read as fractions of the frame
  and turned back (`placeOnDrawing()`) before `onPlaceClick` sees it.
- **A turn is a draft until Save Turn.** `AreaPlanPanel`'s Turn left and Turn right change a turn
  held in the panel for the area it was made on, and pass the preview a copy of the area at that
  turn, so the preview and the expanded plan draw it with no request. The page's own copy keeps
  the saved turn, which the Site Map, the Cells page and the table read. While the draft differs
  from the saved turn the shared `SaveDiscard` pair (`components/common/SaveDiscard.jsx`, as on
  Profile) offers Save Turn, which calls `setAreaPlanRotation()` once and reloads, and Discard.
  Replace plan and Remove plan are held until then. Opening another area or closing the panel
  drops the draft.

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

### What sits where in a drawer

Top to bottom: the alert, the fields, the facts (`beforeActions`, such as a gateway's devices), the
actions, and last the tools (`children`, such as Capture's drop zone). A tool is last because its
height is not known, and above the actions it could push Edit Details off the drawer.

- **Suppression windows are a tool, after the actions.** The device, gateway and cell drawers pass
  `common/SuppressionWindows.jsx` as `children`, since its list has no fixed height. It lists the
  current and upcoming windows with `context-panel-section-label`, as a gateway's Devices are, each
  with a NOW or UPCOMING badge beside its reason, its times by `formatDateTime()` and who scheduled
  it. A device's drawer passes its current cell, whose windows are listed marked From cell and
  changed from the cell's drawer. A Shopfloor Manager or an Administrator (`maySuppress()`) gets
  Schedule window…, Change… and End now, or Cancel window before it starts. The dialogs
  (`modals/SuppressionWindowModal.jsx`) take local times with `datetime-local`, as the time control's
  custom range does; End now and Cancel window ask first, and the confirm repeats the act's name.
  The end field's `max` is the window's own start plus `alerts.suppression_max_days` (`useSetting`,
  falling back to `SUPPRESSION_MAX_DAYS`, 7), and a hint under it names the limit and its Settings
  tab. An end past it is refused inline, as an end in the past is; a change of the reason alone is
  not measured, as the writer does not measure it. The section reads again at its next window's
  start or end.
- **The alert names no evaluator.** The banner above the fields (`ContextPanel`'s `alert`) says
  Alert firing, Alert acknowledged or Alert suppressed, since when, with the counter's lines under
  it: who acknowledged it and why, or until when a window keeps it quiet and why. A suppressed one
  takes a dashed neutral outline and a crossed bell, since it colours nothing. The Devices page
  hands the banner the device's alert from `alertIndex(..., { suppressed: true })`.
- **A control that changes what the drawer shows goes in `nav`**, a slot at the drawer's full width
  under its header and above the fields. It continues the header's band, takes the header's rule,
  and stays in view while the body scrolls. The Audit Trail's step buttons are there, in their two
  rows under the position line ("Event 3 of 7 · Entity 2 of 9"). In the header's subtitle they
  stopped short of the close button.
- **A person or a machine identity links where the viewer can follow it.** In the Audit Trail's
  drawer, User ID and Machine identity are the name as a link to Access Control › People
  (`personUrl`, which opens a removed person too) or › Machine identities (`identityUrl`, by the
  principal id), for a viewer the rail shows Access Control to (`tabIsVisible`). For anyone else
  the name is text. The id's `CopyableId` chip sits beside the name, since a link and a copy cannot
  share one click.
- **An entity's own page is one action away**, named for the page: "View in Devices" (`entityUrl`).
  The Audit Trail offers it for a device, gateway, cell, area or schema its lookups still hold, so a
  deleted entity gets none.
- **A row the item's kind can never fill is not shown. A row it could fill, but has not yet, says
  *Not set*.** A Host gateway has no appliance, so a CA expiry, a disk, memory, load, a flow hash, a
  platform tag and a custom playbook can never be reported for it. Its drawer drew all seven, each
  reading *Not set* for good, and its first action started at 1,073px, where a 1920×1080 screen
  leaves 865px. The Gateways drawer keeps the rule in one table, `NEVER_FILLED_ROWS` in
  `utils/gatewayType.js`, keyed on the gateway's kind and read by `gatewayShowsRow()`, so a row is
  hidden by listing its label there, not by a condition beside the row.
  - **Host and Simulated** keep Health Reported and Runtime Uptime, which a heartbeat fills, and
    lose the seven appliance rows and the three forge rows (Bundle, Committed, Reported).
  - **Playback** loses the health rows too: the ingestion daemon records none for a shadow gateway.
  - **Third-party** loses every one of them, and says so in a Not Provided row.
  - **Remote** loses none. Where it has not reported a figure the row says *Not set*. Its three
    forge rows show only once they hold a value: as *Not set* on a new appliance they would add
    three rows to its drawer.
- **A missing repository is one line.** `GatewayRepositoryPanel` draws the drawer's field shape:
  the label *Repository* with a help tip, then one muted line such as *None: edit it in Node-RED*.
  The reason is in the tip, in about 35 words. Every case without a repository does the same:
  Host, Simulated, Playback, Third-party, not yet enrolled, and enrolled with none created.

- **The actions are two to a row** in a drawer wide enough for two 200px columns, about 440px and
  up, and one to a row below that. The first primary action and a danger action take the whole row.
  Eight actions one to a row took 331px of a 1080 screen's drawer; two to a row they take 220px.
- **A section of fixed height can sit above the actions**, in `beforeActions`. The device's 3D
  model is one. As the last tool it started 747px down a drawer body that shows 754px at
  1920×1080, so some people did not know a device could have a model (#1061). A tile beside the
  device's facts then fitted the whole drawer in 715px, but a 180px viewer in half the drawer's
  width was cramped (#1070). It is now a section of its own after the fields, ruled off as the
  actions are. The viewer takes the drawer's width at 16:9, and the empty drop zone has the same
  shape, so the section cannot grow into the actions. At 1920×1080 the viewer is wholly in view
  when the drawer opens (434px to 718px of the 754px body) and the actions start just below it.
- **Download, Replace and Remove share the section's width.** In a drawer too narrow for the three
  words, a container query (`.model-section`) leaves the buttons their icons, and each word stays as
  the button's name, hidden but read.

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
  apart depending on the time window, and it would erase the causation signal: perfect overlap
  is the visual signature of one act.

Markers closer than `CLUSTER_GAP_PX` (14px, one marker plus its ring) become one badge carrying the
count. Grouping is by **pixel** distance, not by time, so the time window acts as a zoom and a
cluster dissolves into its members as the same events move apart on screen. A drag across the trail
or Zoom in narrows the window ([One time control](#one-time-control-for-every-period)). The badge sits at the
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
  earlier of two as near). A closed section's lanes are skipped. An event open in a closed section
  stays lit on that section's summary track, ← and → still step along its lane there, and ↑ and ↓
  leave it for the drawn lanes either side. The order is the one on screen when the key is pressed,
  so a poll that re-ranks the lanes moves the next press with it. Neither pair wraps. While the
  drawer is open the page keeps all four keys, so ↑ and ↓ do not scroll the timeline; Page Up and
  Page Down still do.
- **A lane's name opens its newest loaded event,** the change a reader most often wants, and ←
  steps back from there. The name is the label's button, named "Open the latest change to Line 1".
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
  Its `scroll-margin` keeps it clear of the pinned axis row and the section heading. The timeline
  never scrolls sideways: the label column is a share of the width (140px to 260px) and the track
  takes the rest, however much the drawer takes.

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
card. Beside the state, the same read counts the account's live sessions: *Connected*,
*Connected (N)* above one, or *Not connected*, and nothing when the broker was not read, since
unknown is not *Not connected*. The broker also reports each session's address, and
`summariseInventory()` drops it: every client outside the cluster reaches the broker under the
node's address.

*Broker accounts* makes and deletes read-only accounts through `broker-subscriber`. *New Read-Only
Account* (`modals/BrokerSubscriberModal.jsx`) is offered once the broker was read, which only an
Administrator can do. It shows the password once, as `GatewayCredentialModal` shows a gateway's,
with the broker address `EdgeNodeSettings`' `useDirectoryBroker()` reads and the topics the page's
read of the `subscriber` role reports. An account in the scheme (`isSubscriberAccount()` in
`utils/serviceIdentities.js`) shows the name and description the broker holds, and is the only row
with *Delete*, which a `ConfirmModal` names first.

People, Broker credentials and Machine identities are searched and filtered in the browser: each
list is tens of rows, read whole. What is gone is hidden the same way on every tab, behind a **Show
… (N)** toggle that appears only while N is above 0: removed people (`accessRemoved()` in
`utils/people.js`, which leaves out a removal whose sign-in is still open, since that row needs
Remove Access again), archived gateways and withdrawn identities. The tab and the filters are in
the address (see [Routing](#routing)), which is why the page has no Refresh: every action reads its
list again, and a reload returns to the same view.

The **People** tab (`components/tabs/PeopleSection.jsx`) is offered only when `App.jsx` passes
`userRole` Administrator, and the page opens on it. A row shows the person, their role as text,
status and last sign-in; a click or Enter opens the person's drawer, in the address as
`?person=<user id>`, which holds every action. `personUrl()` writes the id and no search: People
checks `person` against everyone it lists, filtered or not, and the id survives a change of address.
A link from before, `?person=<email>`, opens whoever has that address now, matched without case,
and the address is rewritten to the id with replace. The drawer's View Their Changes is the Audit
Trail with `?changed_by=<user id>` (`changesByUrl()`), offered when `App.jsx`'s `hasPermission`
grants `audit_trail:read`, as the other drawers' View Audit Trail is. The drawer
is drawn into an element `AccessControlTab` renders beside its card, where the broker-role drawer
sits, so it pushes the table as every page's drawer does. A role changes only through the drawer's
Change Role (`ChangeRoleModal`), which starts on the person's role and says what the chosen one lets
them do (`consequence` in `PERSON_ROLES`) before anything is sent. A role change can take access
away from the person's next request, so it asks first, as the drawer's other changes do; a select
on the row saved a stray click or arrow key at once. Roles go through
`set_person_role()` and ending sessions through `end_person_sessions()`; adding, removing,
restoring, Set New Password, Reset MFA and Change Email go through `manage-people`, because GoTrue's
admin API needs the secret key. The drawer's Sessions row is `person_session_summary()`, a number and a time.
Its Show sessions opens the list below the fields, read then (`person_sessions()`, `supabase/README.md`
`0212`) and not with every drawer, in the Security tab's table (`components/common/SessionsTable.jsx`)
with End on every row. End asks first with `endSessionQuestion()` naming the person, then calls
`end_person_session()` and reads the list and the count again. Your own drawer links to Profile's
Security tab instead, where the session in use is marked. The controls the database would refuse (your own row, the last Administrator who can
sign in, a removed person's role, password or address) are disabled with the reason as their
tooltip, computed in `utils/people.js`, so the page and the database state the same rule. A new
address is the drawer's key, so after Change Email the list takes it before the address bar does,
and the drawer moves with it rather than being tidied away. A password
`manage-people` mints, for Add Person on a site with no mail relay or for Set New Password, is shown
by `PasswordShownOnce` and lives in its dialog's state until it closes, as a minted token does in
`ServiceTokenModal`.

The **Apps** tab (`components/tabs/AppsSection.jsx`), after People and gated as it is, lists the
apps that sign people in: GoTrue's OAuth clients, from `list_apps()` (`supabase/README.md`
`0217`). A row is the app by the name the Sessions list uses (`appLabel()` in `utils/apps.js`),
how and when it was registered, the addresses it sends people back to, its client type and how many
people allow it. A click or Enter opens its drawer, `?app=<id>` (`appUrl()`), into the same host
as a person's. The drawer reads `app_approvals()` when it opens and draws the people in
`components/common/AppApprovalsTable.jsx`, the table Profile's list of approvals shares; Revoke calls
`revoke_app_approval()` and Remove App `remove_app()`, each after a dialog that says what ends.
Remove App is disabled for Aber's own apps, which db-init registers again on every boot.

**Register App** (`components/modals/RegisterAppModal.jsx`) adds an app that signs people in:
`register_app()` (`0260`) takes a name, public or confidential, and one to ten addresses the app
sends a person back to. The dialog says before it asks what the database would refuse, with
`redirectAddressProblem()` in `utils/apps.js`, one fixture
(`test-harness/fixtures/app-redirect-addresses.json`) with the database's rule, and the site's domain
read from the API address as `site_domain()` reads the Directory's. A confidential app's secret
is shown once, in the dialog's state until it closes, beside the client ID and the discovery address
(`<API address>/auth/v1/.well-known/openid-configuration`); a public app has none. The success toast
links to the app's row, and the drawer says an app that is not Aber's own is sign-in only.

**Change Password**, the Password row's action on Profile's Account tab, opens `ChangePasswordModal`.
`utils/passwords.js` sends the current password with the new one in one
`supabase.auth.updateUser()`, and GoTrue checks the current one before it sets anything
(`docs/security-model.md`, *People*). The button is disabled for a session with no email address,
a machine identity, which has no password.

### The Issue Token dialog says how to connect

After a mint, `ServiceTokenModal` shows a **Connect** section when the identity holds
`telemetry:read`; without it an identity sees nothing through i3X, so a setup would mislead. It
gives the i3X server's address with `/v1` on it, the authentication (a bearer token), and one setup
per client from `utils/i3xClientSetups.js`: i3X Explorer, the MCP block that
`scripts/mint-api-token.mjs --json` prints (`serviceTokenModal.test.jsx` holds the two to the same
package pin), and a `curl` of `GET /v1/objecttypes`, which needs a token where `/v1/info` does not.
The setups are built from the minted token in the dialog's state, so they close with it.

The address is `i3xUrl()` in `constants.js`, from `VITE_I3X_URL`. The chart renders it from
`aber.i3xUrl`, the helper the i3x Ingress host is built from, and blank when `i3xService` or
`ingress.routes.i3x` is off; CI's *Verify The Dashboard Names The i3X Server The Ingress Routes*
holds it to that host. Blank in a built bundle leaves the address and every setup out. Only the
Vite dev server falls back, to `http://localhost:8090`, as `GRAFANA_URL` does.

### A Third-party gateway's dialog gives every setting its edge node needs

A Third-party gateway (`deployment = 'third_party'`, migration `0196`) is an edge node on its own
machine, running software Aber does not manage. `credentialIssuedHere()` in `utils/gatewayType.js`
is true for it and for a Host gateway, and every page that decides whether to offer a credential or
a bundle asks it. Placement follows Remote: `cellResolution.js` and the Site Map's host flag test
`deployment === 'host'` only, so a Third-party gateway holds a cell and carries no flag.

Its credential dialog shows `EdgeNodeSettings` (`components/modals/EdgeNodeSettings.jsx`) in place
of the Node-RED steps, and so does Show Broker Credential. Each value comes from where the dashboard
already learns it (`utils/edgeNodeSettings.js`):

- **The broker address and port** from the broker's `directory_services` row, which db-init keeps
  to the chart's public broker address, the one an appliance is handed. A row still naming an
  in-stack host is shown with a warning, and a failed read is said rather than guessed.
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

### Why Settings › Notifications has a panel of its own

A settings row holds a string, a number, a boolean or JSON, and the webhook needs more:
`NotificationsPanel` (`components/tabs/NotificationsPanel.jsx`) wraps the category's table, which
keeps its header row, with a toolbar above it and the delivery log below it. The toolbar is an
Administrator's, as every change on Settings is; anyone else is told whose it is and reads the log.

- **`WebhookModal`** holds the address, a `CredentialField` as the destination dialogs' keys are, and
  the allowed hosts, so `notifications.webhook_allowed_hosts` is left out of the table
  (`WEBHOOK_DIALOG_KEYS`) and the search opens this tab for it. The hosts are saved before the
  address, and an address whose host is not listed is said while it is typed.
- **`SigningKeyModal`** shows the key once, as `ServiceTokenModal` shows a machine identity's token:
  asked first, revealed with a copy button, gone on close. Rotating says the old key stops at once.
- **Send a test** queues the message through `queue_test_notification()`, since the dispatcher is
  never reachable from a browser, and reads its log row each second until it has left `pending`.
- **The delivery log** polls every 30 seconds, as Backups does. Each outcome is a word in its badge,
  and a long subject or error is cut and slides on hover (`OverflowText`).
- **`notifications.webhook_min_severity`** is a choice in its row, from `SETTING_OPTIONS`
  (`utils/notifications.js`), which mirror check 58 holds to the database's guard.
- **Email has the webhook's layout.** The toolbar adds **Set up email** (a warning while no role is
  told or the site has no relay, **Change email** after) and **Email a test**. **`EmailModal`** ticks
  the roles told, in the dashboard's order (`PERSON_ROLES`), and saves
  `notifications.email_roles`, which is left out of the table (`EMAIL_DIALOG_KEYS`) as the hosts are.
  Its Save is greyed until a role changes. `notifications.email_min_severity` is a choice in its row.
  **Email a test** queues `queue_test_email_notification()` and toasts how it went, in the
  dispatcher's words.
- **Every role reads who is emailed.** A line under the toolbar names the roles told, or says nobody is
  yet, and a warning above it says in words when the site cannot send: the relay and the sender are
  the functions pod's environment, so the page asks the dispatcher (`GET
  /functions/v1/notification-dispatch`, `api.notificationEmail()`). If it cannot be asked the page
  says nothing about the relay rather than guess.
- **The delivery log has a Channel column**, and an email row's badge says how many people the relay
  took it for. The log never holds an address.

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
- **Coming back to the tab asks again.** A session that ends while the person is in another window
  would otherwise go unnoticed until its token expires, up to an hour later.
  `hooks/useSessionRecheck.js` asks the auth server when the tab becomes visible, at most once a
  minute (`SESSION_RECHECK_MS`), with the `askAuthServer()` the reload uses. A refusal takes the
  reload's path: a local sign-out, then the sign-in screen with its notice. An unreachable server
  signs nobody out, even when an expired token could not be refreshed through it and supabase-js
  holds no session for the moment.

### The sign-in asks for a second factor's code

A password sign-in by someone with a verified factor is `aal1`. `hooks/useSecondFactorDue.js` asks
`getAuthenticatorAssuranceLevel()` whenever the access token changes, and `secondFactorDue()` is
true when the current level is `aal1` and the next `aal2`, unless `amr` names a federated method
(`oauth`, `sso/saml`), which is never asked twice. While it is true, `App.jsx` shows
`SecondFactorScreen` (`components/auth/SecondFactorChallenge.jsx`) in the sign-in page's frame
instead of the dashboard, and
before a password reset too: GoTrue refuses a new password from `aal1` for an account with a
factor. The screen lists the person's factors from GoTrue, takes six digits, and has GoTrue check
them with `challengeAndVerify()`. The `aal2` session reaches `App.jsx` through
`onAuthStateChange`. Sign Out is on the screen. `pages/OAuthConsent.jsx` asks the same before it
reads an authorization request, because Grafana, Node-RED, Studio and the forge sign in through
the dashboard's session. The question is a prompt, not a gate, and an answer that cannot be read
opens the dashboard. The gate is the server's, while Settings requires MFA (`0251`): the consent
page shows the gateway's refusal with a link to Profile › MFA and no note about expiry.

### Profile, and the preferences that follow the person

Two pages, two scopes, and each says which in its heading's note. **Profile**
(`components/tabs/ProfileTab.jsx`, page id `profile`, tabs `account`, `appearance` and `security`) is
the signed-in person's own: "Applies to you, on any browser". **Settings** is the site's: "Applies to
everyone on this site". Account, Appearance and Notifications reuse the Settings table (Setting, Description,
Value, Actions), header row and all, so the two read alike.

- **Security is a tab of sections, each with its own heading, About tip and line under it.** The
  first is Sessions (`components/tabs/SessionsSection.jsx`): every session the person holds
  (`list_my_sessions()`, `supabase/README.md` `0206`), the one in use first and marked This browser,
  then by last activity, in `components/common/SessionsTable.jsx`, which a person's drawer on People
  shares. Where is the browser and system from the user agent, or the service by
  the name the help uses (`utils/sessions.js`, no parsing library): the OAuth client's name without
  "Aber ", and "Studio" for "Aber Supabase Studio", whose name the consent page still shows. End calls
  `end_my_session()` on any other row, after a dialog that names the session and when it was last
  active; Sign Out of All Other Sessions calls `end_my_other_sessions()` (`supabase/README.md`
  `0211`), which keeps the session the token names. Each writes one `SESSIONS_ENDED` row, and the
  Audit Trail's drawer names that row's session with the same `sessionLabel()`. Each act toasts
  with a link back to the tab and reads the list again.
- **The second is Second factor** (`components/tabs/SecondFactorSection.jsx`): the person's verified
  TOTP factors, read with auth-js `supabase.auth.mfa` through `api.js`, no new dependency. Add
  Second Factor (`modals/AddSecondFactorModal.jsx`) takes a name, enrols, and shows GoTrue's QR code
  and the secret as text; `qrImageSource()` (`utils/secondFactor.js`) percent-encodes the SVG auth-js
  leaves raw, and the CSP's `img-src` admits `data:`. The factor counts once GoTrue accepts a code;
  Cancel removes the half-made one. Remove (`modals/RemoveSecondFactorModal.jsx`) asks first, and
  takes a code first when the session is `aal1`, since GoTrue removes a verified factor only from
  `aal2`. A removal renews the token, so the dashboard sees a session GoTrue lowered to `aal1`.
- **The third is Apps you have allowed** (`components/tabs/AllowedAppsSection.jsx`): each app
  the person allowed (`list_my_app_approvals()`, `supabase/README.md` `0217`), in
  `components/common/AppApprovalsTable.jsx`. Revoke calls GoTrue's own `DELETE /user/oauth/grants`
  through `supabase.auth.oauth.revokeGrant()`, which also ends that app's sessions for the person,
  then toasts and reads the list again. A trigger on GoTrue's table writes the Audit Trail row.

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
- **Desktop notifications are one more column of that row** (`supabase/README.md`, `0264`):
  Profile › Notifications has one switch, off until the person turns it on, held until Save as
  Appearance's are. Saving it on asks the browser for permission, in the click that is the gesture
  (`useNotificationPermission`), and a refusal leaves the choice on, because it follows the person to
  their other browsers; the tab says so and how to allow it again. Over plain HTTP, or with no
  `Notification` API, the switch is disabled and says why, each in its own words
  (`UNAVAILABLE_WORDS` in `utils/notificationPermission.js`), as the clipboard falls back where
  `CopyableId` has none. A choice already on can still be turned off there. The browser's copy is
  `aber_desktop_notifications`. See *A firing alert can raise a desktop notification*, below.
- **A person may have a display name** (`supabase/README.md`, `0203`). Profile's Account tab has a
  Display name row (`DisplayNameRow` in `ProfileTab.jsx`), where the person sets or clears it. The
  account menu shows the name with the email address under it. People, the Audit Trail, Approvals
  and the other pages that say who did something show it beside the address
  (`hooks/useDisplayNames.js`, and `personLabel()` in `utils/displayName.js` for "Name (email)").
  The email address stays the account's identifier: where a page says who someone is, the name
  never stands without it.
- **A person may have a picture, which only they see** (`supabase/README.md`, `0213`). Profile's
  Account tab has a Picture row (`PictureRow` in `ProfileTab.jsx`), and the account control at the
  foot of the rail shows it (`components/common/AccountAvatar.jsx`); nothing else does. With no
  picture the control shows the display name's initials, then the icon. `shrinkPicture()` in
  `utils/picture.js` crops a centred square and redraws it at 256x256 on a canvas as WebP, or JPEG,
  so a photo's metadata never leaves the browser. `hooks/useOwnPicture.js` downloads it with the
  session as a blob URL, only when `person_profiles.avatar_path` says there is one, and revokes each
  URL it replaces.

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
  error — it silently emits nothing, which is the worse failure. **Do not "fix" History's charts
  (`tabs/HistoryDevice.jsx`) by subscribing them**: they read again on Refresh and on its timer.
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
- **An edge function's refusal shows at once and stays.** Each function checks its caller as it is
  called: most ask the auth server (`auth.getUser()`), and aas-api and the Factory+ Directory ask
  PostgREST (`auth_pre_request()`, which refuses an ended session with `session_not_found` since
  0205). So a function call can be the first request to meet a session that ended elsewhere. Every
  function call's error in `api.js` passes through `functionFailure()`. A 401 whose body says the
  session no longer exists (`isSessionRefusal()` in `utils/sessionError.js`) is then checked with
  the auth server's `/user` (`authServerRefusesSession()`). The functions that ask the auth server
  answer the same "Invalid user token" when they could not reach it at all, and the strip stays
  until the next sign-in, so the label
  alone is not enough. Only a 401 or 403 from `/user` calls `reportSessionRefused()` and gives the
  error the code `SESSION_REFUSED`. A live session, an unreachable server or no answer within 10
  seconds leaves the error as it was. Refusals that arrive together share one check. The check is a
  plain fetch, not `getUser()`: auth-js drops a refused session and announces `SIGNED_OUT` before
  `getUser()` returns, which would swap the page for the sign-in screen with no word of why. The
  strip then says the session has ended without waiting for the threshold, and no refresh clears
  it: a refresh that works says nothing about the session, and no refreshed token can arrive. A 401
  for a request with no token, a 403 and every other refusal stay with the page that called.
  Access Control's broker callout reads the code and says the session ended instead of naming what
  the read needs.
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
they disagree: *Update available — 1.8.1*.

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
  (`v1.8.0-12-g04374f9-dirty`), so anything stricter would warn on every dev cluster permanently.
  The describe takes release tags only (`--match 'v[0-9]*'`), so a GPL source-mirror tag
  (`gpl-sources-…`) never becomes the name.
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
  page shares across its tabs: the Vocabulary search, and Capture's stored filter and search. A
  function `keep(tab)` names them for the tab being opened: Capture keeps its two only between
  Gateways and Devices, as Captures and Playbacks have no filters.
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
- **A renamed page keeps its old address.** `MOVED_PAGES` in `hooks/useAppRouting.js` maps the old
  first path segment to the new one, and the router replaces the address with the new page's, tab
  and query string kept: `/directory/ingestion?sort=name` becomes `/system/ingestion?sort=name`.
  `tabFromUrl` reads the old address as the new page, so nothing else mounts first. An entry stays
  for as long as a bookmark or an old link may name it.
- **Tests start at `/`** (`src/test/setup.js`). A test that needs a view sets the address before it
  renders the page.

| Page | Tabs in the path | Query keys (drawer last) |
| :--- | :--- | :--- |
| Site Map | | `archived`; the panel: `area`, `cell` or `lane` |
| History | `overview` (the default, also the bare `/history`) or `device`, then the device's id (`/history/device/<id>`; `/history/device` is the picker) | the time window (`span` and `at`, `range`, or `from` and `to`); the picker: `search`, `sort` |
| Areas | | `search`, `lifecycle`, `sort`; `area` |
| Cells | | `search`, `lifecycle`, `attention`, `empty`, `sort`; `cell` |
| Gateways | | `search`, `lifecycle`, `status`, `type`, `quarantined`, `sort`; `gateway` |
| Devices | `quarantine` | `search`, `status`, `attention`, `lifecycle`, `type`, `schema`, `gateway`, `cell`, `replay`, `sort`; `device` |
| Audit Trail | | `search`, `type`, `action`, `changed_by`, the time window (`span` and `at`, `range`, or `from` and `to`; [One time control](#one-time-control-for-every-period)), `deleted`; `event` |
| Schemas | | `search`, `status`, `sort`; `schema` |
| Metrics | `derived`, `deprecated`, `uncatalogued` | `search`, `standard`, `unmapped`, `sort`; `metric`. Derived: `derived-search`, `sort`. Uncatalogued: `name`, `sort` |
| Automations | `<id>`, an automation's `id:` (`/automations/lathe-3-spindle-hot`); `new` for the starter | `search`, `entity` (a device's id), `sort`; `trigger`, which opens the automation that owns an alert's trigger; `open`, on `/automations/new`, for an automation whose id is `new` |
| Vocabulary | the standard, as a slug (`opc-ua`) | `search` |
| Approvals | `decided` | `kind`, `search`, `sort`; `proposal` |
| Capture | `device`, `captures`, `playbacks` | Gateways and Devices: `stored`, `search`, `gateway`, `sort`; `subject`. Captures and Playbacks: none |
| Archives | `retired` | `sort` |
| System | the group, `logs` | `sort`. Logs: `service`, `level`, `search`, the time window (`span` and `at`, `range`, or `from` and `to`; [One time control](#one-time-control-for-every-period)) |
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
| `HistoryTab` | The History page (tab id `history`), ungated: a device's readings over a window ([History and its chart](#history-and-its-chart)). Overview, its first tab and default, draws where readings arrived, a lane per device (`HistoryOverview`). Device lists the devices to pick from, then charts one device's metrics (`HistoryDevice`), one `TimeSeriesChart` each, stacked on one time axis, each head showing its latest reading. Export CSV, on the Device, Overview, Metric, Cell and Area tabs, is the readings export ([History's Export](#historys-export)). Cell compares one metric across a cell's machines on one scale, with an hour-of-day heatmap (`HistoryCell`, [History's Cell tab](#historys-cell-tab)) |
| `AreasTab` | The ISA-95 areas. Cells are filed by dragging a chip onto an area row; unfiled cells sit in a queue row above the table. Devices are never filed here: a device's area is its cell's, or its own when Area-Wide. An area's SVG plan is managed from its details panel (`common/AreaPlanPanel.jsx`); a plan is parsed as the browser parses it before upload (`utils/areaPlans.js` `readSvgPlan`), so a file that would draw as nothing, or whose stated size is not the one the browser would use, is refused with the reason. An area is archived from its panel the way a cell is, through the shared `ArchiveModal`, and hidden behind the lifecycle filter; it is deleted only from Archived Entities. Its panel shows the Unified Namespace filter for everything beneath the area, and Edit Details says how many devices' topics a rename moves, while the bridge is on (`common/UnsPlace.jsx`) |
| `CellsTab` | Cell management. Device membership is grouped from its own `/api/v1/devices` load. The area and the place on the area's plan are on the form; the place is picked by clicking the plan (`common/CellPlacementPicker.jsx`), which refuses a spot closer than `site_map.min_pin_spacing` to another pin. Its panel shows the Unified Namespace filter beneath the cell, and Edit Details what a rename moves, as the Areas page does |
| `GatewaysTab` | Every action is in the details drawer, with one primary listed first; **Restore replaces Edit** on an archived gateway. The seeded Playback gateway is listed like any other, and reads Playing back or Idle rather than Offline |
| `DevicesTab` | One card, tabs **Registered** and **Quarantine**. Quarantined devices render **on the Quarantine tab only** — `filteredAssets` excludes them before every other filter, so no filter combination can list one twice. The panel's **Export…** opens `modals/DeviceExportModal.jsx` (AAS JSON, AASX or Bundle), which Archived Entities opens too. The panel's **Unified Namespace Topic** is the device's row in `device_uns_paths` (0214) under the chart's root, or the reason it has none in words (`utils/unsPath.js`); while the bridge is off (`VITE_UNS_MQTT_ENABLED`) it says so, and no page reads the view |
| `SchemasTab` | The schema registry: each schema, its versions and the devices on it. **Building from the catalog is the only way to create a schema**; changing one is versioning, not editing |
| `AutomationsTab` | The Automations page (tab id `automations`), ungated: rules that watch a device's readings and raise an alert, written as YAML ([Automations and its editor](#automations-and-its-editor)). The list shows each automation's alias, its triggers in words, whether it is enabled, firing now and last fired. `AutomationDetail` is one automation in the YAML editor, or a new one on an example |
| `AuditTrailTab` | Audit trail. The log records what was true when each row was written, and the UI says so |
| `SystemTab` | The read-only registry of the services this deployment runs, a tab per group, with each one's version, address and reach. The Ingestion & Messaging tab opens with `SystemFigures`: what the stack is doing now, from `directory_figures` and two live counts (`utils/systemFigures.js`), each figure "not observed" when it has no fresh value, and each with a Grafana panel linked to it when this browser can reach Grafana. **Logs**, an Administrator's alone, is `SystemLogs`: a service's newest lines from `service-logs`, rendered as text, each with a copy button. The filter is read once typing settles, since each new read writes an Audit Trail row. The window is the shared `TimeWindowControl` with Day and Week only: a rolling window is sent as its range and any other as its `from` and `to`, so a refresh repeats a fixed window exactly and writes no row. The Service list follows the window, read again when it moves, and a chosen service the new list lacks is kept and said so |
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
filters, Filters (n), and an on/off toggle such as Needs attention, which is filled
only while it is on, so its look says whether it is. **Amber (`btn-warning`) marks a destination
that needs finishing**: Set a destination and Complete the destination. Backups shows two filled
buttons side by side, Change destination and Take a backup, with the main one still last. Only the
toolbar follows this rule: a side panel keeps exactly one primary action, and Discard stays
outlined beside Save. `toolbarActionsFilled.test.js` reads every `.filter-bar-actions` group in
the source and fails on an outlined button written into one.

**A control for a page's groups sits over them, not in the toolbar.** Expand all and Collapse all
(`ExpandAllToggle`) act on the groups the page draws, not on what it filters, so they are the first
control, at the far left, of the row above the groups. That row is `.groups-header`, which the Audit
Trail, History, Metrics and Vocabulary all use. A line saying what is shown goes beside it, as on
History, and a key goes at its right-hand end. The row sits outside the scroller, so it stays on
screen. Check 371 (`scripts/check-docs-drift.mjs`) reads the source and fails on a toggle written
into a toolbar, or anywhere but first in this row.

**Refresh and its interval are one control**, `RefreshButton` (`common/RefreshButton.jsx`), as
Grafana's refresh picker is. The filled Refresh button reads again now. The select joined to its
right half sets how often it happens by itself: Off, then the page's intervals. A page that
refreshes both by hand and on a timer uses it, not a button and a select apart: System › Logs and
History. `everyDisabledReason`, a sentence, turns the interval half off and is its tooltip, while
the Refresh half still reads; History passes one while its window has ended.

**Every list filter takes several values, through one shared part**, `common/FilterChecklist.jsx`,
as Home Assistant's entity filters do. A filter that picks from a list is never a `<select>`; a
yes-or-no choice stays a toggle button in the toolbar.

- **In the toolbar it is a `FilterDropdown`**: a `ToolbarPopover` button where the select was,
  the same width (`width`: `sm`, `md` or `lg`), so the row keeps its shape whatever is chosen. It
  reads "Any status" with nothing chosen, the value with one, and "2 statuses" with several
  (`filterWords`). A page may name a choice, as Schemas' Current is Active and Draft. Its name is
  "Status: Any status", and its panel ends in Clear, which returns it to its default.
- **In a Filters panel it is a `FilterList`**, with an optional HelpTip, and the panel's own Clear
  resets it. A yes-or-no choice in a panel is a `FilterCheck` checkbox: Show deleted entities, Show
  replay lanes.
- **A Filters panel with several lists makes each a section that opens and closes**, as Home
  Assistant's filter pane does, so the panel is the one scroller. `FiltersPopover` finds the
  `FilterList`s written into it and draws each under a `GroupHeading` that says what is chosen in
  it: "Entity · 2 chosen", the value's name when one is chosen, or the name alone.
  - One section is open at a time. As the panel opens, the first list whose choice differs from its
    `defaultValue` opens, or else the first list. Devices' Lifecycle at Active does not count.
  - An open list is at full height, with its search box over it. Only a toolbar dropdown's list
    scrolls on its own. The panel's `FilterCheck` boxes stay under the sections.
  - Which section is open is not in the address, and starts again each time the panel opens. A
    pressed heading keeps the focus while the list it closes goes.
  - A panel with one list draws its label, not a heading.
  - Write each list straight into the panel, not inside a `<div>`, or the panel cannot find it.
    Check 203 holds this, and that nothing in App.css scrolls a list inside the panel.
- **The checklist** draws the values under headings when the options carry a `group`, and flat
  when none does. A heading's checkbox chooses or clears its group, and is mixed while some of it
  is chosen. Over eight values it has a search box; while a search is typed, a heading acts on the
  values it shows. Each value's count is the rows that have it among those the page's other
  filters let through (`applyFacets`, `utils/listFilters.js`). ↑ and ↓ move between the
  checkboxes, Space ticks one, and Escape clears the search before it closes the panel.
- **An option is `{ value, label, group?, note? }`.** `note` is why a value cannot occur with what
  else is chosen ("not with Cells"). The row dims its name and shows the note before the count, and
  the note is part of the checkbox's name. A page keeps such a value listed only while it is chosen,
  so a choice that stops applying stays to be undone and is never cleared by itself.
- **One meaning everywhere**: any value within a filter, every filter together, and nothing chosen
  is no constraint. Lifecycle (`LIFECYCLE_OPTIONS`) is Active and Archived and opens on Active;
  both chosen, like none, shows every row.
- **The address carries the list** (`useUrlList`, `hooks/useUrlState.js`): `?status=online,offline`,
  with a comma inside one value escaped. A link written with one value opens as a list of one. An
  old single value, such as `lifecycle=all`, is read through its alias and the address rewritten
  as the values it meant. A change replaces the history entry, as `useUrlState` does.
- **The Audit Trail's three lists are the server's** (`audit_trail_page()`'s arrays, `0227`), so
  they filter before the row limit. Its kinds are grouped by `group` in `AUDIT_TRAIL_ENTITY_TYPES`
  (the plant, the model, capture, security), its actions by `AUDIT_TRAIL_ACTION_GROUPS`, and
  Changed by into People and Machine identities.
- **Its kinds and actions carry the server's counts** (`p_counts`, `0228`), each under every filter
  but its own, asked for with the first page and the poll. **They narrow each other by
  `AUDIT_TRAIL_ACTION_KINDS`**, the mirror of `audit_trail_action_kinds()` (`0229`, mirror check 43):
  a list offers a value that can occur with the other lists' choices and the legend's classes, one
  that did occur, and one that is chosen, noted where it cannot occur. With no kind chosen, an action
  is one the role's own kinds can have.
- **The Audit Trail's legend is its class filter.** The server names each event's class
  (`audit_event_class()`, `0228`) and the page draws that marker; it has no rules of its own.
  Each class's entry is a counted toggle, `btn-ghost` or `btn-primary` with `aria-pressed`, as a
  toolbar's counted toggles are. Several may be on, none on is every class, and the address keeps
  them as `?class=lifecycle,read`. `AUDIT_TRAIL_CLASSES` lists them in the legend's order and mirror
  check 44 holds them, and `MARKERS`, to the function and its indexes. Read is a grey eye in
  `--text-muted`. In a toggle each marker sits on a disc in `--bg-card` (`.trail-legend-disc`), as
  it sits on the card on the track, so a pressed toggle's accent fill never meets it.
  `themeContrast.test.js` holds every marker at 3:1 on the track and in its toggle, pressed or not,
  in both themes. The legend sits at the right-hand end of the row above the timeline, with Expand
  all and Collapse all at its start, over the section headings they act on.
- **Checks.** Check 193 (`scripts/check-docs-drift.mjs`) refuses a select in a toolbar, but System ›
  Logs' Service and Level, each one value `service-logs` takes. Check 194 holds the Audit Trail
  help's group names to `constants.js`. Mirror check 42 (`scripts/check-mirror-drift.mjs`) holds
  each kind's domain, and so its group, to `audit_domain_for()`.

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

### One time control for every period

**A page that shows a period uses `common/TimeWindowControl.jsx`**, the Audit Trail first. The
arithmetic is `utils/timeWindow.js`, and `hooks/useTimeWindow.js` keeps the window in the address.
A page needs three lines:

```jsx
const [win, setWin] = useTimeWindow({ ranges: TIME_PRESETS, allTime: true, fallback: ALL_TIME })
<TimeWindowControl value={win} onChange={setWin} ranges={TIME_PRESETS} allTime />
const { since, until } = timeWindow(win)   // at fetch time: ISO instants, '' for no bound
```

- **The props.** `value` and `onChange` are the window. `ranges` is the rolling ranges the page
  offers: `TIME_PRESETS` (15 minutes to 30 days) or some of them. `allTime` adds All time. `spans`
  is the spans the switch offers: `SPAN_IDS` (all four, the default) or some of them. Pass the
  same to `useTimeWindow`, with `fallback`, the window shown when the address names none. Pass
  module-level constants, as the window is memoised on them. The Audit Trail offers every range,
  every span and All time, and falls back to All time. System › Logs offers its own five ranges
  (Last 6 hours among them), Day and Week, and no All time, since a read covers at most 7 days; it
  falls back to Last 1 hour.
- **A span a page does not offer is passed over** in the address, which then falls back, and Jump
  to lands on Day, or on the first span offered where Day is not.
- **Left to right**: ‹, the window in words with a chevron, ›, then the Day | Week | Month | Year
  `SegmentedControl`, then Zoom in and Zoom out where the page asks for them. Today is in the
  popover's Jump to, not a button of its own. It goes after the search box, which stays first. It is one unit that does
  not wrap inside itself, so a toolbar that wraps moves it whole.
- **The words open a `ToolbarPopover`**, the frame `FiltersPopover` is drawn in: the same place,
  arrow, Escape and click-outside rules, and the chevron every popover's button ends in. Focus moves to the panel's first control as it opens,
  in the Filters panel too. The groups are Jump to (Today, Yesterday, A week ago, A month ago,
  Start of the year, and a date field), Rolling, and Custom range (two `datetime-local` boxes and
  Show range).
- **The arithmetic is local calendar time.** A day runs from one local midnight to the next, so a
  step moves by date, never by 24 hours: 25 October 2026 was 25 hours long in London. Weeks start on
  Monday. Choosing a span keeps the day shown. Under a rolling or custom window, or All time, no
  span is chosen; choosing one shows the span that holds the window's end. A rolling window
  becomes fixed when stepped, measured from the current minute. A custom window steps by its own
  length, by date when it is whole days.
- **The arrows** are named by the span (Previous day, Next week), or Earlier and Later for a window
  that steps by its own length. › is `aria-disabled` while the window holds now, as the Audit Trail
  drawer's end buttons are, and both are under All time. The tooltip says why. No key is bound: `[`
  and `]` change tab, and the arrow keys step the Audit Trail's drawer. An arrow, Today or a span
  is said in a polite `role="status"` line ("Showing Tue 3 Nov").
- **The address.** A calendar window is `span` and `at` (`?span=day&at=2026-11-02`; no `at` means
  today). A rolling one is `range`. A custom one is `from` and `to`, local `YYYY-MM-DDTHH:mm`, and
  `to` is the first minute outside the window. The Audit Trail's older `since` and `until` are read
  as `from` and `to`, and the address is rewritten that way. The old `until` included its whole
  minute, so its `to` is a minute later and the same rows come back. A step, a span or a choice in
  the popover replaces the history entry; a zoom adds one.
- **Zoom is opt-in: `zoom`.** It adds Zoom in and Zoom out after the switch, in the expanded plan's
  order and with its glyphs (`IconZoomIn`, `IconZoomOut`). Zoom in shows the middle half of the
  window and Zoom out twice it about the same middle, each as a custom window to the second
  (`zoomIn`, `zoomOut`). Zoom in stops at `ZOOM_FLOOR_MS` (one minute), since under an hour the axis
  prints seconds. Zoom out has no limit, but a window that would end past the current minute is
  moved back to end with it, so it holds now. A rolling window is measured from the current minute,
  as a step measures it. Where a window has no bounds of its own (All time, or a custom range with
  an end left out), Zoom in halves `extent`, the `{ start, end }` the page's axis draws; Zoom out is
  off under All time. An off button is `aria-disabled` with its reason in the tooltip, as the arrows
  are. The Audit Trail and History pass `zoom`; System › Logs does not.
- **Back undoes a zoom.** A zoom calls `onChange(next, { replace: false })`, and `useTimeWindow`'s
  setter then adds a history entry (`navigate()` without `replace`). Everything else calls
  `onChange(next)`, which replaces the entry. A page that wraps `onChange` passes the second
  argument on.
- **A drag across the Audit Trail zooms too.** A mouse or pen press on the axis or an empty part of a
  track, moved at least `BAND_DRAG_PX` (4px), shades a band (`.trail-band`) through
  `hooks/useBandDrag.js`. It is drawn on the axis, on each section heading and in the gridlines
  layer, as the hatched parts are. The axis words
  it with `bandWords` ("10:05 – 10:40, 35 min"), and a release sets `bandWindow(start, end,
  axisMs)`: to the minute on an axis of an hour or more, to the second under one, and never under
  the floor. A press on a marker or a badge starts no band, so it still opens; nor does touch, so a
  finger scrolls the page. Escape drops a band, and keeps the key from the drawer. Both functions
  take times, not pixels, so another timeline's drag can use them: History's does, through the same
  `useBandDrag`, which takes the track to press, what to skip and the track's end padding.
- **The words** come from `windowWords`, in the browser's locale, as the axis ticks are, so a
  language setting can pass its own. No date library.
- **The axis is the window.** On the Audit Trail, All time's axis is the events'; any other window's
  is the window itself, with calendar ticks at local hours, days, weeks or quarters
  (`calendarTicks`). A window that runs on past now draws "Now 15:20" there (`.trail-now`). The
  part after it is hatched and says "Nothing recorded yet" (`.trail-shade`).
- **A bounded window loads everything in it.** Under any window but All time the Audit Trail asks
  for page after page by itself, until no page is left or `WINDOW_EVENT_CAP` (2,000) events are
  loaded. Each page is a request that scans the whole match, and every event is a marker to lay out
  and cluster, so a busy month stops there. Only then, when loading stopped short of the window's
  start, is the part before the oldest loaded event hatched, and it says when the cap stopped it.
  Show more goes on from there a page at a time. A page that fails, or adds nothing, stops the loop,
  and a page asked for under an older filter is dropped when it lands. All time loads one page and
  keeps Show more.

### History and its chart

**History charts a device's readings over a window** (`tabs/HistoryTab.jsx`, `tabs/HistoryDevice.jsx`).
Its arithmetic is `utils/history.js`, and `__tests__/history.test.js` holds each rule.

- **The window** is the shared `TimeWindowControl` with every rolling range (`TIME_PRESETS`) and
  every span, and no All time. It falls back to Last 24 hours (`DEFAULT_HISTORY_WINDOW`).
- **The read** is `api.readCarriedTelemetry()`, the RPC `telemetry_carried()` (`0233`): one row per
  metric per bucket, a bucket with no reading carried forward and marked `is_carried`. Text and
  flags take the change read beside it (below).
- **The row cap picks the resolution.** `pickResolution()` takes the finest of `HISTORY_RESOLUTIONS`
  (`api.js`: the rollups' 1 minute, 5 minutes and 1 hour, then 1 day) whose rows, buckets times
  the metrics chosen, fit `HISTORY_MAX_ROWS` (5,000, `TELEMETRY_MAX_ROWS`). A bucket is counted from
  the one holding the window's start, on the epoch grid the rollups use. When no resolution fits
  every metric, the coarsest reads them in parts. The page says which it shows ("3 of 10 metrics,
  in 1-minute buckets").
- **Buckets** (`HISTORY_BUCKETS`, `?bucket=`) is Auto, `pickResolution()`'s pick, or one size, in
  a `ToolbarPopover` as the time window is. `resolutionFor()` reads a coarser size with every
  metric in one read. A finer one would pass the cap: `bucketOptions()` lists it `aria-disabled`
  with `TOO_MANY_BUCKETS` as its tooltip, and an address naming one is read at Auto's pick, the
  status line saying so. A toolbar keeps no `<select>` (check 193), so this is not one.
- **Text reads apart under Auto** (`readPlan()`). A metric's kind is known before it is read, from
  its catalog datatype (`datatypeKind()`: String, Text and UUID are text, Boolean a flag, the rest
  numbers). Text metrics read at `readableResolution()`: the finest whose buckets are each at least
  `TEXT_BUCKET_MIN_PX` (3px) across the chart and whose rows fit the cap, since one-minute buckets
  over a day run a strip's words together. The width is a chart box's, measured at each read; a
  change of width settles for 300 ms and reads the text again only when it changes their pick.
  Numbers, flags and a metric the catalog does not know keep `pickResolution()` for their own
  count. The status line says "3 metrics, in 1-minute buckets; text in 5-minute buckets", and each
  chart's summary names its own bucket. A Buckets choice reads every chart at it, text included.
- **Text and flags take the change read too** (`readPlan()`'s `changes`, whatever the buckets):
  `api.readTelemetryChanges()`, the RPC `telemetry_changes()` (`0254`), beside the bucket read, in
  parts of `HISTORY_CHANGE_SERIES` (50), on each group's buckets. A row that is every change is
  drawn from it (`changeSeries()`); `change_cap` (past `HISTORY_MAX_CHANGES`, 2,000),
  `reading_cap` (past `HISTORY_CHANGE_READINGS`, 20,000) and `retention` draw the bucket read,
  the first two with the buckets that held more than one value marked (`markBuckets()`). A bucket
  keeps only its last value, so without the change read a state held inside one would not be
  drawn ([#1370](https://github.com/Harri-Llewelyn/Aber/issues/1370)). The status line names the
  state charts' read (`stateReadLine()`): "…; text and flags show every change", else the first
  chart's fallback, "the last value in each 5-minute bucket, past the 2,000-change cap"
  (`readWords()`), and a chart reading otherwise says its own in its head (`note`). A metric with
  no change row, the catalog not knowing it, keeps the bucket read and the old wording. Export CSV
  does not follow it.
- **The metrics** are those the device's last birth declared and those its schemas model
  (`deviceMetrics()`); each one's valid range is its schemas' `minimum` and `maximum`
  (`validRanges()`), and its unit the catalog's. **Metrics** in the toolbar is a `FilterDropdown`
  over them (`?metric=`, `useUrlList`); nothing chosen charts every one. A name the device does not
  have is dropped from the address, so a device switched to keeps the names it shares.
- **Clear filters** counts and resets the window (off `DEFAULT_HISTORY_WINDOW`), the metrics and
  the buckets. The device is the page's subject, not a filter, and stays.
- **The charts are grouped by catalog datatype** (`metricGroups()`), each group named as the
  Metrics page names the type (`datatypeLabel()`) and in `GROUP_ORDER`: Double, Float, the
  integers, Boolean, String, Text, any other type by its code, then Other for a metric the catalog
  does not know. Each group is a `GroupHeading` with its count, which opens and closes it, and
  `ExpandAllToggle` does every group from the start of the row above the charts (`groups-header`), as the Audit Trail has it over its sections. A closed
  group only unmounts its charts: the reads, the row cap and the Metrics filter are unchanged. Which
  are closed is kept in this browser (`CLOSED_GROUPS_KEY`, localStorage, by datatype code, read and
  written in try/catch), not in the address. The Metrics dropdown's options carry the same
  `group`, so its checklist draws them under the same headings.
- **The charts scroll inside the card**, as Overview's lanes do (`.card-fill-scroll.trail-timeline`,
  then `.trail-scroll`): the toolbar and the row above the charts stay, and a group's heading pins
  while its charts are in view. A chart is its box's width, so a scrollbar narrows it
  (`TimeSeriesChart` resizes uPlot on its box), and never sideways.
- **Refresh** is `RefreshButton` with `HISTORY_REFRESH_EVERY` (Off, 30 s, 1 min, 5 min; no 10 s,
  since each read reads every chart again). The interval is the page's state, as Logs keeps it, so
  it outlasts a change of device. `usePolling` runs it only while the window reaches now
  (`holdsNow()`); for a window that has ended the interval half is off with the reason. A read in
  flight keeps the charts on screen, and only the newest read lands.
- **Export CSV** (`filter-bar-actions`, after Clear filters and before Refresh, as the Audit
  Trail places its own) opens `TelemetryExportModal` with what the page shows: the device, the
  metrics chosen and the window, resolved to ISO bounds as it opens. It is for an Administrator or
  a Shopfloor Manager, and for a window within `history.export_max_days`; every rule is in
  [History's Export](#historys-export).
- **Zoom** is the time control's `zoom` and a drag across any chart (`useChartBand`, shared with the Cell
  tab, over `useBandDrag` on each `.u-over` and state strip, which are the window's width). The page holds the band and every chart
  shades it (`band`, `.chart-band` with the trail's look) with `bandWords()`; a release calls
  `setWin(bandWindow(start, end, axisMs), { replace: false })`, so Back undoes it, keeping the
  metrics and the buckets. uPlot's own selection stays off: one band covers the number charts and
  the state strips alike, and Escape, the 4px click and touch behave as on the Audit Trail.
- **The address** is `/history/device/<id>` with the window's keys, `metric` and `bucket`;
  `/history` is the picker. `pickedAddress()` builds both, and the device drawer's View History links to `deviceHistoryUrl()`
  (`routes.js`). Choosing a device adds a history entry.

**Overview is History's first tab and its default** (`tabs/HistoryOverview.jsx`): where readings
arrived over the window, a lane per device, before anything is charted. Its arithmetic is in
`utils/history.js` too, and `__tests__/historyOverview.test.jsx` holds each rule.

- **The layout is the Audit Trail's lane grid**, on its classes (`.trail-swimlanes`, `.trail-axis`,
  `.trail-section`, `.trail-lane`, `.trail-lane-label`, `.trail-track`): a label column of
  `--trail-label-width`, then a 28px track a row, under the trail's axis with its empty corner. A
  group is a section row, its `GroupHeading` in the label column (a cell's a step in, pinned one
  row below its area's) and, when closed, its merged strip in the track. The grid scrolls inside
  the card (`.card-fill-scroll.trail-timeline`, then `.trail-scroll`), so the axis and the headings
  pin and the row above the lanes stays. Overview's axis follows the Audit Trail's, not the Device
  tab's charts: the tracks run from the label column to the card's edge, and no longer span the
  charts' plot gutters (`PLOT_LEFT_PX`, `PLOT_RIGHT_PX`). Overview's own rules (`.overview-*`) are
  only what it adds; the Audit Trail is unchanged.
- **The read** is `api.readCoverage()`, the RPC `telemetry_coverage()` (`0245`): one row per device,
  its readings in each block as an array, and the stretch the historian's device rollups have
  counted. It reads every device in parts of `COVERAGE_MAX_DEVICES` (1,000), again on Refresh and
  its timer, and when a settled width changes the blocks. A window older than the 5-minute device
  rollup reaches comes back in hours (`block_width`); the strips are laid on the width that came back
  (`readWidth()`), and the status line names it.
- **The blocks** (`coverageBlock()`): `COVERAGE_SMALL_SELECTION` (40) devices or fewer take the
  finest of `COVERAGE_BLOCKS` at about one block per `COVERAGE_BLOCK_PX` (4px) of the strip. More
  take the device rollups' own widths only, 5 minutes up to 26 hours and 1 hour up to
  `COVERAGE_LARGE_MAX_HOURS` (a week), so nothing is summed on the historian. A longer window reads
  the devices the search matches when they are 40 or fewer, and otherwise says why
  (`TOO_LONG_FOR_MANY`). The status line names the block size.
- **The groups** (`overviewGroups()`) place devices as the Site Map does, from the same helpers
  (`inServiceDevices()`, `groupDevicesByCell()`, `areaWideInService()`, the location sources): each
  area in service with its cells and its Area-Wide devices, the cells in no area, then Site-Wide,
  Simulated and Unassigned. Archived devices are left off, as on the Site Map. Each heading is a
  `GroupHeading` with "4 devices" as its `detail`; a closed group draws one strip of its devices'
  counts merged and renders none of its lanes. Which are open is kept in this browser
  (`OVERVIEW_GROUPS_KEY`, `{ key: open }`, in try/catch); on a first visit every group is open
  unless there are more than `OVERVIEW_OPEN_LANES_MAX` (200) lanes.
- **A lane's label** is its tick box, its status dot (`badge-dot` with `deviceDotStyle()`, and
  "Offline" in words, as the trail's deleted flag is), its name (`OverflowText` in a link to its
  charts) and its metric count as `.trail-lane-qualifier`. **Its track** holds its strip, runs of
  one shade (`coverageSteps()`, `coverageRuns()`), four steps of `--coverage-1` to `--coverage-4`
  against the strip's busiest block, each run one box, a block with none the track's own colour;
  and at its right-hand end "No readings since 15:00" (`readingsStopWords()`). The steps
  are one sequential blue ramp a theme, held by `themeContrast.test.js` to the ordered-ramp rule:
  lightness moves one way and the step nearest the card clears 2:1. The future is the trail's
  `.trail-shade-future`; a stretch the rollups have not counted yet (`uncountedStretches()`) is
  `.overview-uncounted`, cross-hatched, and the status line says "Coverage before 3 Oct is still
  being computed" (`uncountedWords()`).
- **The readout**: the block under the pointer, on a lane's track or a closed group's, in words
  (`blockReadoutWords()`): "10:05–10:10 · 412 readings", "No readings", "No readings yet" after
  now, or "Not counted yet". A step under 3:1 is why: the count never depends on the colour. It is
  the tooltip's bubble and arrow (`.tooltip-bubble`), portalled as the tooltip is, centred under the
  block and kept to its track (`placeReadout()`), above it only where the scroll area has no room
  below, as on the last lane: never over the strip it reads. A scroll closes it, and none is drawn
  while a box is drawn or held.
- **The selection box** is a drag across the tracks (`useBandDrag` over `.overview-swimlanes
  .trail-track`, whose band carries the press's and the pointer's `clientY`; the rows under that
  stretch are the box's devices). While it is drawn, the axis names it (`.trail-band-words`, held
  inside the track near either end, with `boxWords()`). Once released it stays, and
  `SelectionPopover` opens beside it, as on AMRC ACS's Datasets page: its words, **Chart** (the
  Device tab for one device at the box's window, and for several the Metric tab narrowed to them,
  `chartAddress()`), **Zoom** (the window as a new history entry) and **Clear**. It is portalled to
  `<body>` and fixed, as `ToolbarPopover` is, so the card cannot clip it, below the box's visible
  part or above it where the window has no room (`placeSelection()`), with the popovers' arrow
  (*Popover arrows*, `.overview-popover::before`). The popover itself takes focus as it opens, not
  its first action, whose tooltip would cover the box; Tab reaches the actions and stays inside it. Escape, Clear, a press outside, a scroll and a resize close it and clear the
  box, and focus goes back to the box's first lane. The tick boxes (`?device=`, telemetry keys) are
  the other way: the toolbar's **Chart** charts them at the control's window.
  **Export CSV** is in the popover, after Zoom, and in the toolbar beside Chart for the devices
  ticked ([History's Export](#historys-export)). `.groups-header` holds Collapse all, the status line and
  the key, on Overview and the Device tab alike.
- **The address** is `/history/overview` with the window's keys and `device`; bare `/history` opens
  Overview too (`historyPath()`, `overviewAddress()`), and `/history/device` is the picker.

**`common/TimeSeriesChart.jsx` is the one time-series chart**, on uPlot, which later tabs reuse.
It draws the bucket's average as the line and its minimum to maximum as a band. A carried bucket
is on a dashed line, never on the solid one, so a quiet stretch never reads as a measured one. A
flag steps between false and true, and a state is a strip of its runs in text.

- **The head** reads the bucket under the pointer, and otherwise the latest reading
  (`latestWords()`): the newest bucket a reading arrived in, never a carried one, with its `last`
  value and the bucket's start, since a bucket is not a reading's timestamp.
- **A state** is `stateRuns()`, clipped to the window and to now. Each value's colour comes from
  its text: `stateHue()` hashes it (djb2, then murmur3's finaliser, so names a character apart do
  not land a degree apart) to a hue, which the box carries as `--state-hue` through React's style,
  the CSSOM, so the CSP is unchanged. App.css draws it as `oklch()` of the theme's
  `--chart-state-l` and `--chart-state-c` and that hue, with a stronger edge. The same value is the
  same colour on every chart, device, refresh and session, and a value never seen before has one.
  At those tokens every hue is inside sRGB, the label clears 7.4:1 (dark) and 13:1 (light) on its
  box, and the edge 3:1 on the card; `themeContrast.test.js` walks all 360 hues. A hash is not a
  meaning: two values can land near each other (about one pair in twelve within 15°), and IDLE is
  not grey, so each box keeps its name and colour is never the only cue. `colourLiterals.test.js`
  allows an `oklch()` of three tokens alone, which writes no colour. A carried stretch inside a run
  is hatched. Under the strip, `stateKey()` names the `STATE_KEY_MAX` (6) values with the most time
  and counts the rest as others. The head reads the run under the pointer (`runWords()`). A box
  under 24px keeps its colour and edge at its own width, at least 2px, and no name
  (`chart-state-thin`), so a change of seconds over a day still shows and none is drawn wider than
  its time.
- **Every change** (`changeSeries()`): a text's or a flag's series laid on its changes' own times,
  with `runs`, `exact`, each value's real stretch. `starts` are the window's start when a value was
  carried in, each change, and where the last run stops, so a flag's stepped line steps when the
  value did, and its carried start is dashed. The head reads the run at the pointer's time
  (`runNear()`, which prefers a run thinner than 8px within 4px of it) to the second. A bucket
  series may carry `marked` (`markBuckets()`): a flag's bucket that held both values is the band
  from false to true, and a state's is dotted along the strip's foot (`chart-state-mixed`), named
  in the key and read under the pointer (`markWords()`).

| Prop | What it is |
| :--- | :--- |
| `metric`, `unit` | The title, "Spindle/LOAD (kW)", which names the figure and its chart. `unit` is the catalogue's code, `KILOWATT`; the chart says its symbol |
| `starts` | Each bucket's start in seconds: `bucketStarts(start, end, minutes)` |
| `series` | `chartSeries(rows, starts)`: `kind`, then `avg`, `min`, `max`, `carried`, `states` and `last`, one entry a bucket |
| `start`, `end` | The window in milliseconds. The time axis is exactly the window |
| `now` | The clock. Inside the window, a Now line and label, and a hatched "No readings yet" after it |
| `minutes` | The bucket's width: a state strip's runs, and the times the head says |
| `validRange` | `{ minimum, maximum }` from the schemas, or null: a dotted line labelled "valid range" |
| `summary` | `chartSummary()`: the metric, the window, the resolution, the latest reading and its bucket, the lowest and highest, a state's shares, the carried buckets and the valid range, for a screen reader |
| `syncKey` | Charts sharing it share the cursor, so every chart of a device shows the same moment |
| `band` | A drag's band, `{ lo, hi, mid, words }` (fractions of the window, and `bandWords()`), shaded over the plot or the strip, or null |
| `height` | The plot's height in pixels, 140 by default |
| `yRange` | A number chart's value scale, `[low, high]`, or null for uPlot's own: charts that compare share one (`sharedScale()`). Pass the same array while it is the same: a new one draws the chart again |
| `label`, `head` | `label` names the chart in place of the metric and unit. `head` is what the title line shows in place of that name, such as a status dot and a link: the figure keeps `label` as its name |
| `plugins` | uPlot plugins for a number or flag chart, such as the alert bands, or none. A new array draws the chart again, so pass the same one while it is the same. A state strip takes none |
| `note` | Which read the chart shows, in the head, when the status line says another (`readWords()`), or null |
| `derived` | True for a derived metric: a `DerivedTag` beside the title, and "a derived metric" in the summary ([History's derived metrics](#historys-derived-metrics)) |

- **No sideways scrolling.** The chart is its container's width, and a `ResizeObserver` resizes it.
- **Colours and the font are the theme's tokens** (`chartPalette()`), read again when
  `<html data-theme>` changes, so a theme switch redraws it.
- **uPlot's own drag selection is off** (`cursor.drag` x and y false, `select` hidden): a chart
  never rescales itself, and the page's window is the only zoom. A drag zooms that window (`band`).
- **Under the Content-Security-Policy**, uPlot sets styles through the DOM (`element.style`), which
  `style-src` allows, and its stylesheet is imported through the bundle. The chart's first comment
  carries uPlot's MIT notice, because the build drops uPlot's own (NOTICE.md).
- A browser that cannot draw on a canvas gets the summary and a line saying the chart could not be
  drawn.

### History's Cell tab

**History's Cell tab compares one metric across the machines of a cell** (`tabs/HistoryCell.jsx`,
`/history/cell/<id>?metric=…`). Its arithmetic is `utils/history.js`, `__tests__/historyCell.test.js`
holds each rule and `historyCellPage.test.jsx` the page. It is the first tab built on the shared parts the Area and
Metric tabs reuse: `common/SmallMultiples.jsx`, `common/HourHeatmap.jsx`, `common/DeviceStatusDot.jsx`,
`common/AlertKey.jsx`, `hooks/useChartBand.js` and `useAlertBandsFor()`.

- **The cell** is picked from a table at `/history/cell` (`CellPicker`, searchable and sortable
  as the device picker is), by the toolbar's cell name (a `ToolbarPopover` of the others, keeping the window and the
  metric), or from the Cells drawer's **View History** (`cellHistoryUrl()`, worded and drawn as the
  Devices drawer's). Its machines are its devices in service (`historyCells()`, from
  `groupDevicesByCell()` and `inServiceDevices()`, as the Site Map and Overview place them). An archived cell is listed, with a badge, so the
  action is never a dead end; it has no machine in service. The tab lists no device status: that is the Cells page.
- **The metric** is one of those the machines report (`cellMetrics()`: the last birth's and the schemas', as
  `deviceMetrics()`), with how many report it. `?metric=` holds it; with none, the tab opens on the metric
  most machines report (`defaultCellMetric()`), and an address naming one the cell does not report is tidied
  away. A machine that does not report it is named in words (`silentWords()`), never given an empty chart.
- **One read, at the finest resolution the row cap allows.** `pickResolution()`, as the Device tab has it, with the
  reporting machines as the series: the finest of `HISTORY_RESOLUTIONS` whose buckets times machines fit
  `HISTORY_MAX_ROWS`, the status line saying which (`multiplesWords()`, "20 machines, in 5-minute buckets"). One
  `telemetry_carried()` call carries every machine; only past the cap at the coarsest resolution does it read in
  parts of `perRead` machines, and says so. A text or flag metric takes `telemetry_changes()` too, in parts of
  `HISTORY_CHANGE_SERIES`, and draws every change per machine as the Device tab does.
- **`SmallMultiples` draws one chart a member on one scale.** `sharedScale()` is the lowest minimum to the highest
  maximum across every number series, padded by 8%, and is each chart's `yRange`; the line above the charts says it
  in words. A flag's scale is its own. The time axis, the cursor (`syncKey`) and the zoom band are shared, as on the Device
  tab: `useChartBand()` holds the drag, which both tabs use. A member's title line is its status dot
  (`DeviceStatusDot`, as the Site Map draws it, with "Offline" in words), its name as an `OverflowText` link to its
  charts on the Device tab, and the alert shading from one `alert_occurrences()` read for every machine
  (`useAlertBandsFor()`, applied apart from the series, so the alerts arriving does not draw a chart again).
  A member is `{ key, name, device?, to?, series?, starts?, validRange?, read?, plugins?, absent? }`; one without `series`
  says `absent`.
- **The heatmap is `HourHeatmap`, a plain HTML grid** (no second library): a row a machine, 24 columns `00` to `23`
  that share the width after a column of names, so nothing scrolls sideways. A cell is coloured by `heatStep()`: the
  Overview's four shades (`--coverage-1` to `--coverage-4`, `.heatmap-step-N`, held by `themeContrast.test.js` and
  drift check 308), in equal widths between the lowest and the highest mean across every machine, so one scale holds
  them all. Never colour alone: the key names each shade's values in words (`heatBands()`, "20 to 40.75 kW") and an
  hour with no value, a cell is read in words under the grid on the pointer and on keyboard focus (`heatCellWords()`,
  "Lathe 3 · 14:00–15:00 · 54 kW, the mean of 7 days"), and its `aria-label` says the same. It is an ARIA grid with one
  cell in the tab order; the arrow keys, Home and End (with Ctrl, the first or last row) move between cells. A machine
  that does not report the metric is a row of words.
- **The hours are in the browser's time zone** (`browserTimeZone()`, `Intl`; UTC where it cannot say), read by
  `api.readHourOfDay()`, the RPC `telemetry_hour_of_day()` (`0265`), which folds `telemetry_carried()` at one hour into
  machines times 24 rows where the read is made. So a cell of 20 over a Month brings 480 rows to the browser, not 14,400.
  It refuses more than `HOUR_OF_DAY_MAX_ROWS` (50,000) hours times machines, as `telemetry_carried()` does, so the page checks first
  (`hourOfDayPlan()`) and says the longest window those machines allow in words, "for 20 machines it covers at most
  104 days", while the charts go on. A text or flag metric has no mean: the heatmap says it needs a number and reads nothing.
  The charts and the heatmap are two reads that refresh together and fail apart.
- **The address** is `/history/cell/<id>` with the window's keys and `metric` (`cellAddress()`); `/history/cell` is the picker.

### History's Metric tab

**History's Metric tab compares one metric across every device that reports it**
(`tabs/HistoryMetric.jsx`, `/history/metric/<name>?area=&cell=&devices=&page=`). Where the Cell tab
groups by place, this groups by metric: "how do the bearing temperatures of all our lathes compare?",
where the lathes sit in several areas. Its arithmetic is `utils/history.js` and `utils/historyReads.js`;
`__tests__/historyMetricArea.test.js` holds each rule and `historyMetricPage.test.jsx` the page.

- **The metric** is picked from a table at `/history/metric` (`MetricChooser` in `HistoryTab.jsx`: the
  metric, its unit and how many devices report it, searchable and sortable as the other pickers are), or by
  the toolbar's metric name (a `ToolbarPopover`, keeping the window and the filters), from **Chart** in
  Overview's selection box, or from any Metrics drawer's **View History** (`metricHistoryUrl()`, ungated like
  the other drawers'). The metrics offered are those some device in service reports (`historyMetrics()`:
  `cellMetrics()` over every device, a last birth's or a schema's), with the catalog's unit and kind where it
  has them. A metric the catalog does not know is offered all the same, with no unit: it is reported, and the
  Cell tab charts it. A derived metric is offered where some device reports all its inputs (`deviceMetrics()`
  with the catalog), with its *derived* tag.
- **The name is one path segment**, `encodeURIComponent()`, so `Spindle/LOAD` is `Spindle%2FLOAD`
  (`metricHistoryPath()`, `metricNameFrom()`). An address naming a metric no device reports says so and links
  the picker.
- **The devices** are those in service that report the metric (`metricDevices()`), narrowed by the Filters
  panel's Area, Cell (listed under their areas) and Device lists, which offer only what reports the metric.
  `area` and `cell` are ids and `devices` telemetry keys, comma-separated, as Overview's `device` is. A
  device in no cell and no area is in none of an Area or Cell filter's choices, so any choice leaves it out.
  A value the metric does not offer is tidied away. A new set of devices starts at the first page.
- **One read at the finest resolution the row cap allows**, as the Cell tab has it, with the devices as the
  series (`metricPages()`, `pickResolution()`), the status line saying which ("12 devices, in 5-minute
  buckets"); more devices than one read carries are read in parts (`readDeviceSeries()`). A text or flag metric
  takes `telemetry_changes()` too and draws every change per device, as the Cell tab does. Each chart's title
  line is the device's status dot, its name as a link to its charts on the Device tab, "Offline" in words, and
  where it sits (`place`, "Turning · Hall B", an `OverflowText`).
- **It pages** (`page` in the address), `METRIC_PAGE_SIZE` (12) devices a page, past the number the row cap
  can carry at the coarsest resolution, a day (`pickResolution()` giving `perRead` fewer than the devices:
  13 for a Year of day buckets), and past `METRIC_DRAW_MAX` (200) devices where the cap would carry them all,
  since a page of hundreds of canvases does not draw. Each page is read apart at the finest resolution its own
  devices fit, and has its own scale ("One scale for every device on this page", `SmallMultiples`' `scope`).
  The status line says so in words (`pagingWords()`) and a pager, Previous and Next with "Page 2 of 5", sits
  after the scroller as `ListFoot` does. A page past the last is the last. A page of 12 is one read for any
  window up to 416 days.
- **The alert shading, the zoom, Refresh and the refresh timer** are the Cell tab's: `useAlertBandsFor()`
  over the devices on the page, `useChartBand()`, and one read made again on a change of metric, filters, page
  or window.

**Chart in Overview's selection box** opens the Device tab for one device, as it did, and for several the Metric tab
narrowed to them (`devices`), on the metric most of them report (`chartAddress()`, `defaultCellMetric()`), at the
window the box or the time control holds; with none in common, the picker narrowed to their metrics.

### History's Area tab

**History's Area tab compares one metric across the cells of an area**
(`tabs/HistoryArea.jsx`, `/history/area/<id>?metric=&agg=mean|total`): the Cell tab one level up, a chart
for each cell where the Cell tab has one for each machine. `__tests__/historyMetricArea.test.js` holds the
arithmetic and `historyAreaPage.test.jsx` the page.

- **The area** is picked from a table at `/history/area` (`AreaPicker`: its cells and machines, searchable
  and sortable), by the toolbar's area name, or from the Areas drawer's **View History** (`areaHistoryUrl()`,
  worded and drawn as the Cells and Devices drawers'; drift check 326 holds the four alike). Its cells are the
  cells in it in service (`historyAreas()`), archived ones left out. A device that is Area-Wide in it belongs
  to no cell, so is in no chart, and the status line says how many.
- **Each cell's chart is its mean or its total of the metric in every bucket**, which one control picks for
  the tab (`SegmentedControl`, `agg` in the address, the mean by default). One `telemetry_carried_by_group()`
  call (`0276`, `api.readCarriedByGroup()`) returns both for every cell, so the control draws the other without
  a read.
  - **The mean** is of the machines of the cell that have a value in the bucket, carried or measured.
  - **A total is drawn only for a bucket in which every machine of the cell has a value**, since a partial
    sum reads as a real one (`groupSeries()`). Where it was withheld the chart has no point, its head says so in
    words ("total of 3 machines, withheld from 10:05 to 10:35, where a machine had no value"
    (`withheldWords()`)), the pointer reads "total withheld, a machine had no value" there (`series.withheld`)
    and a cell with none at all says it has no total. A machine counts toward its cell when it reports the metric
    (`deviceMetrics()`): one that does not is left out of the cell's figure, and the cell's count says how many
    there are.
- **The browser does not fold.** A telemetry_carried() read is held to the row cap with every machine a series,
  which would draw an area of 20 machines at 1-hour buckets for a Day and a Week and 1-day buckets for a Month.
  The function is held to the cells times buckets it returns and the machines times buckets it reads
  (`pickGroupResolution()`, `HISTORY_GROUP_READ_ROWS`, 50,000, mirror check 88), so it is 5 minutes, 1 hour and
  1 hour. `supabase/README.md`, *History folds one metric across the devices of each group (0276)*, has the
  numbers. A window too long for it even at a day says so, and reads nothing.
- **Each chart is a cell**: its title links to that cell on the Cell tab at the same window and metric
  (`SmallMultiples`' `to` and `linkTitle`), with its machine count after it. A cell whose machines report
  nothing of the metric says so in words. The charts share one value scale, said in words ("One scale for every
  cell"), the time axis, the pointer and the zoom band. A chart's alert shading is the periods an alert on any
  machine of the cell was firing, one `alert_occurrences()` read for every machine.
- **The heatmap has a row for each cell** (`HourHeatmap`, its `noun` "Cell"): the cell's mean at each hour of
  the day across the window's days, in the browser's time zone. `telemetry_hour_of_day()` is read for every
  machine, as the Cell tab reads it, and each cell's hour is the mean of its machines' that have a value
  (`cellHourGrid()`, the hour's `machines` said in its words: "the mean of 7 days, across 5 machines"). It stays the
  mean when the total is chosen. Its window is limited as the Cell tab's is, by `hourOfDayPlan()`, for the area's
  machines.
- **A text or flag metric** has no mean or total: the tab says a mean or a total needs a number, offers each
  cell's own tab, and reads nothing.
- **The address** is `/history/area/<id>` with the window's keys, `metric` and, for the total, `agg=total`
  (`areaAddress()`); `/history/area` is the picker.

### History's Export

Export downloads the readings a view shows, as a CSV, from five places. One dialog
(`modals/TelemetryExportModal.jsx`) and one database call (`export_telemetry()`, `0279`;
[supabase/README.md](../supabase/README.md#an-export-of-readings-is-checked-bounded-and-recorded-0279))
serve them all, so there is one set of rules.

- **The Device tab:** this device, the metrics chosen and the window. **Overview:** the devices
  picked and every metric they report, over the box's window from the popover's **Export CSV**, or
  over the time control's window from the toolbar's, which is on for any devices ticked: the box is a
  shortcut, never the only way. **The Cell tab:** the machines that report the metric, the metric
  and the window. **The Area tab:** the machines behind the charts, every machine of the area's cells
  that reports the metric, and the metric and the window. A cell's chart is a mean or a total of its
  machines, a fold and not a reading, so the file holds none of those, and the dialog says so
  (`areaExportNote()`, which also counts the Area-Wide devices, in no cell and so in no chart). A
  text or flag metric has no cell figure to draw, so the tab greys its Export and names the Cell tab.
  **The Metric tab:** every device the tab lists under its filters, all pages and not only the one
  shown (`allKeys`, not the page's `keys`), the metric and the window; where the tab pages, the
  dialog says the file holds them all (`metricExportNote()`). Each opens the dialog with `devices`
  (`[{ id, name }]`, the Sparkplug ids readings are keyed by), `metricNames`, the window as ISO bounds
  fixed as it opens, and `windowWords`. The Area and Metric tabs add `scope`, their subject in words
  for the dialog's first line ("Boardroom · 14 machines in 3 cells · Spindle/LOAD · Last 24 hours",
  `areaExportScope()`, `metricExportScope()`), and `note`. Every entry point sits in the toolbar's
  `filter-bar-actions`, after Clear filters and before Refresh, and holds the role gate (mirror
  check 97).
- **The dialog picks the resolution, and raw is the default.** A bucket average is never
  substituted silently: the dialog labels each resolution with its horizon (`telemetry_horizons`),
  warns, with the finest that covers it, when the window starts before the one chosen, and the
  file's first line names the resolution (`provenanceRow()`). The call takes `raw` or one rollup and
  the database reads that one alone.
- **Only an Administrator or a Shopfloor Manager exports** (`TELEMETRY_EXPORT_ROLES`,
  `mayExportReadings()`, held to `export_telemetry()` by mirror check 90). Anyone else sees the
  button greyed, with "Requires Administrator or Shopfloor Manager" (`EXPORT_DENIED_TITLE`), and the
  charts stay. The Operator holds `telemetry:read` and so reads whatever a chart reads: this
  bounds the export, not access to the readings. The role comes from `userRole`, which `HistoryTab`
  passes to each tab; the old gate on `telemetry:read` is gone. The Overview's popover buttons
  keep their Tab stop (`aria-disabled`), as Chart does, so the reason reaches a keyboard.
- **The longest window is a setting, 14 days** (`history.export_max_days`, History on Settings),
  read with `useSetting()` and held to the database's reading by `exportMaxDays()` (mirror check 91).
  Each entry point says so **before** the dialog: the button is greyed with `exportWindowProblem()`
  as its tooltip, the database's own sentence ("An export can cover at most 14 days, set on
  Settings › History. This window is 20 days."), and Overview's box adds "over the 14-day export
  limit" to its words as it is drawn, for a role that may export. The dialog says it again as its
  `problem` and holds its confirm. It passes `touched` from the start: the person cannot change the
  window here, so there is nothing to edit first. A window of exactly the limit is allowed.
  More than 1,000 devices or 500 metrics, which the database refuses too, is said the same way
  (`exportSizeProblem()`).
- **One call, `api.exportTelemetry()`, returns the rows.** The database refuses, bounds, reads and
  records, so the dialog pages nothing: it writes one CSV of `time, device, metric, value, unit`, a
  row to a reading, the device by the name the dashboard shows. The file's comment rows come first:
  the resolution, then where it stops short (`noticeRows()`: raw begins later than the window, or
  the rows end at the 50,000-row cap, `TELEMETRY_EXPORT_MAX_ROWS`, mirror check 92). A refusal the
  database makes anyway is shown in the dialog's error slot as it came, and the dialog stays open.
- **The toast links to the Audit Trail row** (`auditEventUrl(audit_id)`, `/audit-trail?event=…`),
  and is a warning when the file stops at the cap. An export with no rows writes no file, no row and
  no toast, and says why in the dialog. The row is in the **Readings** lane (`READINGS`, `telemetry`),
  its action **Readings exported** (`TELEMETRY_EXPORTED`), a Read. The drawer names its devices and
  shows its window in local time, as a service-logs read's is.
- **Settings gains a History tab** (`SETTINGS_TABS`), with the one setting.
- `telemetryExport.test.js`, `telemetryExportModal.test.jsx`, `historyPage.test.jsx`,
  `historyOverview.test.jsx`, `historyCellPage.test.jsx`, `historyExportAreaMetric.test.jsx` and
  `auditTrailReadingsExported.test.jsx` hold the gate, the words over the limit, the five entry points,
  the toast's link, raw by default and the CSV's columns.

### History's derived metrics

A derived metric ([#324](https://github.com/Harri-Llewelyn/Aber/issues/324)) is a catalogue row with a
definition, computed where it is read. History offers it, draws it and tags it; the Devices drawer shows
its current value; Export leaves it out. The database's rules are in
[supabase/README.md](../supabase/README.md#history-draws-a-derived-metric-from-the-minutes-0282).

- **A device reports a derived metric when it reports all its inputs.** `deviceMetrics(device, schemas,
  catalog)` adds each such metric to what a device declared and its schemas model, so the Device tab's
  charts and Metrics filter, the Cell and Area tabs' metric lists, and the Metric tab's picker and its
  devices all follow one rule (`derivedReportedBy()`). Without the catalog it lists measured metrics
  only, as it always did, which is what Overview and Export read.
- **A read is split by the catalogue** (`splitDerived()`): a measured name goes to
  `api.readCarriedTelemetry()`, a derived one to `api.readDerivedSeries()`, which returns the same
  columns, so `chartSeries()` draws both. A derived series draws its value as the line and has no band
  of its own: a rate and a share have the one value, and a sum's band is its lowest to highest minute.
- **A window can be too long for a derived metric.** It is read from the minutes at every bucket width,
  so what it costs is the window and the devices, not the bucket: the database refuses more than
  `DERIVED_MAX_MINUTES` minutes of input (mirror check 95). `derivedReadProblem()` says so before the
  read, in the chart (Device tab) or as the tab's problem (Cell, Metric and Area), and the measured
  charts are unaffected. The row cap is the page's own (`DERIVED_MAX_ROWS`, the same 5,000).
- **The Area tab folds in the browser.** It asks `derived_series()` for every machine at the finest
  resolution where machines times buckets fit one read (`pickGroupResolution()` with
  `readRows: DERIVED_MAX_ROWS`), then `foldByGroup()` makes the rows `telemetry_carried_by_group()`
  makes, so `groupSeries()` draws both and a cell's total is withheld wherever a machine has no value.
  A measured metric folds in the database and gets a finer bucket for the same area.
- **A time in state is shown as a percentage, and is a fraction as data.** Its unit in a chart, a
  picker and a drawer is `SHARE_UNIT` (`unitOf()` gives it, from the definition), which `readingWords()`
  says with `percentWords()`: one decimal at most and a trailing zero dropped, "42%" and "42.5%". So a
  chart's value axis ticks, its hover and latest readings, its summary, the Area tab's cell means and
  the Devices drawer's value all say it, and the chart is titled "(% of the time)". The data, the API,
  an alert's `values` and a threshold in YAML are the fraction (`below: 0.9` is 90%); the Automations
  editor says so in the metric's completion and hover (`SHARE_FRACTION_NOTE`), and the derived drawer's
  Units says the percentage. An alert says it in the database's own words, `automation_value_words()`.
- **The tag is one component, `common/DerivedTag.jsx`**, the Derived tab's own badge. It is on a chart's
  title (`TimeSeriesChart`'s `derived`), beside the name in each metric list and picker
  (`FilterChecklist`'s option `tag`), in the Cell, Metric and Area toolbars, in a line above their
  charts (`SmallMultiples`'s `derived`) and in the Devices drawer. The word is the tag, never a colour.
- **The hour-of-day grids say they do not apply.** They read measured readings; a derived metric is
  computed over a stretch of time and has no mean at an hour.
- **Export leaves a derived metric out, by one function.** `exportableMetrics(names, catalog)` returns
  the measured names for `export_telemetry()` and the derived ones as `left`, said with
  `DERIVED_EXPORT_NOTE` in the button's tooltip and in the dialog (`TelemetryExportModal`'s `left`).
  The Device and Cell tabs call it; any other place that offers Export passes its names through it.
- **The Devices drawer lists a device's derived metrics** (`common/DeviceDerivedValues.jsx`): the
  current value of each, with its unit, its tag and its window in words (`currentWords()`), from one
  `api.readDerivedCurrent()` when the drawer opens on the device. A device with no value says so, a
  failed read says that, and a device none apply to has no line. The windows are `derivedWindowMinutes()`,
  held to `derived_window_minutes()` by mirror check 94.
- **The derived drawer's Applies To** (`appliesToValue()`) names the devices in service that report all
  the inputs, by the Metric tab's own function (`metricDevices()`): the first two and how many more past
  three, or "No device yet: none reports …".
- `derivedMetricReads.test.js`, `historyDerivedMetric.test.jsx`, `devicesDerivedValues.test.jsx` and
  `derivedMetrics.test.jsx` hold the rule, the reads, the tag, the fold, the Export rule, the drawer's
  line and Applies To.

### History's Alerts tab

**History's Alerts tab lists the alert occurrences that fired over the window** (`tabs/HistoryAlerts.jsx`,
`/history/alerts`), from every writer, as the viewer may read them. Its arithmetic is
`utils/alertHistory.js`, and `__tests__/alertHistory.test.js` and `historyAlerts.test.jsx` hold it.

- **The read** is `api.readAlertOccurrences()`, the RPC `alert_occurrences()` (`0243`): the
  occurrences that overlap the window, not only those that started in it, newest first, at most
  `ALERT_HISTORY_LIMIT` (1,000). It asks for one more, and the status line says when more fired.
  Each row is `{ occurrence, ended_at, replaced }`, which `occurrenceRow()` flattens: the whole
  `platform_alerts` row, when it ended, and whether a later occurrence of the same alert replaced
  it. `firing` is a firing occurrence nothing replaced. `overlapsWindow()` states the overlap rule
  in the browser, for the tests and the shading.
- **The window** is the page's: the same `TimeWindowControl`, ranges, spans, zoom and fallback as
  the Device tab, read by `HistoryTab` and passed in. The refresh timer is the page's too.
- **The toolbar**: the search first (the alert's name, summary, subject, acknowledger and note, in
  the browser), the window, then **Asset**, a `FilterDropdown` of every device and gateway by
  name, valued by Sparkplug id (`assetOptions()`, `?asset=`), which goes into the read. Clear
  filters resets the window and the assets. Area and cell filters are not built.
- **The address** is `alertsAddress(win, { assets })`: `/history/alerts` with the window's keys and
  `asset`, and `search` and `sort` as the toolbar and the table write them.
- **The columns**, each sortable (`ALERT_SORT`) and newest first until one is chosen: Alert (name
  and summary, `AlertCell`), Severity (a badge with its word), Subject (`alertSubject()`: a device
  or gateway linked through `onSelectDevice` and `onSelectGateway`, as the alert counter's row is;
  Platform-wide or Machine identity in words, linked where `alertPage()` names a page), Started,
  Ended (`EndedCell`: Firing, or "(fired again)" with why for a replaced one), Duration
  (`lengthText()`, "so far" while firing) and Acknowledged (who, the reason, when and the note). A
  mark about the occurrence itself goes in `AlertCell`, after the name. `SuppressedMark` is one:
  the alert counter's crossed bell and "Suppressed", where the row's `suppression_window_id`
  (`0240`) names the window that first covered it. That stamp says neither whether a window covers
  it now nor until when, so the mark has no "until".
- **The acknowledger is named by the email their token carried** (`acknowledgerName()`), here and
  in the alert counter. `display_names_for()` answers only for the people a caller can already
  see, so a name would show to some readers and not others.
- **The empty states** say which: nothing fired, nothing on the assets chosen, nothing matches the
  search, or, for a role that is not an Administrator, nothing the viewer may see, since a machine
  identity's alerts reach an Administrator alone. `retentionWords()` adds that alerts are kept for
  `alerts.retention_days` (`useSetting`, falling back to `ALERT_RETENTION_DAYS`, 90) when the window
  starts before that.

**The Device tab shades the periods an alert on the device was firing** (`hooks/useAlertBands.js`,
`common/alertBands.js`). With each read the charts make, the hook reads the device's alerts over
the same window and builds `alertBands()`: each occurrence clipped to the window, a still-firing
one running to the read's moment, where the lines stop. `alertBandsPlugin()` passes them to every
number and flag chart through `plugins`.

- **Inside the plot area only**, from `bbox`, so a band lines up with the text strips' gutters.
  Under the series, a translucent fill of `--danger`. Over them, a solid `--danger` edge where the
  occurrence's own start or end falls inside the window, and its name in `--danger-text` inside the
  band's foot where it fits. Several alerts each draw their own, so an overlap is deeper.
- **Never colour alone**: the edges and names, a readout and a key. While the pointer is on a
  chart (not on the charts its cursor is synced to), `.chart-alert-readout` at the plot's foot
  names each alert firing at that moment (`bandText()`). The row above the charts keys the shading
  in words with a link to the Alerts tab for the device and window (`AlertKey`).
- **A failed read shades nothing.** The charts go on, and the read's thunk lets a stub without the
  method read as no alerts. A state strip is not drawn by uPlot and is not shaded.

---

## Automations and its editor

**The Automations page writes each automation as YAML and keeps it as rows**
(`tabs/AutomationsTab.jsx`, `tabs/AutomationDetail.jsx`, `/automations`). The rows are the record, so
the YAML is never stored: the page renders it from `automations_document()` and parses it back into
one `apply_automations()` call (`0255`-`0257`). The format is `docs/automations.md`'s, and the
page's help is `help/pages/automations.md`.

- **The routes** ([Routing](#routing)): `/automations` is the list, `/automations/<id>` one automation
  in the editor, `/automations/new` the editor on an example, and `/automations?entity=<uuid>` the list of
  those that apply to one device. An automation whose id is `new` opens with `?open=1`, which
  `automationUrl()` writes. `/automations?trigger=<trigger id>` is an alert's link: the fingerprint
  names a trigger and not an automation, so the page finds the owner (`api.automationOfTrigger()`)
  and replaces the address with its page.
- **Who may write.** The page is ungated, since every role reads the tables. An Administrator or a
  Shopfloor Manager writes (`AUTOMATION_WRITE_ROLES`, mirror check 85 holds it to the three
  writers), and for anyone else each write control is greyed with that sentence in its tooltip, the
  editor is read-only, and the list's switch is disabled. The page waits for the role (`App.jsx`),
  as Settings does.
- **The list** is `api.readAutomations()`: the document (alias, triggers, devices' names), each
  automation's row and trigger ids, the alerts firing now (`platform_alerts_active`) and the newest
  `AUTOMATION_ALERT_LIMIT` occurrences, from which each automation's last firing comes. A trigger's
  alerts are found by the fingerprint's trigger id (`automation_alert_fingerprint()`, mirror check
  87). Search is `search`, in the browser; the sort is `sort`. A row's switch calls
  `set_automation_enabled()` and ends with a toast that links to the automation. The toolbar is
  search, then **Upload**, **Export** and **New Automation** last. **Export** writes the rows ticked,
  or every automation when none is.
- **One automation** is the YAML in the editor, its recent firings with each alert's labels and
  values, and a link to its history in the Audit Trail by its row's uuid. **Save** opens
  `ApplyAutomationsModal`, which parses the text, calls `apply_automations(doc, true)` and lists each
  automation as new, changed, unchanged or refused with every reason and its line. Its confirm repeats
  the act and the count (**Save 1 Automation**, **Apply 3 Automations**) and applies the same document with
  `false`, all or nothing. An upload is the same dialog on a file's text, and never deletes. The
  dialog toasts the success itself, because it makes the call.
- **The text is rendered, never kept.** `renderAutomationsYaml()` puts each automation's keys in
  the order a file reads best (the database's jsonb has its own), leaves an empty `description` out, and
  writes a comment beside each device id from the document's `devices`. The page says in one line
  that comments typed here are not kept. A refusal's JSON path (`$[0].triggers[1].above`) is read by
  `pathSegments()` and located in the text by `locatePath()`, through `yaml`'s node positions.
- **A file is parsed in the browser** by `yaml` in its YAML 1.2 core schema, so `on` and `yes` stay text
  and the database says `enabled` is true or false. A syntax error is shown with its line and the
  database is not asked; an alias bomb is refused; a file over 2 MiB is refused before it is read.

### The editor's help comes from the JSON Schema

**Completion, hover and the marks are pure functions of the text, the cursor and what the site holds**
(`utils/automationEditorHelp.js`), laid over CodeMirror by `common/AutomationEditor.jsx`. They read the
vocabulary from the schema file the dashboard serves, imported from `public/json-schema/`, so the
editor and the served file cannot differ. There is no third package: `codemirror-json-schema` was
declined, since 1.8's vocabulary is one trigger and one action, and check 322 refuses any
dependency but CodeMirror, Lezer and `yaml`.

- **Context is read from the lines' indentation**, not from a parse: text being typed is not YAML.
  It reads the block YAML the page renders; flow style is left to the database.
- **Completion** offers an automation's, a trigger's and an action's keys (those not yet written,
  required first, one of `above` and `below`), a new trigger or action under `triggers:` and `actions:`,
  the type and severity values, `true` and `false`, common holds, a device by its name (completing to its
  id and the comment the page writes beside one), and a metric from the catalogue, measured ones only,
  those the trigger's device models first.
- **Hover** says what a key is, from the schema; a device id's name and place; a metric's unit and the
  valid range its devices' schemas allow (`validRanges()`, the widest across a list); and a threshold's unit.
- **A threshold outside the valid range is a warning**, never an error: it can never fire, or is
  always breached. The database's refusals and syntax errors are errors, on the line each names.
  Marks are a wavy line, a gutter icon and a message, never colour alone.
- **`conditions:` offers nothing**: this release has no condition types.

### The Automations editor draws in a shadow root

**CodeMirror writes `<style>` elements into the document it is mounted in, and the dashboard's
Content-Security-Policy refuses them** ([The Content-Security-Policy names what a page may
load](#the-content-security-policy-names-what-a-page-may-load)): `style-src` admits only the 3D viewer's
hash. So `AutomationEditor` attaches an open shadow root and passes it to `EditorView` as `root`, where
style-mod adopts a stylesheet instead, as the 3D viewer's components do. `style-src` stays as it is, and a
proxy with a policy of its own needs no change. Check 324 holds the policy, the shadow root and this
paragraph together.

- **The theme is inherited.** Custom properties pass into a shadow root, so the editor's colours are
  `var(--…)` tokens and follow the light and dark themes with no rule of its own. Its syntax colours are
  the accent, primary text, warning and muted text tokens, which hold their contrast on the card in both.
- **A key typed in it does not reach the page.** The document sees a key from inside a shadow root as the
  host's, which is no text field, so `?`, `/`, `[` and `]` would open the shortcuts, focus the search box
  and change tab. The host stops those four (`SINGLE_KEY_SHORTCUTS`), and no other key.
- **It is not a keyboard trap.** `Tab` is not bound, so it moves on; indenting is by `Enter`'s
  auto-indent and spaces. `Ctrl Space` asks for completion.
- **Loaded with the page.** The editor, `yaml` and the schema are in the Automations chunk, not
  the main bundle. Neither package's files carry a notice the build keeps, so `AutomationEditor.jsx` and
  `utils/automationYaml.js` open with theirs as `/*!` comments (`NOTICE.md`, check 322,
  `legalComments.test.js`).
- **jsdom lays nothing out**, so a test of the editor stubs the two measurements CodeMirror asks a `Range`
  for (`automationEditor.test.jsx`), and finds the view with `EditorView.findFromDOM()` in the shadow root.

### An alert opens its automation, a device its automations

- **An alert's link** is `alertPage()`'s: a `condition:` alert opens `/automations?trigger=<id>`, from the
  counter (a row with a page of its own goes there, not to its device), the toast that announces it, and
  the messages about it (`alertSubjectUrl()`). History's Alerts tab and the device drawer's alert banner
  are unchanged: the first is about a device, and the second still links the rule where Grafana holds it.
- **The Devices drawer's View in Automations** shows how many automations apply
  (`api.automationsForEntity()`, each counted once) and opens `/automations?entity=<id>`. A failed read
  leaves it without a number. The list names the entity in a chip that clears the filter, and says why
  each applies, **Named** or **Site-wide**.

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
- **Scroll.** Every page scrolls inside its card, Access Control, System and Approvals included.
- **Counts.** None on card headings, section headings or tabs. A count stays where it states what is
  loaded ("30 of 55" beside Show more), what a filter value or toggle holds (Active 4 beside its
  checkbox, "Needs attention (3)"), what an export will write, or how much work is waiting (a
  Quarantine or Awaiting tab, the sidebar).
- **Queues are tabs.** Devices' quarantine queue is its Quarantine tab, not a card above the roster;
  a tab with work waiting takes `attention`.
- **Clear filters (N).** N counts every control that is off its default, the lifecycle filter
  included, and a list filter once however many values it holds. The button (`common/ClearFilters.jsx`) sits at the right end of the toolbar, first in
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
- **Callouts in a dialog.** A callout in a dialog's body leaves the gap it has above itself (12px)
  before a table, a list or a form, so a banner never sits flush on what it qualifies. One rule in
  `App.css` does it for every dialog. A replay lane that is offline gets an info callout, not the
  DDEATH warning: a lane is offline between playbacks by design (the Device Configuration
  Parameters dialog).
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
Access Control, System and Approvals scrolling the page; the Devices queue as a card above the
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
  the drawer's width, so nothing on a help page can widen the drawer. A code token in a table cell
  breaks only where its text allows, such as at a space or after a hyphen, never inside a word
  (`overflow-wrap: normal`). With `anywhere` the tutorial's topic table fitted the docked panel by
  showing `NBIRTH` as `NBIR` above `TH`. With `normal` alone a topic had nowhere to break, so the
  table scrolled and its *What it is for* column started off-screen. So HelpMarkdown also puts a
  `<wbr>` after each `/` that ends a segment of a code span in a cell: a topic wraps between its
  parts, and the table fits the docked panel again. A `<wbr>` adds no character, so a copy is the
  text as written, and `//` is never split.
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
one exists (a gateway's Launch UI); otherwise Restore when archived; otherwise Edit Details
(Propose a Change in propose mode).

---

## Toasts and the notification history

`showToast(msg, type)` (`hooks/useToast.js`) is the one call every page makes, with `type` one of
`success` (the default), `info`, `warning` or `error`. Each call puts a toast in the bottom-right
corner and records the same message in the history behind the bell in the top bar, unless it
passes `{ record: false }`, as an alert's toast does.

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
- **Alerts are toasts only.** `usePlatformAlerts` passes `{ group: 'alert', record: false }`
  for a firing and a resolved alert. The toast shows, with the Alert group's icon and colour and a
  link where `alertToastUrl()` says, but nothing is recorded, so the bell's badge never counts what the alert
  counter already counts. `readStoredHistory` drops any Alert entry a tab stored before this. The
  counter shows what is firing now. History's Alerts tab, linked from the counter's footer
  (**Alert history**), is the record of what fired and cleared, including an alert that came and
  went while nobody was looking, from every writer ([History's Alerts tab](#historys-alerts-tab)).
- **A firing alert toasts its name only.** The summary can be several sentences with a SQL
  statement, which stacked as tall blocks, kept a warning up longer and was read aloud in full by
  the `role="alert"` region. The summary is in the alert counter's list.
- **The counter counts what nobody has acknowledged** (`common/AlertPill.jsx`, 0231). The pill's
  number, the tab title and the favicon count the firing alerts with no acknowledgement
  (`unacknowledgedAlerts()` in `utils/alertAcknowledgement.js`, which `App` passes to the title and
  the favicon). The list keeps an acknowledged alert, after the others, with a hollow dot, a tick and
  who acknowledged it, when, the reason and the note. **Acknowledge** opens `AcknowledgeAlertModal`:
  a reason from the closed set, unchosen to start, and a note Other requires. **Withdraw** asks
  first, and is offered to the acknowledger, a Shopfloor Manager and an Administrator. Both write an
  Audit Trail row, so each ends with a success toast that is recorded and links to what the alert is
  about (`alertSubjectUrl()`). The dialogs are drawn inside the counter's wrapper, so a click in one
  is not a click outside the list. Another person's acknowledgement arrives as an `UPDATE` on
  `platform_alerts`, which the counter's subscription already carries. The pages draw the *Alert
  acknowledged* state from `alertIndex()` (`utils/deviceAlerts.js`), where an unacknowledged alert
  outranks any acknowledged one. The acknowledger is named by the email their token carried
  (`acknowledgerName()`, `utils/alertHistory.js`), the same on every surface: no display name is
  readable by every role, since `display_names_for()` answers only the people a caller can already
  see.
- **A suppressed alert is not counted and colours nothing** (0240). `platform_alerts_active` says
  whether a suppression window covers each alert as it is read, with the window's reason and end.
  `countedAlerts()` (`utils/alertSuppression.js`) leaves acknowledged and suppressed alerts out of
  the pill's number, the tab title and the favicon, and `alertIndex()` leaves a suppressed one out,
  so no pin, chip or row colours it. The list keeps it, after the acknowledged ones, with a muted
  ring struck through, a crossed bell, "Suppressed until" its end, and the reason under it. **A
  window's start and end write nothing**, so `usePlatformAlerts` reads again a second after the
  nearest end of a window that covers an alert, or start of one still to come (`nextSuppressionChange()`),
  and at least two seconds after a read, so a clock ahead of the server's asks again until the
  answer changes. An alert whose window ends while it fires toasts as if it had just fired; a
  suppressed alert toasts neither firing nor resolved. A drawer that schedules, changes or ends a
  window calls `requestAlertsRefresh()`, so this tab reads at once; another tab learns of an early
  end at its next reconcile. The windows table is not in the realtime publication.
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
  alert goes to its rule (`grafanaAlertUrl`), and an automation's, which has none, to its device. A
  device new to the Quarantine queue goes to
  `tabUrl('devices', 'quarantine')`, and an AAS export's warning about metrics with no semantic id
  to `unmappedMetricsUrl()`, which `App` passes only to a reader who has the Metrics page. An
  arrival at an archived device or gateway turns the list's lifecycle filter to All, as Cells and
  Areas already did, so the record is in the list as well as the drawer. What links nowhere: a
  record that is gone (a permanent delete, a discarded draft, a rejected quarantined device, a
  deleted capture), a file (downloads and exports), the clipboard, the person's own password, and
  a failure of what was just tried, since the person is still on the form; a failure whose fix is
  elsewhere still links there. `__tests__/notificationLinks.test.js` reads every `showToast` call:
  one that is not an error passes `to`, or is in its `NO_LINK` list with the reason.
- **A refusal for want of MFA links to Profile › MFA, from any page.** While Settings requires MFA,
  the database, the edge functions and the gateway's consent step refuse a manager or an
  Administrator whose session gave no code with one sentence, `MFA_REQUIRED_MESSAGE` in
  `utils/secondFactor.js` (mirror check 60). `showToast` recognises it (`destinationOf` in
  `hooks/useToast.js`): an error or warning carrying it, given no `to`, links to `MFA_TAB_URL`. So
  no page recognises it itself. A form's own inline error shows the sentence as text.
- **Every action that writes an Audit Trail row ends with a success toast** (#1316), so the bell
  lists it as well as the trail. Save Turn, Show Credential, a capture's Download, Prepare replay
  lanes and your own display name's Save each toast, as every other audited action does. It is one
  toast for each action, however many rows it writes: Add Person writes two and toasts once, and
  publishing a schema toasts once for all its devices. The type is `success`; one chosen at run
  time may be `info` when nothing changed, as Cancel's is for a backup the service already took.
  `__tests__/auditedActionsToast.test.js` reads what writes the trail from the migrations: the
  functions that insert into `audit_trail`, the tables whose triggers do, and the functions and
  edge functions that write those. It finds each `api.js` method and route that reaches one, and
  requires each call of it under `src/` to reach a success `showToast` after it, in its own
  function and outside a `catch`. `TOASTED_BY` names a call whose toast is made by the code it
  hands over to, such as the Profile row a hook returns to, and `NO_TOAST` an exception with its
  reason: OAuth consent's Allow, which leaves the dashboard. Rows nobody writes from the dashboard
  (the backup service, the cron, ingestion, a machine's edge function) have nobody to toast to.
- **It is not the alert pill.** The pill says what is firing now, and its count is a reason to act;
  it drops when the alert resolves or a person acknowledges it. The history says what the dashboard
  said, and its count drops when the list is opened. One badge cannot follow both: if opening the
  list cleared it, a critical alert still firing would vanish from the bar, and if it did not,
  routine messages would add to the alarm's number. So each counts its own, and an alert is counted
  once, by the pill.

### A firing alert can raise a desktop notification

For a person who turned it on (Profile › Notifications), a dashboard tab raises a browser
notification as an alert starts firing. It is not a toast and not a message: nothing is queued and
nothing is recorded, and with no dashboard tab open nothing arrives. `hooks/useDesktopAlerts.js`
returns `sync(rows)`, which `usePlatformAlerts` calls with every read of `platform_alerts_active`,
so a notification has the visibility the alert counter has and follows the same set.

- **One notification per occurrence, when it starts firing.** An occurrence is a row, by `id`: new
  to the tab since its last read, or out of a suppression window while still firing, as the toast
  decides it. The first read, a refresh, a Grafana repeat (the webhook upserts the same row) and a
  dismissed notification raise nothing. Turning the setting on raises nothing for what is already
  firing. `tag` is the id, so a second open tab's notification replaces this one's instead of
  stacking; the shared tag is the specification's, and has not been tried in every browser.
- **It closes with the alert.** When the occurrence resolves, is acknowledged or becomes suppressed,
  and when the person turns the setting off or the dashboard closes. An acknowledged or suppressed
  alert raises nothing, so a withdrawn acknowledgement raises nothing either.
- **What it says.** The title is the alert's name. The body is the severity in words, then the
  subject and where it is: *Critical on device Press 4, in Machine Shop › Cell 3.* The name and
  place are read for that one alert (`api.readAlertSubject`), for at most two seconds, and the
  Sparkplug id stands in when they cannot be. No value from the summary: those are in the counter.
  The icon is `/favicon.svg`; a browser that draws no SVG icon shows its own.
- **A click opens the alert as the counter's row does.** It focuses this window, then calls
  `showDevice` or `showGateway` with the Sparkplug id, at the asset's own address; the page
  `alertPage()` names for a machine identity or a capture job; or the rule in Grafana, in a new tab
  (`alertOpener` in `utils/desktopNotifications.js`).
- **The browser asks once per session.** A person with it on, in a browser that has not been asked,
  is asked at the first click or key press, the gesture Firefox and Safari require; the tab keeps an
  Allow Notifications button for when they dismiss it. Nothing is asked where the browser cannot raise one.
  The tab remembers that it asked, with a constant in session storage and nothing of the person: who
  is signed in is held in memory only, so a reload keeps the answer, while signing out or another
  person's id clears it and the next person is asked. Nothing derived from the session (an id, an
  email, a token) is written to browser storage.

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
moves with it. The Filters panel, and the time window's in the same frame (`ToolbarPopover`),
is shifted to stay inside the window, so `ToolbarPopover` sets `--arrow-x`, the button's centre from
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
- **A badge is one line** (`.badge`, `white-space: nowrap`). Its pill radius rounds a badge that
  wraps into an oval. A long label widens its column instead, or is split into several badges that
  wrap between them: a devices column's summary is one badge per figure, a `TagList` entry with
  `parts`, which still counts once toward the list's limit (`badgeOneLine.test.js`).
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
  - **Every sortable header shows its arrow at rest**: the sorted column its up or down arrow, the
    others a double arrow in `--text-dim` that steps up to `--text-primary` on hover or focus. A
    touch screen has no hover, and the arrow is what tells a sortable header from a plain one, so
    no rule hides it (`sortableTables.test.js`) and it holds 3:1 on the header's ground
    (`themeContrast.test.js`). A `ColumnHeader` has no arrow.
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
